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
      "Second model for ensemble verification. Default cascade mode is " +
        "'on-confirmed' (high-precision ensemble): fallback runs only when " +
        "primary confirms; final verdict is `confirmed` only if BOTH agree. " +
        "Override with --cascade-mode on-needs-context for the legacy " +
        "escalate-on-ambiguous flow. v2.10.406.",
    )
    .option("--fallback-api-base <url>", "API base for fallback model")
    .option("--fallback-api-key <key>", "API key for fallback model")
    .option(
      "--cascade-mode <mode>",
      "How --fallback-model is invoked: 'on-confirmed' (default — fallback " +
        "runs only when primary confirms; final verdict requires both to " +
        "agree) or 'on-needs-context' (legacy — fallback runs only when " +
        "primary returns needs_context).",
    )
    .option("--max-files <n>", "Max files to scan (default: unlimited)", "0")
    .option("--skip-verify", "Skip model verification (static-only output)", false)
    .option(
      "--since <ref>",
      "Diff-based audit: only scan files changed since <ref> (e.g. main, HEAD~10, origin/main). " +
        "10x+ speedup on large repos and the right default for CI pre-merge gates.",
    )
    .option(
      "--pack <name>",
      "Restrict to a vendible pack: web | ai-ml | cloud | supply-chain | embedded. " +
        "Only patterns tagged with that pack are loaded. v2.10.370 (F9).",
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
    .option(
      "--exploits",
      "Generate proof-of-concept exploit data for each confirmed finding. " +
        "Templates exist for ~10 patterns (deterministic PoCs); uncovered patterns optionally use " +
        "the verifier model for an LLM-assisted PoC. Adds an Exploit Proofs section to the report. " +
        "Never executes anything — just structured PoC data. P1.3 (v2.10.389).",
      false,
    )
    .option(
      "--deps",
      "Also scan dependency manifests (package.json) against a curated advisory database. " +
        "Each known-vulnerable dependency becomes a confirmed finding alongside source-code findings. " +
        "P2.4 slice 1 (v2.10.392+). Currently npm-only; future slices add pip / cargo / go / etc.",
      false,
    )
    .option(
      "--include-quality",
      "Include code-quality patterns (NPE risks, resource leaks, infinite loops). Off by default " +
        "because these fire densely on real-world code without being exploitable on their own — " +
        "the noise drowns the security signal. Enable when you want a quality pass alongside the " +
        "security audit. v2.10.397.",
      false,
    )
    .option(
      "--confidence <band>",
      "Filter findings by confidence band: 'high' (verifier-confirmed + tainted-flow only), " +
        "'medium' (high + stable-pattern matches), 'all' (everything). Default: all. v2.10.400.",
      "all",
    )
    .action(
      async (
        path: string,
        opts: {
          output?: string;
          model?: string;
          apiBase?: string;
          apiKey?: string;
          fallbackModel?: string;
          fallbackApiBase?: string;
          fallbackApiKey?: string;
          cascadeMode?: string;
          maxFiles: string;
          skipVerify: boolean;
          since?: string;
          pack?: string;
          json: boolean;
          sarif: boolean;
          ci: boolean;
          exploits: boolean;
          deps: boolean;
          includeQuality: boolean;
          confidence: string;
        },
      ) => {
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
          console.log(
            `  Mode:     CI gate (--since ${opts.since ?? "<none>"}, json+sarif, exit-on-finding)`,
          );
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
          llmCallback = async () =>
            JSON.stringify({
              verdict: "confirmed",
              reasoning: "static-only mode",
              evidence: { sink: "static-only bypass" },
            });
        } else {
          const settings = await loadSettings(projectRoot);
          // Routing is delegated to makeAuditLlmCallback: it picks the
          // baseUrl from the model-name prefix and the apiKey from the
          // matching per-provider field in `settings` (anthropicApiKey,
          // xaiApiKey, kimiApiKey, ...). v2.10.405 — closes the bug
          // where a saved OpenAI sk-proj-... key in `settings.apiKey`
          // shadowed every -m provider and routed verifier calls to
          // OpenAI's exhausted quota, returning 429 → needs_context
          // for every finding.
          //
          // We deliberately do NOT pass `settings.apiKey` as the
          // generic apiKey: that field is the OpenAI dashboard key
          // and only applies when the model resolves to OpenAI.
          // Commander quirk: the root program also defines `-m, --model`
          // and `--fallback-model` (for the default chat command). When
          // those flags appear on `kcode audit ...`, commander parses
          // them into the PARENT's opts, not the subcommand's. So we
          // fall back to program.opts() for model/fallbackModel.
          // v2.10.405.
          const parentOpts = program.opts() as { model?: string; fallbackModel?: string };
          const pickedModel =
            opts.model ?? parentOpts.model ?? settings.model ?? "claude-sonnet-4-6";
          const pickedFallbackModel = opts.fallbackModel ?? parentOpts.fallbackModel;
          llmCallback = makeAuditLlmCallback({
            model: pickedModel,
            apiBase: opts.apiBase ?? settings.apiBase,
            apiKey: opts.apiKey,
            settings: settings as unknown as Record<string, string | undefined>,
          });
          if (pickedFallbackModel) {
            fallbackCallback = makeAuditLlmCallback({
              model: pickedFallbackModel,
              apiBase: opts.fallbackApiBase,
              apiKey: opts.fallbackApiKey,
              settings: settings as unknown as Record<string, string | undefined>,
            });
            const mode = opts.cascadeMode ?? "on-confirmed";
            console.log(
              `  \x1b[36mEnsemble cascade (${mode}): primary ${pickedModel}, fallback ${pickedFallbackModel}\x1b[0m`,
            );
            console.log("");
          }
        }

        // Run pipeline with progress output
        let lastPhase = "";
        let verifiedCount = 0;
        // F9 (v2.10.370) — validate --pack before passing through.
        const validPacks = new Set(["web", "ai-ml", "cloud", "supply-chain", "embedded"]);
        if (opts.pack && !validPacks.has(opts.pack)) {
          console.error(
            `  --pack must be one of: ${[...validPacks].join(", ")}. Got: "${opts.pack}".`,
          );
          process.exit(1);
        }
        const result = await runAudit({
          projectRoot,
          llmCallback,
          fallbackCallback,
          ...(opts.cascadeMode
            ? { cascadeMode: opts.cascadeMode as "on-confirmed" | "on-needs-context" }
            : {}),
          maxFiles,
          skipVerification: opts.skipVerify,
          generateExploits: opts.exploits,
          includeDeps: opts.deps,
          includeQuality: opts.includeQuality,
          since: opts.since,
          ...(opts.pack
            ? { pack: opts.pack as "web" | "ai-ml" | "cloud" | "supply-chain" | "embedded" }
            : {}),
          onPhase: (phase, detail) => {
            if (phase !== lastPhase) {
              console.log(`${ICONS.phase} ${phase}${detail ? `: ${detail}` : "..."}`);
              lastPhase = phase;
            }
          },
          onCandidate: opts.ci
            ? undefined // v2.10.353 — silence per-candidate noise in CI logs
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

        // Apply --confidence filter BEFORE report generation so the
        // markdown / JSON / SARIF outputs all see the filtered set.
        // The full unfiltered counts still appear in the headline
        // breakdown ("High: 5 Medium: 12 Low: 47"). v2.10.400.
        if (opts.confidence && opts.confidence !== "all") {
          const { passesConfidenceFilter } = await import(
            "../../core/audit-engine/finding-confidence"
          );
          const minBand = opts.confidence as "high" | "medium" | "all";
          const before = result.findings.length;
          result.findings = result.findings.filter((f) =>
            passesConfidenceFilter(f, minBand),
          );
          const dropped = before - result.findings.length;
          if (dropped > 0) {
            result.confirmed_findings = result.findings.length;
            console.log(
              `${ICONS.phase} confidence filter: dropped ${dropped} findings below '${minBand}' band`,
            );
          }
        }

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
        console.log(`  \x1b[31mConfirmed findings:  ${result.confirmed_findings}\x1b[0m`);
        // Per-band confidence breakdown. Only printed when at least
        // one finding carries a confidence score — back-compat for
        // older results / older runners. v2.10.400.
        const { countByBand } = await import("../../core/audit-engine/finding-confidence");
        const bands = countByBand(result.findings);
        if (bands.high + bands.medium + bands.low > 0) {
          console.log(
            `    \x1b[32mHigh confidence:   ${bands.high}\x1b[0m   ` +
              `\x1b[33mMedium: ${bands.medium}\x1b[0m   ` +
              `\x1b[90mLow: ${bands.low}\x1b[0m`,
          );
          if (opts.confidence && opts.confidence !== "all") {
            console.log(`    (filter: --confidence ${opts.confidence})`);
          }
        }
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
          console.log(`  \x1b[33m  Rerun with --max-files ${suggestion} for full coverage.\x1b[0m`);
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
            console.log(
              `\x1b[31m✗ CI gate: ${actionable} actionable finding${actionable === 1 ? "" : "s"} — failing build.\x1b[0m`,
            );
            process.exit(1);
          } else {
            console.log(`\x1b[32m✓ CI gate: no actionable findings.\x1b[0m`);
            process.exit(0);
          }
        }
      },
    );
}
