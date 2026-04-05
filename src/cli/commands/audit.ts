// KCode - Audit Command
//
// `kcode audit <path>` — runs the deterministic audit pipeline against
// a project, produces AUDIT_REPORT.md with confirmed findings only.
//
// Works with local (llama.cpp/Ollama) or cloud (Anthropic/OpenAI) models.
// The model is used ONLY for per-candidate verification, not for discovery.

import { writeFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { Command } from "commander";
import { runAudit } from "../../core/audit-engine/audit-engine";
import { generateMarkdownReport } from "../../core/audit-engine/report-generator";
import { loadSettings } from "../../core/config";

const ICONS = {
  phase: "◆",
  confirmed: "\x1b[31m●\x1b[0m",
  false_positive: "\x1b[90m○\x1b[0m",
  needs_context: "\x1b[33m◐\x1b[0m",
};

/**
 * Call the configured LLM (local or cloud) with a single prompt and
 * return its response text. Minimal interface — no tools, no streaming.
 */
async function makeLlmCallback(opts: {
  model?: string;
  apiBase?: string;
  apiKey?: string;
  maxTokens?: number;
}): Promise<(prompt: string) => Promise<string>> {
  const model = opts.model ?? "claude-opus-4-6";
  const apiBase = opts.apiBase ?? "https://api.anthropic.com/v1";
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.KCODE_API_KEY ?? "";
  const maxTokens = opts.maxTokens ?? 1024;

  // Detect API style: Anthropic-native or OpenAI-compatible
  const isAnthropic = apiBase.includes("anthropic.com") || model.includes("claude");

  return async (prompt: string): Promise<string> => {
    if (isAnthropic) {
      const res = await fetch(`${apiBase.replace(/\/$/, "")}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
      const textBlocks = data.content.filter((b) => b.type === "text");
      return textBlocks.map((b) => b.text ?? "").join("");
    }
    // OpenAI-compatible (llama.cpp/Ollama/vLLM/OpenAI)
    const res = await fetch(`${apiBase.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
      }),
    });
    if (!res.ok) {
      throw new Error(`LLM API ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message.content ?? "";
  };
}

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
    .option("--max-files <n>", "Max files to scan (default 500)", "500")
    .option("--skip-verify", "Skip model verification (static-only output)", false)
    .option("--json", "Also write AUDIT_REPORT.json alongside the markdown", false)
    .action(async (path: string, opts: {
      output?: string;
      model?: string;
      apiBase?: string;
      apiKey?: string;
      maxFiles: string;
      skipVerify: boolean;
      json: boolean;
    }) => {
      const projectRoot = pathResolve(path);
      const outputPath = opts.output ?? pathResolve(projectRoot, "AUDIT_REPORT.md");
      const maxFiles = parseInt(opts.maxFiles, 10) || 500;

      console.log("");
      console.log(`${ICONS.phase} KCode Audit Engine`);
      console.log(`  Project:  ${projectRoot}`);
      console.log(`  Output:   ${outputPath}`);
      console.log("");

      // Resolve LLM config from settings (unless --skip-verify)
      let llmCallback: (prompt: string) => Promise<string>;
      if (opts.skipVerify) {
        console.log("  \x1b[33m--skip-verify: model verification disabled\x1b[0m");
        console.log("");
        llmCallback = async () => "VERDICT: CONFIRMED\nREASONING: static-only mode\n";
      } else {
        const settings = await loadSettings(projectRoot);
        llmCallback = await makeLlmCallback({
          model: opts.model ?? settings.model,
          apiBase: opts.apiBase ?? settings.apiBase,
          apiKey: opts.apiKey ?? settings.apiKey,
        });
      }

      // Run pipeline with progress output
      let lastPhase = "";
      let verifiedCount = 0;
      const result = await runAudit({
        projectRoot,
        llmCallback,
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
