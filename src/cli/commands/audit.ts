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

/**
 * Detect a sensible diff base for --ci mode. Tries upstream refs in
 * order; returns the first that resolves. The order is:
 *
 *   1. origin/HEAD — the symbolic ref the upstream itself points
 *      to as default. Catches projects that use non-conventional
 *      default branch names (devel, develop, dev, trunk, etc.).
 *      v2.10.353 follow-up: discovered while validating against
 *      NASA's fprime repo, whose default is `devel`.
 *   2. origin/main — modern convention
 *   3. origin/master — legacy convention
 *   4. main / master — local-only branches when no remote is set
 *   5. HEAD~1 — last-ditch fallback for repos with no remote
 *
 * Returns undefined when the repo has only one commit (diff would
 * be meaningless and we proceed full).
 *
 * Uses execFileSync per the v2.10.351 P0.4 hardening — ref text is
 * pure positional argv, no shell.
 */
async function detectDefaultDiffBase(projectRoot: string): Promise<string | undefined> {
  const { execFileSync } = await import("node:child_process");
  const probe = (ref: string): boolean => {
    try {
      execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
        cwd: projectRoot,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5_000,
      });
      return true;
    } catch {
      return false;
    }
  };
  for (const candidate of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    if (probe(candidate)) return candidate;
  }
  if (probe("HEAD~1")) return "HEAD~1";
  return undefined;
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
    .option(
      "--fallback-model <name>",
      "Cloud model to escalate to when primary is ambiguous (hybrid mode)",
    )
    .option("--fallback-api-base <url>", "API base for fallback model")
    .option("--fallback-api-key <key>", "API key for fallback model")
    .option("--max-files <n>", "Max files to scan (default: unlimited)", "0")
    .option("--skip-verify", "Skip model verification (static-only output)", false)
    .option(
      "--since <ref>",
      "Diff-based audit: only scan files changed since <ref> (e.g. main, HEAD~10, origin/main). " +
        "10x+ speedup on large repos and the right default for CI pre-merge gates.",
    )
    .option("--json", "Also write AUDIT_REPORT.json alongside the markdown", false)
    .option(
      "--sarif",
      "Also write AUDIT.sarif (SARIF v2.1.0, for GitHub Advanced Security / Azure DevOps / SonarQube)",
      false,
    )
    .option(
      "--ci",
      "CI gate mode: auto-detect diff base (origin/main → origin/master → HEAD~1), enable --json + --sarif + --skip-verify by default, " +
        "suppress per-candidate progress noise, and exit code 1 when actionable findings are present. " +
        "Override defaults with explicit flags: e.g. `--ci --model mark7` keeps verifier on. " +
        "v2.10.353 — designed for PR pre-merge gates.",
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
      since?: string;
      json: boolean;
      sarif: boolean;
      ci: boolean;
    }) => {
      const projectRoot = pathResolve(path);
      const outputPath = opts.output ?? pathResolve(projectRoot, "AUDIT_REPORT.md");
      // Default is unlimited (Number.MAX_SAFE_INTEGER). Users can cap
      // with --max-files N when they explicitly want truncation.
      const parsedMaxFiles = parseInt(opts.maxFiles, 10);
      const maxFiles =
        !Number.isFinite(parsedMaxFiles) || parsedMaxFiles <= 0
          ? Number.MAX_SAFE_INTEGER
          : parsedMaxFiles;

      // v2.10.353 — --ci sets opinionated defaults for PR-gate
      // pipelines. Each can still be overridden by an explicit flag
      // (commander already preserves user values that come AFTER the
      // option string). What --ci adds:
      //   1. Auto-detect a diff base when --since is omitted
      //   2. Default --skip-verify to true (CI usually has no model)
      //   3. Default --json + --sarif (so the CI can upload artifacts)
      //   4. Suppress per-candidate progress (noisy in CI logs)
      //   5. Exit code 1 when actionable findings remain
      if (opts.ci) {
        if (!opts.since) {
          opts.since = await detectDefaultDiffBase(projectRoot);
        }
        // Defaults — only apply when user didn't explicitly set them.
        // The flags are boolean so we can't distinguish "default" from
        // "explicit false"; but commander gives us false for both. We
        // default to true unconditionally — the user can opt back out
        // with `--no-ci` (or skip --ci entirely).
        if (!opts.skipVerify && !opts.model && !opts.apiBase) {
          opts.skipVerify = true;
        }
        opts.json = true;
        opts.sarif = true;
      }

      console.log("");
      console.log(`${ICONS.phase} KCode Audit Engine`);
      console.log(`  Project:  ${projectRoot}`);
      console.log(`  Output:   ${outputPath}`);
      if (opts.ci) {
        console.log(`  Mode:     CI gate (--since ${opts.since ?? "<none>"}, json+sarif, exit-on-finding)`);
      }
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
        // Pick a default provider based on which API key is actually
        // present in the environment. Prior to v2.10.130 this hardcoded
        // Anthropic; the branding-cleanup flip to OpenAI broke users
        // who had only `ANTHROPIC_API_KEY` set and ran `kcode audit`
        // with no flags. Now the provider follows the key.
        const hasOpenAi = !!(opts.apiKey ?? settings.apiKey ?? process.env.OPENAI_API_KEY);
        const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
        const defaultModel =
          hasOpenAi || !hasAnthropic ? "gpt-4o" : "claude-sonnet-4-6";
        const defaultBase =
          hasOpenAi || !hasAnthropic
            ? "https://api.openai.com/v1"
            : "https://api.anthropic.com/v1";
        const defaultKey = hasOpenAi
          ? opts.apiKey ?? settings.apiKey ?? process.env.OPENAI_API_KEY
          : process.env.ANTHROPIC_API_KEY;
        llmCallback = makeAuditLlmCallback({
          model: opts.model ?? settings.model ?? defaultModel,
          apiBase: opts.apiBase ?? settings.apiBase ?? defaultBase,
          apiKey: opts.apiKey ?? settings.apiKey ?? defaultKey,
        });
        if (opts.fallbackModel) {
          fallbackCallback = makeAuditLlmCallback({
            model: opts.fallbackModel,
            apiBase: opts.fallbackApiBase ?? defaultBase,
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
        since: opts.since,
        onPhase: (phase, detail) => {
          if (phase !== lastPhase) {
            console.log(`${ICONS.phase} ${phase}${detail ? `: ${detail}` : "..."}`);
            lastPhase = phase;
          }
        },
        onCandidate: opts.ci
          ? undefined  // v2.10.353 — silence per-candidate noise in CI logs
          : (cand, ver, i, total) => {
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
      const scannedLabel = result.coverage
        ? `${result.files_scanned} / ${result.coverage.totalCandidateFiles}`
        : String(result.files_scanned);
      console.log(`  Files scanned:       ${scannedLabel}`);
      console.log(`  Candidates found:    ${result.candidates_found}`);
      console.log(
        `  \x1b[31mConfirmed findings:  ${result.confirmed_findings}\x1b[0m`,
      );
      console.log(`  False positives:     ${result.false_positives}`);
      if ((result.needs_context ?? 0) > 0) {
        console.log(
          `  \x1b[33mUncertain (needs_context): ${result.needs_context}\x1b[0m — verifier couldn't decide`,
        );
      }
      console.log(`  Duration:            ${(result.elapsed_ms / 1000).toFixed(1)}s`);
      if (result.coverage?.truncated) {
        const suggestion = Math.min(
          result.coverage.totalCandidateFiles,
          result.coverage.maxFiles * 4,
        );
        console.log("");
        console.log(
          `  \x1b[33m⚠ Coverage truncated: ${result.coverage.scannedFiles}/${result.coverage.totalCandidateFiles} ` +
            `files scanned (${result.coverage.skippedByLimit} skipped, cap ${result.coverage.maxFiles} ` +
            `from ${result.coverage.capSource}).\x1b[0m`,
        );
        console.log(
          `  \x1b[33m  Rerun with --max-files ${suggestion} for full coverage.\x1b[0m`,
        );
      }
      console.log("");

      // v2.10.353 — --ci sets the process exit code based on
      // ACTIONABLE findings (excludes review_state ignored /
      // demoted_fp). For a fresh scan with no review history, this
      // equals confirmed_findings; for a re-run that has a prior
      // review trail in the JSON, this respects the reviewer's
      // decisions. Exit 1 signals "block the merge"; exit 0 is
      // green.
      if (opts.ci) {
        const actionable = result.findings.filter(
          (f) =>
            (f as { review_state?: string }).review_state !== "ignored" &&
            (f as { review_state?: string }).review_state !== "demoted_fp",
        ).length;
        if (actionable > 0) {
          console.log(`\x1b[31m✗ CI gate: ${actionable} actionable finding${actionable === 1 ? "" : "s"} — failing build.\x1b[0m`);
          process.exit(1);
        } else {
          console.log(`\x1b[32m✓ CI gate: no actionable findings.\x1b[0m`);
          process.exit(0);
        }
      }
    });
}
