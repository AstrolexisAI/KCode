// KCode - PR Generator
//
// Creates a detailed Pull Request from audit findings + applied fixes.
// Uses the LLM to write a professional PR description that explains
// each bug found, its impact, and the fix applied.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { AuditResult, Finding } from "./types";

export interface PrOptions {
  projectRoot: string;
  /** LLM callback for generating the PR description */
  llmCallback: (prompt: string) => Promise<string>;
  /** Override branch name (default: fix/kcode-audit-YYYY-MM-DD) */
  branchName?: string;
  /** Target repo for gh pr create (e.g. "nasa/IDF"). Auto-detected if omitted. */
  repo?: string;
  /** Don't actually push or create PR — just generate and show what would happen */
  dryRun?: boolean;
  /** Progress callback for each step */
  onStep?: (step: string) => void;
}

export interface PrResult {
  branchName: string;
  commitHash: string;
  prUrl?: string;
  prDescription: string;
  filesChanged: number;
  dryRun: boolean;
  pushError?: string;
}

// HD.1 (v2.10.380) — argv-form helpers. Prior versions built shell
// strings via template literals (`git ${args}`), which interpreted
// shell metacharacters in any user-influenced arg (branch name,
// repo, head ref, fork user, file path). For an audit tool, command
// injection in our own PR generator is unacceptable. execFileSync
// receives the args as an array and never invokes a shell.
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function gh(cwd: string, args: string[]): string {
  return execFileSync("gh", args, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/**
 * Detect the repository's default integration branch.
 *
 * Order of preference:
 *   1. `origin`'s configured default (`origin/HEAD` symbolic-ref) — what
 *      `gh` and most CI tools use.
 *   2. First match among common conventional names: main, master, devel,
 *      develop, trunk.
 *   3. Fallback to "main" so callers always get a string.
 *
 * Avoids the historic hardcode that broke `/pr` on repos using `devel`
 * (NASA-fprime) or `master` (older projects) — it raised
 * `fatal: ambiguous argument 'main^'`.
 */
function defaultBranch(cwd: string): string {
  try {
    const ref = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    const m = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1]!;
  } catch { /* origin/HEAD not set — try fallbacks */ }
  for (const candidate of ["main", "master", "devel", "develop", "trunk"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", candidate], {
        cwd, encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"],
      });
      return candidate;
    } catch { /* not this one */ }
  }
  return "main";
}

/**
 * Run a git/gh command and capture both stdout and stderr. v316 made
 * push errors generic ("Push to fork failed") because execSync's
 * default error message is just the exit code summary; the actual
 * remote error (e.g. "permission denied", "fork not provisioned yet")
 * was lost. This variant returns the captured stderr so callers can
 * surface it.
 */
function runCapturing(
  bin: "git" | "gh",
  cwd: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string } {
  try {
    const out = execFileSync(bin, args, {
      cwd,
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, stdout: out.trim(), stderr: "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? e.message ?? "").trim(),
    };
  }
}

/**
 * Returns true when a remote+branch pair exists on the remote (i.e. the
 * local branch was already pushed). Used to make /pr idempotent so a
 * user can re-run after a transient push failure without losing state.
 */
function remoteBranchExists(cwd: string, remote: string, branch: string): boolean {
  const r = runCapturing("git", cwd, ["ls-remote", "--heads", remote, branch]);
  return r.ok && r.stdout.length > 0;
}

function detectRemoteRepo(cwd: string): string | null {
  try {
    const url = git(cwd, ["remote", "get-url", "origin"]);
    // Extract owner/repo from various URL formats
    const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    return m ? m[1]!.replace(/\.git$/, "") : null;
  } catch {
    return null;
  }
}

/**
 * Build a prompt for the LLM to generate a detailed PR description
 * from the audit findings.
 */
/**
 * Detect the repo's primary build/test ecosystem so the testing
 * checklist in the PR is the actual invocation a maintainer would
 * use, not a generic "cmake && make". v2.10.329 (Sprint 4).
 */
type Ecosystem =
  | "cmake"
  | "cargo"
  | "go"
  | "bun"
  | "npm"
  | "python-pyproject"
  | "python-setup"
  | "gradle"
  | "maven"
  | "make"
  | "unknown";

function detectEcosystem(projectRoot: string): Ecosystem {
  const has = (rel: string): boolean => existsSync(resolve(projectRoot, rel));
  // Order matters — check the most specific build files first.
  if (has("Cargo.toml")) return "cargo";
  if (has("go.mod")) return "go";
  if (has("bun.lock") || has("bun.lockb")) return "bun";
  if (has("package-lock.json") || has("package.json")) return "npm";
  if (has("pyproject.toml")) return "python-pyproject";
  if (has("setup.py") || has("requirements.txt")) return "python-setup";
  if (has("build.gradle") || has("build.gradle.kts")) return "gradle";
  if (has("pom.xml")) return "maven";
  if (has("CMakeLists.txt")) return "cmake";
  if (has("Makefile") || has("makefile")) return "make";
  return "unknown";
}

/**
 * Render the testing-checklist section using the actual build/test
 * commands the project responds to. Avoids the previous trap where
 * every PR said "cmake && make" regardless of language.
 */
function buildTestingChecklist(ecosystem: Ecosystem): string[] {
  const ecosystemCmd: Record<Ecosystem, string[]> = {
    cmake: ["`cmake -B build && cmake --build build`", "`ctest --test-dir build --output-on-failure`"],
    cargo: ["`cargo build --all-targets`", "`cargo test --all-features`", "`cargo clippy -- -D warnings`"],
    go: ["`go build ./...`", "`go test ./...`", "`go vet ./...`"],
    bun: ["`bun install`", "`bun test`", "`bun run --bun tsc --noEmit` (if TypeScript)"],
    npm: ["`npm install`", "`npm test`", "`npm run typecheck` (if TypeScript)"],
    "python-pyproject": ["`pip install -e .`", "`pytest`", "`ruff check .` (if configured)"],
    "python-setup": ["`pip install -e .`", "`pytest`"],
    gradle: ["`./gradlew build`", "`./gradlew test`"],
    maven: ["`mvn clean install`", "`mvn test`"],
    make: ["`make`", "`make test`"],
    unknown: ["Build the project using the repository's standard tooling.", "Run the project's test suite."],
  };
  const cmds = ecosystemCmd[ecosystem];
  const lines: string[] = [];
  for (const cmd of cmds) {
    lines.push(`- [ ] ${cmd}`);
  }
  lines.push("- [ ] No regressions in existing functionality");
  lines.push("- [ ] Fixes address `CWE` references where applicable");
  return lines;
}

/**
 * Narrow LLM prompt — only asks for a 2-3 paragraph executive
 * summary. Findings, counts, coverage, methodology and testing
 * checklist are rendered deterministically from JSON. v2.10.329.
 *
 * The narrower the prompt, the less surface area for hallucinated
 * paths / Spanish leaks / chain-of-thought / fabricated counts.
 */
/**
 * v2.10.351 P0 — Filter findings to only those that should reach
 * the PR pipeline. \`ignored\` findings are tagged by the reviewer
 * as "leave alone" and must not be committed, summarized, or shown
 * in the PR body. \`demoted_fp\` is also excluded defensively even
 * though persist() should have moved them out of result.findings
 * already — a stale on-disk JSON could still carry one.
 */
function actionableFindings(result: AuditResult): Finding[] {
  return result.findings.filter(
    (f) => f.review_state !== "ignored" && f.review_state !== "demoted_fp",
  );
}

function buildExecutiveSummaryPrompt(result: AuditResult): string {
  const findingsList = actionableFindings(result)
    .map((f, i) => {
      const rel = f.file.replace(result.project + "/", "");
      return `${i + 1}. [${f.severity.toUpperCase()}] ${f.pattern_title} — ${rel}:${f.line}`;
    })
    .join("\n");

  return `Write a 2-3 paragraph executive summary for a code-quality / security
audit Pull Request. English only. Plain prose. NO bullet lists, NO headings,
NO inline code blocks, NO links, NO file paths, NO numeric counts (those are
rendered separately).

Constraints (matter for upstream CI):
  - Common English words only. No Spanish or other languages.
  - Do not name the auditor, the tool, or any vendor.
  - Do not invent CWE numbers or claim things the findings list doesn't say.
  - 350 words MAX. Aim for 200.

Audit context:
  Project: ${basename(result.project)}
  Confirmed findings: ${result.confirmed_findings}
  False positives filtered: ${result.false_positives}

Findings list (do NOT enumerate; summarize the patterns at a high level):
${findingsList}

Write the summary as 2-3 paragraphs explaining: (a) what classes of issues
were found, (b) why they matter for the kind of system this code runs in,
(c) what the patches change at the highest level. End there. No conclusion
sentence, no call to action.`;
}

/**
 * Sanitize the LLM-produced executive summary. Narrower than the
 * full-body sanitizePrBody — the LLM only writes prose now, so this
 * just strips chain-of-thought, escapes brand terms, and caps length.
 */
function sanitizeExecutiveSummary(text: string, projectRoot: string): string {
  let out = text.trim();

  // Chain-of-thought: drop everything before "Here's" / numbered
  // reasoning preamble. If the model emitted a clean summary it
  // starts with prose; this is a no-op.
  const headingIdx = out.search(/^[A-Z][A-Za-z]+\s/m);
  if (headingIdx > 0 && /^(Here'?s a (?:thinking|reasoning)|^\d+\.\s)/i.test(out)) {
    out = out.slice(headingIdx);
  }

  // Strip absolute paths.
  const projectAbs = projectRoot.replace(/\/+$/, "");
  if (projectAbs) out = out.split(projectAbs + "/").join("").split(projectAbs).join("");
  out = out.replace(/\/(?:home|Users|var|opt|tmp)\/[\w./-]+\/([\w./-]+)/g, "$1");

  // Wrap brand terms.
  for (const term of ["KCode", "kcode", "Astrolexis", "Kulvex"]) {
    out = out.replace(new RegExp(`(?<!\`)\\b${term}\\b(?!\`)`, "g"), `\`${term}\``);
  }

  // Replace coined words.
  out = out.replace(/\boverreads?\b/gi, "out-of-bounds reads");

  // Cap length at 1500 chars (~250 words).
  if (out.length > 1500) {
    out = `${out.slice(0, 1500).replace(/\s+\S*$/, "")}…`;
  }
  return out.trim();
}

function buildPrPrompt(result: AuditResult, fixes: string[]): string {
  const findingsSummary = actionableFindings(result)
    .map((f, i) => {
      const rel = f.file.replace(result.project + "/", "");
      const ev = f.verification.evidence;
      const fixText = ev?.suggested_fix ?? f.verification.suggested_fix;
      const sinkLine = ev?.sink ? `\n   Sink: ${ev.sink}` : "";
      const boundaryLine = ev?.input_boundary ? `\n   Input: ${ev.input_boundary}` : "";
      const fixLine = fixText ? `\n   Fix: ${fixText}` : "";
      return (
        `${i + 1}. [${f.severity.toUpperCase()}] ${f.pattern_title} — ${rel}:${f.line}\n` +
        `   ${f.verification.reasoning}` +
        sinkLine +
        boundaryLine +
        fixLine
      );
    })
    .join("\n\n");

  const fixesSummary = fixes.map((f) => `- ${f}`).join("\n");

  return `You are writing a Pull Request description for a security/code-quality audit.
Write a professional, detailed PR description in English ONLY.

CONSTRAINTS — these matter for upstream CI (spell-check / linting):
- Use ONLY common English words. No Spanish, no Portuguese, no other-language words.
- Do not include absolute file paths. Use repo-relative paths only.
- Do not invent project names, vendor names, or organization names.
- When you reference a tool / acronym (CWE, GCC, RAII, AES, etc.), put it in
  inline backticks (e.g. \`CWE-22\`) so spell-checkers skip the token.
- Do not use the word "kcode", "Astrolexis", or "Kulvex" in the body. The
  attribution footer is added programmatically and is the only branded text.
- Pattern IDs (like \`fsw-010\`, \`crypto-001\`) must always be in inline backticks.
- Avoid coined words like "overreads"; prefer "out-of-bounds reads".

PROJECT: ${basename(result.project)}
FILES SCANNED: ${result.files_scanned}
CONFIRMED FINDINGS: ${result.confirmed_findings}
FALSE POSITIVES: ${result.false_positives}

FINDINGS:
${findingsSummary}

FIXES APPLIED:
${fixesSummary}

Write the PR in this EXACT format:

## Security and code-quality audit

**Findings:** N confirmed (N false positives filtered)
**Scan time:** Ns

### Summary
[2-3 sentences explaining what was found and fixed.]

### Findings and fixes

[For EACH finding, write a subsection with:]
#### N. [SEVERITY] Title — file:line
**Bug:** [1-2 sentences explaining the root cause.]
**Impact:** [What could go wrong — be specific about exploitation.]
**Fix:** [What the patch does.]

### Methodology
[One paragraph: deterministic pattern library scans for known-dangerous patterns,
then a model-based verifier rules out false positives. Mention only common
English terms, no vendor names.]

### Testing
- [ ] Compilation verified (\`cmake\` and \`make\` — clean build)
- [ ] No regressions in existing functionality
- [ ] Fixes address \`CWE\` references where applicable
`;
}

/**
 * Build the PR body deterministically from the audit JSON. Becomes
 * the PRIMARY path for /pr in v2.10.329 (Sprint 4) — the LLM is now
 * only invoked for the executive-summary paragraph, which is spliced
 * in at insertSummaryAt by composePrBody. Sections produced here:
 *
 *   • Header (counts + scan duration + coverage)
 *   • Auditability table (rewrite/annotate/manual breakdown)
 *   • Summary placeholder (LLM-filled or omitted on failure)
 *   • Findings and fixes (deterministic, cites pattern_id, CWE,
 *     fix_support, review_reason when reviewer touched it)
 *   • Methodology (fixed prose)
 *   • Testing (ecosystem-aware via detectEcosystem)
 *   • Footer (attribution in inline code so spell-check skips it)
 *
 * Eliminates two whole classes of v318/v320 bugs: chain-of-thought
 * leaks and hallucinated counts/paths/CWE numbers, since the LLM
 * never writes any of those fields.
 */
const SUMMARY_PLACEHOLDER = "<!-- KCODE_SUMMARY -->";

function buildStructuredPrBody(
  result: AuditResult,
  projectRoot: string,
): string {
  const lines: string[] = [];
  const fixSummary =
    (result as { fix_support_summary?: { rewrite: number; annotate: number; manual: number } })
      .fix_support_summary;

  lines.push("## Security and code-quality audit");
  lines.push("");
  // F2 (v2.10.362) — quantitative confidence first so PR reviewers
  // see "is this run trustworthy?" before any counts.
  const conf = result.audit_confidence;
  if (conf) {
    lines.push(`**Audit confidence:** ${conf.score} / 100`);
  }
  lines.push(
    `**Findings:** ${result.confirmed_findings} confirmed (${result.false_positives} false positives filtered${result.needs_context ? `, ${result.needs_context} uncertain` : ""})`,
  );
  lines.push(`**Scan duration:** ${(result.elapsed_ms / 1000).toFixed(1)}s`);
  if (result.coverage) {
    const pct = Math.round(
      (result.coverage.scannedFiles / Math.max(result.coverage.totalCandidateFiles, 1)) * 100,
    );
    const truncTag = result.coverage.truncated ? " (truncated — see warning below)" : "";
    lines.push(
      `**Coverage:** ${result.coverage.scannedFiles}/${result.coverage.totalCandidateFiles} files (${pct}%)${truncTag}`,
    );
  }
  if (fixSummary) {
    lines.push(
      `**Fix support:** ${fixSummary.rewrite} rewrite · ${fixSummary.annotate} annotate · ${fixSummary.manual} manual-only`,
    );
  }
  lines.push("");
  if (result.coverage?.truncated) {
    lines.push(
      `> ⚠ This audit covered only ${result.coverage.scannedFiles}/${result.coverage.totalCandidateFiles} files. ` +
        "Findings reflect the scanned subset, not the full codebase.",
    );
    lines.push("");
  }

  lines.push("### Summary");
  lines.push("");
  lines.push(SUMMARY_PLACEHOLDER);
  lines.push("");

  // CL.7 (v2.10.377) — three explicit buckets the reviewer can
  // skim without parsing prose:
  //
  //   Fixed:   confirmed findings whose fix_support is "rewrite"
  //            (the ones /fix can mechanically apply with no human
  //            judgment needed)
  //   Manual:  confirmed findings whose fix_support is "annotate"
  //            or "manual" — the rewriter can't act, the human
  //            needs to read and patch
  //   Ignored: findings the reviewer flagged as `ignored`, plus
  //            FP-detail entries flagged as `demoted_fp` (the
  //            human disagreed with the verifier's verdict)
  //
  // Counts must be internally consistent so a CI gate can compare
  // them against AUDIT_REPORT.json fields:
  //   fixed.length + manual.length === actionableFindings(result).length
  //   ignored count === findings.filter(ignored) + fp_detail.filter(demoted_fp)
  const renderableFindings = actionableFindings(result);
  const fixedFindings = renderableFindings.filter(
    (f) => (f as { fix_support?: string }).fix_support === "rewrite",
  );
  const manualFindings = renderableFindings.filter(
    (f) => (f as { fix_support?: string }).fix_support !== "rewrite",
  );
  const ignoredFromFindings = result.findings.filter(
    (f) => (f as { review_state?: string }).review_state === "ignored",
  );
  const demotedFromFps = (result.false_positives_detail ?? []).filter(
    (fp) => (fp as { review_state?: string }).review_state === "demoted_fp",
  );

  /** Render one finding card. Shared between the Fixed and Manual sections. */
  const renderFindingCard = (f: Finding, i: number): void => {
    const rel = f.file.startsWith(projectRoot + "/")
      ? f.file.slice(projectRoot.length + 1)
      : f.file.replace(result.project + "/", "");
    const fSupport = (f as { fix_support?: "rewrite" | "annotate" | "manual" }).fix_support;
    const reviewReason = (f as { review_reason?: string }).review_reason;

    lines.push(
      `#### ${i + 1}. [${f.severity.toUpperCase()}] ${f.pattern_title} — \`${rel}:${f.line}\``,
    );
    lines.push("");
    const meta: string[] = [];
    meta.push(`Pattern \`${f.pattern_id}\``);
    if (f.cwe) meta.push(f.cwe);
    if (fSupport) meta.push(`fix-support: \`${fSupport}\``);
    if (reviewReason) meta.push(`reviewer: \`${reviewReason}\``);
    lines.push(meta.join(" · "));
    lines.push("");
    if (f.verification.reasoning) {
      lines.push(`**Bug.** ${f.verification.reasoning.slice(0, 500).replace(/\n/g, " ")}`);
    }
    // Evidence Pack (v2.10.361+) — terse one-line-per-field. Falls
    // back to legacy string fields when evidence is absent.
    const ev = f.verification.evidence;
    if (ev?.sink) {
      lines.push("");
      lines.push(`**Sink.** \`${ev.sink}\``);
    }
    if (ev?.input_boundary) {
      lines.push("");
      lines.push(`**Input boundary.** ${ev.input_boundary}`);
    }
    if (ev?.execution_path_steps && ev.execution_path_steps.length > 0) {
      lines.push("");
      lines.push(
        `**Execution path.** ${ev.execution_path_steps.join(" → ").slice(0, 500)}`,
      );
    } else if (f.verification.execution_path) {
      lines.push("");
      lines.push(
        `**Execution path.** ${f.verification.execution_path.slice(0, 500).replace(/\n/g, " ")}`,
      );
    }
    const fixText = ev?.suggested_fix ?? f.verification.suggested_fix;
    if (fixText) {
      lines.push("");
      lines.push(`**Fix applied.** ${fixText.slice(0, 500).replace(/\n/g, " ")}`);
    }
    if (ev?.test_suggestion) {
      lines.push("");
      lines.push(
        `**Regression test.** ${ev.test_suggestion.slice(0, 300).replace(/\n/g, " ")}`,
      );
    }
    lines.push("");
  };

  // ── Fixed (auto-applied rewrites) ─────────────────────────
  lines.push(`### Fixed findings (${fixedFindings.length})`);
  lines.push("");
  if (fixedFindings.length === 0) {
    lines.push("_None — no rewrite-tier findings in this run._");
    lines.push("");
  } else {
    lines.push(
      "_These were patched mechanically by `/fix`. Each finding has a fix recipe in the `rewrite` tier._",
    );
    lines.push("");
    fixedFindings.forEach((f, i) => renderFindingCard(f, i));
  }

  // ── Manual (needs human attention) ───────────────────────
  lines.push(`### Manual findings (${manualFindings.length})`);
  lines.push("");
  if (manualFindings.length === 0) {
    lines.push(
      "_None — every confirmed finding had a rewrite-tier fix recipe._",
    );
    lines.push("");
  } else {
    lines.push(
      "_These need human review — either `/fix` only inserts an audit-note " +
        "comment (annotate tier) or there's no automated fix recipe (manual tier). " +
        "Read the evidence below and patch by hand._",
    );
    lines.push("");
    manualFindings.forEach((f, i) =>
      // Continue numbering so reviewers can reference findings by
      // index across both sections without ambiguity.
      renderFindingCard(f, i + fixedFindings.length),
    );
  }

  // ── Ignored / demoted ────────────────────────────────────
  // Combines reviewer-ignored confirmed findings AND verifier-FPs
  // the reviewer explicitly demoted. Surfacing them in the PR
  // makes the human triage visible without rooting through JSON.
  const totalIgnored = ignoredFromFindings.length + demotedFromFps.length;
  if (totalIgnored > 0) {
    lines.push(`### Ignored / demoted (${totalIgnored})`);
    lines.push("");
    lines.push(
      "_Findings the reviewer explicitly chose not to act on. " +
        "Excluded from `/fix`, the actionable count, and SARIF output, " +
        "but kept here for the audit trail._",
    );
    lines.push("");
    for (const f of ignoredFromFindings) {
      const rel = f.file.startsWith(projectRoot + "/")
        ? f.file.slice(projectRoot.length + 1)
        : f.file;
      const note = (f as { review_note?: string }).review_note;
      const reason = (f as { review_reason?: string }).review_reason;
      const why = note ?? (reason ? `reason: \`${reason}\`` : "no reason recorded");
      lines.push(`- \`${f.pattern_id}\` @ \`${rel}:${f.line}\` — ignored — ${why}`);
    }
    for (const fp of demotedFromFps) {
      const rel = fp.file.startsWith(projectRoot + "/")
        ? fp.file.slice(projectRoot.length + 1)
        : fp.file;
      const reason = (fp as { review_reason?: string }).review_reason ?? "manual_confirmation";
      lines.push(`- \`${fp.pattern_id}\` @ \`${rel}:${fp.line}\` — demoted to FP — reason: \`${reason}\``);
    }
    lines.push("");
  }

  lines.push("### Methodology");
  lines.push("");
  lines.push(
    "A deterministic pattern library scanned the codebase for known-dangerous " +
      "shapes. Each candidate was then evaluated by a model-based verifier whose " +
      "mitigation checklist explicitly looked for in-source guards — asserts, " +
      "bound checks, type-system constraints, and trust-boundary distinctions " +
      "(intra-process port input vs external untrusted input) — before confirming. " +
      "Confirmed findings shown above passed the checklist; rejected candidates " +
      "remain in the JSON report's `false_positives_detail` for spot-checking.",
  );
  lines.push("");

  lines.push("### Testing");
  const ecosystem = detectEcosystem(projectRoot);
  for (const item of buildTestingChecklist(ecosystem)) {
    lines.push(item);
  }
  lines.push("");
  lines.push("---");
  lines.push("_Generated by `KCode` automated audit engine — `Astrolexis.space`._");
  return lines.join("\n");
}

/**
 * Compose the final PR body: structured skeleton + LLM summary
 * spliced into the placeholder. If the summary failed (empty / too
 * short), drop the placeholder line entirely so the markdown stays
 * valid. v2.10.329.
 */
function composePrBody(structured: string, summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length < 60) {
    // Treat the LLM output as a no-op. Replace the placeholder
    // with a one-line auto-summary derived from the structure.
    return structured.replace(
      SUMMARY_PLACEHOLDER,
      "_See findings below. Each entry names the file, the pattern, the bug, the impact, and the patch._",
    );
  }
  return structured.replace(SUMMARY_PLACEHOLDER, trimmed);
}

/** Backwards-compat alias kept for external callers / tests. */
function buildFallbackPrBody(result: AuditResult): string {
  return composePrBody(
    buildStructuredPrBody(result, result.project),
    "",
  );
}

/**
 * Strip / wrap content that fails upstream CI spell-check / linters:
 *
 *   - Absolute local paths (e.g. /home/<user>/proyectos/...) → repo-relative.
 *     Catches the v318 leak where the LLM hallucinated "proyectos" into the
 *     body even though it wasn't in the prompt.
 *   - Brand / vendor / project codename terms wrapped in inline code so
 *     spell-check skips them. Specific terms come from KCODE_PR_BRAND_TERMS
 *     (env override) and a short built-in list.
 *   - A neutral programmatic footer is appended at the end so the auditor
 *     attribution survives even if the LLM dropped it from the body.
 */
function sanitizePrBody(body: string, projectRoot: string): string {
  let out = body;

  // 0. Strip chain-of-thought / reasoning prefix. Reasoning models
  //    (mark7, qwen-r1, deepseek-r1) sometimes emit their thinking
  //    into the `content` field directly when asked for a long
  //    structured output — v319 PR #5061 shipped 2400 lines of
  //    raw "Here's a thinking process:" reasoning into the body.
  //
  //    Heuristic: the real PR body always starts with "## " (the
  //    audit title heading). If a "## " heading exists, slice from
  //    its first occurrence onward. That drops every line of
  //    pre-heading thinking text without needing to recognize
  //    every reasoning preamble shape.
  const headingMatch = out.match(/^(##\s)/m);
  if (headingMatch) {
    const idx = out.indexOf(headingMatch[0]);
    if (idx > 0) out = out.slice(idx);
  }

  // 1. Strip the local project path so anything downstream sees only the
  //    repo-relative form. Both the resolved path and any common parent
  //    leak (e.g. "/home/<user>/proyectos/<repo>/Svc/..." → "Svc/...").
  const projectAbs = projectRoot.replace(/\/+$/, "");
  if (projectAbs) {
    out = out.split(projectAbs + "/").join("");
    out = out.split(projectAbs).join("");
  }
  // Defensive: drop any other absolute path that escaped the LLM, replacing
  // it with the trailing path component only.
  out = out.replace(
    /\/(?:home|Users|var|opt|tmp)\/[\w./-]+\/([\w./-]+)/g,
    "$1",
  );

  // 2. Wrap brand / project-codename terms in inline code so spell-check
  //    skips them. The built-in list covers Astrolexis-org branding; users
  //    can extend via KCODE_PR_BRAND_TERMS=Foo,Bar.
  const builtin = ["KCode", "kcode", "Astrolexis", "Kulvex"];
  const extra = (process.env.KCODE_PR_BRAND_TERMS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const term of [...builtin, ...extra]) {
    // Only wrap when not ALREADY in inline code. Cheap heuristic: skip the
    // term if it already appears between backticks on the same line.
    const re = new RegExp(`(?<!\`)\\b${term}\\b(?!\`)`, "g");
    out = out.replace(re, `\`${term}\``);
  }

  // 3. Replace coined English words that some upstream spell-checkers
  //    flag (e.g. "overreads" — flagged by NASA's check-spelling).
  out = out.replace(/\boverreads?\b/gi, "out-of-bounds reads");

  // 4. Trim + ensure neutral, spell-check-safe footer.
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  const footer = "\n\n---\n_Generated by `KCode` automated audit engine — `Astrolexis.space`._";
  // Avoid double-footer when the LLM already produced one matching ours.
  if (!out.includes("Generated by")) out += footer;
  return out;
}

/**
 * Run the full PR creation pipeline:
 * 1. Create branch
 * 2. Stage + commit fixes
 * 3. Generate PR description via LLM
 * 4. Push + create PR via gh
 */
export async function createPr(opts: PrOptions): Promise<PrResult> {
  const { projectRoot, llmCallback, dryRun = false } = opts;
  // Use timestamp with hour+minute for unique branch names across runs
  const now = new Date();
  const ts = now.toISOString().replace(/[T:]/g, "-").slice(0, 16); // 2026-04-06-21-45
  let branchName = opts.branchName ?? `fix/kcode-audit-${ts}`;

  // Read the audit result
  const jsonPath = resolve(projectRoot, "AUDIT_REPORT.json");
  const mdPath = resolve(projectRoot, "AUDIT_REPORT.md");
  let auditResult: AuditResult;

  if (existsSync(jsonPath)) {
    auditResult = JSON.parse(readFileSync(jsonPath, "utf-8"));
  } else if (existsSync(mdPath)) {
    throw new Error(
      "AUDIT_REPORT.json not found. Run `/scan` with --json first, or re-run `/scan`.",
    );
  } else {
    throw new Error("No AUDIT_REPORT found. Run `/scan` first.");
  }

  // Check for uncommitted changes (our fixes). Two shapes are valid:
  //   (A) dirty tree with /fix-applied changes → normal first-run flow
  //   (B) clean tree but currently on a fix/kcode-audit-* branch with
  //       a recent commit → previous /pr run committed but couldn't
  //       push, resume from push step.
  const status = git(projectRoot, ["status", "--porcelain"]);
  let resumeMode = false;
  if (!status) {
    const currentBranch = git(projectRoot, ["branch", "--show-current"]);
    if (/^fix\/kcode-audit-/.test(currentBranch)) {
      resumeMode = true;
      // Use the branch we're already on instead of generating a new one,
      // so the existing commit + (maybe) existing remote ref keep working.
      branchName = currentBranch;
    } else {
      throw new Error("No changes to commit. Run `/fix` first to apply patches.");
    }
  }

  const changedFiles = resumeMode
    ? (() => {
        // Resume-mode: count commits on the fix branch that aren't on the
        // repository's default integration branch. Use `<base>..HEAD` form
        // (commits in HEAD not in base) instead of the brittle `--not main^`
        // shorthand that assumed `main` exists.
        const base = defaultBranch(projectRoot);
        try {
          return Number.parseInt(
            git(projectRoot, ["rev-list", "--count", `${base}..HEAD`]).trim() || "0",
            10,
          ) || 0;
        } catch {
          return 0; // base branch missing locally — show 0 rather than crash
        }
      })()
    : status.split("\n").filter((l) => l.trim()).length;

  // Diff stat is captured for the commit message footer; the PR
  // body itself no longer needs it (structured body draws from JSON).
  const diffStat = git(projectRoot, ["diff", "--stat"]);
  const fixes = diffStat.split("\n").filter((l) => l.includes("|")).map((l) => l.trim());

  // v2.10.329 (Sprint 4) — structured-first generation.
  //
  // 1. Build the deterministic skeleton from the audit JSON. Header,
  //    counts, coverage, fix_support breakdown, findings, methodology,
  //    ecosystem-aware testing checklist, footer.
  // 2. Ask the LLM ONLY for a 2-3 paragraph executive summary; splice
  //    it into the SUMMARY_PLACEHOLDER. If the LLM fails or returns
  //    garbage, the placeholder gets a one-line fallback and the rest
  //    of the body is intact.
  //
  // This eliminates the v318/v320 class of bugs where mark7 emitted
  // chain-of-thought / hallucinated counts / fabricated CWE numbers
  // into the body — the LLM never writes any of those fields now.
  const structured = buildStructuredPrBody(auditResult, projectRoot);
  let executiveSummary = "";
  try {
    const raw = await llmCallback(buildExecutiveSummaryPrompt(auditResult));
    executiveSummary = sanitizeExecutiveSummary(raw, projectRoot);
  } catch (err) {
    // Soft-fail — the structured body is still presentable.
    void err;
  }
  let prDescription = composePrBody(structured, executiveSummary);
  // Final defensive sanitize across the whole body — strips any
  // residual paths the LLM might have leaked into the summary, wraps
  // brand terms in inline code so spell-check skips them.
  prDescription = sanitizePrBody(prDescription, projectRoot);
  // v329: avoid never-used warnings while preserving the legacy
  // export (some callers still reference buildFallbackPrBody and
  // buildPrPrompt for their own tooling).
  void buildFallbackPrBody;
  void buildPrPrompt;
  void fixes;

  // Extract title from description (first ## heading)
  const titleMatch = prDescription.match(/^## (.+)$/m);
  const prTitle = titleMatch
    ? titleMatch[1]!.slice(0, 70)
    : `fix: security audit — ${auditResult.confirmed_findings} findings`;

  let commitHash = "";
  let prUrl: string | undefined;
  let pushError: string | undefined;
  const step = opts.onStep ?? (() => {});

  if (!dryRun) {
    if (resumeMode) {
      step("Resume mode: branch + commit already present, skipping to push...");
      // Capture the existing HEAD as the commit hash.
      try {
        commitHash = git(projectRoot, ["rev-parse", "--short", "HEAD"]);
      } catch { /* ignore */ }
    } else {
      // Create branch
      step("Creating branch...");
      try {
        git(projectRoot, ["checkout", "-b", branchName]);
      } catch {
        try { git(projectRoot, ["checkout", branchName]); } catch { /* ignore */ }
      }

      // Stage only the files that the audit actually modified, NOT the
      // audit reports or any other working-tree noise. v319 PR shipped
      // AUDIT_REPORT.json (2147 lines) + AUDIT_REPORT.md (311 lines) +
      // .kcode-* tempfiles into the upstream PR. v320: explicit
      // allowlist drives the stage, and audit/temp files are excluded
      // unconditionally.
      step("Staging changes...");
      // v2.10.351 P0 — stage only files referenced by actionable
      // findings (excludes ignored / demoted_fp). A reviewer who
      // tagged a finding as 'ignored' meant: don't touch this code,
      // and that includes not staging any unrelated edits in the
      // same file just because /fix tried to annotate it.
      const auditFiles = actionableFindings(auditResult).map((f) =>
        f.file.startsWith(projectRoot + "/")
          ? f.file.slice(projectRoot.length + 1)
          : f.file,
      );
      // HD.1 — argv-form passes path as one argument; spaces and
      // special chars no longer require manual JSON.stringify quoting.
      const uniquePaths = Array.from(new Set(auditFiles)).filter(Boolean);
      for (const p of uniquePaths) {
        runCapturing("git", projectRoot, ["add", "--", p]);
      }
      // Belt-and-suspenders: forcibly un-stage anything else that may
      // have crept in (e.g. user had pre-existing dirty state, or a
      // stray .kcode-* tempfile).
      runCapturing("git", projectRoot, [
        "reset",
        "HEAD",
        "--",
        "AUDIT_REPORT.json",
        "AUDIT_REPORT.md",
        "AUDIT_REPORT.sarif",
        ".kcode-pr-body",
        ".kcode-pr-comment",
        ".kcode-commit-msg",
      ]);

      // Commit
      step("Committing...");
      const commitMsg = `fix: address ${auditResult.confirmed_findings} security/quality findings from KCode audit

Automated fixes applied by KCode Audit Engine:
- ${fixes.slice(0, 10).join("\n- ")}${fixes.length > 10 ? `\n- ... and ${fixes.length - 10} more` : ""}

Signed-off-by: Astrolexis.space — Kulvex Code
`;
      const msgFile = resolve(projectRoot, ".kcode-commit-msg");
      writeFileSync(msgFile, commitMsg);
      try {
        commitHash = git(projectRoot, ["commit", "-F", msgFile]);
        const hashMatch = commitHash.match(/\[[\w/]+ ([a-f0-9]+)\]/);
        commitHash = hashMatch ? hashMatch[1]! : "";
      } finally {
        try { unlinkSync(msgFile); } catch { /* ignore */ }
      }
    }

    // Push strategy: try origin → if 403, fork → push to fork → PR from fork
    const upstreamRepo = opts.repo ?? detectRemoteRepo(projectRoot);
    let pushedToFork = false;
    let forkUser = "";

    // Resolve forkUser early so we can short-circuit when the branch
    // is already pushed to the user's fork.
    const userQ = runCapturing("gh", projectRoot, ["api", "user", "--jq", ".login"]);
    if (userQ.ok) forkUser = userQ.stdout;

    // Resume / idempotent path: if the branch is already on the user's
    // fork, skip the push step entirely. This handles the case where a
    // previous /pr run pushed but failed to create the PR (e.g. transient
    // gh CLI error), or where the user manually pushed after a previous
    // /pr run reported "Push failed".
    if (forkUser) {
      const exists = remoteBranchExists(projectRoot, "fork", branchName);
      if (exists) {
        step("Branch already on fork. Skipping push.");
        pushedToFork = true;
      }
    }

    if (!pushedToFork) {
      step("Pushing to origin...");
      const originPush = runCapturing("git", projectRoot, [
        "push",
        "-u",
        "origin",
        branchName,
      ]);
      if (!originPush.ok) {
        // Origin push failed (likely 403 — no write access). Try fork workflow.
        if (upstreamRepo) {
          if (!forkUser) {
            pushError = "GitHub not authenticated. Run /github login first.";
          } else {
            const repoName = upstreamRepo.split("/")[1] ?? "";

            // Fork the repo (or confirm it exists). gh's "already exists"
            // failure is non-fatal — we just want the fork to exist.
            step(`Forking ${upstreamRepo}...`);
            runCapturing("gh", projectRoot, ["repo", "fork", upstreamRepo, "--clone=false"]);

            // Always ensure the "fork" remote points to our fork.
            step("Configuring fork remote...");
            runCapturing("git", projectRoot, ["remote", "remove", "fork"]);
            const addRemote = runCapturing("git", projectRoot, [
              "remote",
              "add",
              "fork",
              `https://github.com/${forkUser}/${repoName}.git`,
            ]);
            if (!addRemote.ok) {
              pushError = `Could not configure fork remote: ${addRemote.stderr}`;
            }
          }

          if (!pushError) {
            step("Pushing to fork...");
            // Two attempts with a brief pause between — when gh just
            // forked the repo, GitHub takes a few seconds to fully
            // provision push access. The first push commonly hits 404
            // and a 5s retry succeeds.
            let lastStderr = "";
            for (let attempt = 0; attempt < 2; attempt++) {
              if (attempt > 0) {
                step("Waiting for fork to provision (retry)...");
                await new Promise((r) => setTimeout(r, 5000));
              }
              const r = runCapturing("git", projectRoot, [
                "push",
                "-u",
                "fork",
                branchName,
                "--force",
              ]);
              if (r.ok) {
                pushedToFork = true;
                break;
              }
              lastStderr = r.stderr || r.stdout;
            }
            if (!pushedToFork) {
              const lower = lastStderr.toLowerCase();
              if (lower.includes("403") || lower.includes("permission denied")) {
                pushError = `Permission denied pushing to fork: ${lastStderr.slice(0, 240)}`;
              } else if (lower.includes("404") || lower.includes("not found")) {
                pushError = `Fork not yet provisioned by GitHub. Wait ~30s and re-run /pr. (${lastStderr.slice(0, 200)})`;
              } else {
                pushError = `Push to fork failed: ${lastStderr.slice(0, 240)}`;
              }
            }
          }
        } else {
          pushError = "No write access and no upstream repo detected";
        }
      }
    }

    // Create PR
    if (!pushError && upstreamRepo) {
      step("Creating PR...");
      const bodyFile = resolve(projectRoot, ".kcode-pr-body");
      writeFileSync(bodyFile, prDescription);
      // Detect existing PR for this branch first — if one is already
      // open we can't create a duplicate.
      const head = pushedToFork && forkUser ? `${forkUser}:${branchName}` : branchName;
      const existingPr = runCapturing("gh", projectRoot, [
        "pr",
        "list",
        "--repo",
        upstreamRepo,
        "--head",
        head,
        "--state",
        "open",
        "--json",
        "url",
        "--jq",
        ".[0].url",
      ]);
      if (existingPr.ok && existingPr.stdout && existingPr.stdout !== "null") {
        prUrl = existingPr.stdout;
      } else {
        // HD.1 — argv form. Title and bodyFile path no longer require
        // shell quoting; gh handles each argument as a literal.
        const createArgs = [
          "pr",
          "create",
          "--title",
          prTitle,
          "--body-file",
          bodyFile,
          "--repo",
          upstreamRepo,
        ];
        if (pushedToFork && forkUser) {
          createArgs.push("--head", `${forkUser}:${branchName}`);
        }
        const create = runCapturing("gh", projectRoot, createArgs);
        if (create.ok) {
          prUrl = create.stdout;
        } else {
          // Surface the real reason instead of swallowing.
          pushError = `gh pr create failed: ${(create.stderr || create.stdout).slice(0, 240)}`;
        }
      }
      try { unlinkSync(bodyFile); } catch { /* ignore */ }

      // After the PR exists, add an attribution comment. PR comments are
      // not in scope of upstream spell-check / lint workflows, so this is
      // where KCode and Astrolexis can be named without escaping. Soft-fail:
      // a comment that doesn't post is non-fatal; the PR itself still works.
      if (prUrl) {
        const commentBody =
          `🛡️ **This audit was conducted by [KCode](https://astrolexis.space) — an automated security and code-quality audit engine by Astrolexis.**\n\n` +
          `KCode performed a deterministic pattern scan against the codebase, then ran a model-based verifier with a mitigation checklist over each candidate. The Pull Request body above is auto-generated from the verified findings.\n\n` +
          `Pattern coverage and verification details: [astrolexis.space/kcode](https://astrolexis.space).`;
        const commentFile = resolve(projectRoot, ".kcode-pr-comment");
        try {
          writeFileSync(commentFile, commentBody);
          runCapturing("gh", projectRoot, [
            "pr",
            "comment",
            prUrl,
            "--body-file",
            commentFile,
          ]);
        } catch { /* non-fatal */ }
        finally { try { unlinkSync(commentFile); } catch { /* ignore */ } }
      }
    }
  }

  step("Done");

  return {
    branchName,
    commitHash,
    prUrl,
    prDescription,
    filesChanged: changedFiles,
    dryRun,
    pushError,
  };
}
