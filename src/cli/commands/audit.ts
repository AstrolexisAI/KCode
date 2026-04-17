// KCode - Audit Command
//
// `kcode audit <path>` — runs the deterministic audit pipeline against
// a project, produces AUDIT_REPORT.md with confirmed findings only.
//
// Works with local (llama.cpp/Ollama) or cloud (Anthropic/OpenAI) models.
// The model is used ONLY for per-candidate verification, not for discovery.

import { existsSync, writeFileSync } from "node:fs";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import type { Command } from "commander";
import { runAudit } from "../../core/audit-engine/audit-engine";
import { makeAuditLlmCallback } from "../../core/audit-engine/llm-callback";
import { generateMarkdownReport } from "../../core/audit-engine/report-generator";
import { loadSettings } from "../../core/config";

const ICONS = {
  phase: "◆",
  confirmed: "\x1b[31m●\x1b[0m",
  false_positive: "\x1b[90m○\x1b[0m",
  needs_context: "\x1b[33m◐\x1b[0m",
};

export function registerAuditCommand(program: Command): void {
  program
    .command("audit <path>")
    .description(
      "Deterministic code audit. Scans project with bug pattern library, verifies each candidate with the model, produces AUDIT_REPORT.md.",
    )
    .option("-o, --output <file>", "Output report path (default: <path>/AUDIT_REPORT.md)")
    .option("-m, --model <name>", "Override model for verification")
    .option("--api-base <url>", "Override API base URL (for local models)")
    .option("--api-key <key>", "Override API key")
    .option(
      "--fallback-model <name>",
      "Cloud model to escalate to when primary is ambiguous (hybrid mode)",
    )
    .option("--fallback-api-base <url>", "API base for fallback model")
    .option("--fallback-api-key <key>", "API key for fallback model")
    .option("--max-files <n>", "Max files to scan (default 500)", "500")
    .option("--skip-verify", "Skip model verification (static-only output)", false)
    .option("--json", "Also write AUDIT_REPORT.json alongside the markdown", false)
    .option(
      "--sarif",
      "Also write AUDIT.sarif (SARIF v2.1.0, for GitHub Advanced Security / Azure DevOps / SonarQube)",
      false,
    )
    .action(async (path: string, opts: {
      output?: string;
      model?: string;
      apiBase?: string;
      apiKey?: string;
      fallbackModel?: string;
      fallbackApiBase?: string;
      fallbackApiKey?: string;
      maxFiles: string;
      skipVerify: boolean;
      json: boolean;
      sarif: boolean;
    }) => {
      const projectRoot = pathResolve(path);
      const outputPath = opts.output ?? pathResolve(projectRoot, "AUDIT_REPORT.md");
      const maxFiles = parseInt(opts.maxFiles, 10) || 500;

      console.log("");
      console.log(`${ICONS.phase} KCode Audit Engine`);
      console.log(`  Project:  ${projectRoot}`);
      console.log(`  Output:   ${outputPath}`);
      console.log("");

      // Auto-skip verification for machine-generated projects. The web engine
      // drops a .kcode-generated marker at the project root; when present we
      // know the tree is scaffolded from audited templates, so per-candidate
      // LLM verification is wasted time (it took 3h+ on local models for a
      // clean Next.js scaffold).
      if (!opts.skipVerify && existsSync(pathJoin(projectRoot, ".kcode-generated"))) {
        opts.skipVerify = true;
        console.log("  \x1b[33m.kcode-generated detected — auto-enabling --skip-verify\x1b[0m");
      }

      // Resolve LLM config from settings (unless --skip-verify)
      let llmCallback: (prompt: string) => Promise<string>;
      let fallbackCallback: ((prompt: string) => Promise<string>) | undefined;
      if (opts.skipVerify) {
        console.log("  \x1b[33m--skip-verify: model verification disabled\x1b[0m");
        console.log("");
        llmCallback = async () => "VERDICT: CONFIRMED\nREASONING: static-only mode\n";
      } else {
        const settings = await loadSettings(projectRoot);
        llmCallback = makeAuditLlmCallback({
          model: opts.model ?? settings.model ?? "claude-opus-4-6",
          apiBase: opts.apiBase ?? settings.apiBase ?? "https://api.anthropic.com/v1",
          apiKey: opts.apiKey ?? settings.apiKey,
        });
        if (opts.fallbackModel) {
          fallbackCallback = makeAuditLlmCallback({
            model: opts.fallbackModel,
            apiBase: opts.fallbackApiBase ?? "https://api.anthropic.com/v1",
            apiKey: opts.fallbackApiKey,
          });
          console.log(
            `  \x1b[36mHybrid mode: primary ${opts.model ?? settings.model}, fallback ${opts.fallbackModel}\x1b[0m`,
          );
          console.log("");
        }
      }

      // Run pipeline with progress output
      let lastPhase = "";
      let verifiedCount = 0;
      const result = await runAudit({
        projectRoot,
        llmCallback,
        fallbackCallback,
        maxFiles,
        skipVerification: opts.skipVerify,
        onPhase: (phase, detail) => {
          if (phase !== lastPhase) {
            console.log(`${ICONS.phase} ${phase}${detail ? `: ${detail}` : "..."}`);
            lastPhase = phase;
          }
        },
        onCandidate: (cand, ver, i, total) => {
          verifiedCount++;
          const icon =
            ver.verdict === "confirmed"
              ? ICONS.confirmed
              : ver.verdict === "false_positive"
                ? ICONS.false_positive
                : ICONS.needs_context;
          const rel = cand.file.replace(projectRoot + "/", "");
          process.stdout.write(
            `\r  ${icon} [${verifiedCount}/${total}] ${cand.pattern_id} — ${rel}:${cand.line}          \n`,
          );
        },
      });

      // Write markdown report
      const markdown = generateMarkdownReport(result);
      writeFileSync(outputPath, markdown);
      console.log("");
      console.log(`${ICONS.phase} Report written: ${outputPath}`);

      if (opts.json) {
        const jsonPath = outputPath.replace(/\.md$/, ".json");
        writeFileSync(jsonPath, JSON.stringify(result, null, 2));
        console.log(`${ICONS.phase} JSON data:     ${jsonPath}`);
      }

      if (opts.sarif) {
        const { buildSarif } = await import("../../core/audit-engine/sarif-exporter");
        const { version } = await import("../../../package.json");
        const sarifDoc = buildSarif(result, {
          toolVersion: String(version),
          projectRoot,
        });
        const sarifPath = outputPath.replace(/\.md$/, ".sarif");
        writeFileSync(sarifPath, JSON.stringify(sarifDoc, null, 2));
        console.log(`${ICONS.phase} SARIF report:  ${sarifPath}`);
      }

      console.log("");
      console.log(`  Files scanned:       ${result.files_scanned}`);
      console.log(`  Candidates found:    ${result.candidates_found}`);
      console.log(
        `  \x1b[31mConfirmed findings:  ${result.confirmed_findings}\x1b[0m`,
      );
      console.log(`  False positives:     ${result.false_positives}`);
      console.log(`  Duration:            ${(result.elapsed_ms / 1000).toFixed(1)}s`);
      console.log("");
    });
}
