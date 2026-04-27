// KCode - Audit Report Generator
//
// Phase 3 of the audit pipeline: produce a structured markdown report
// from the verified findings. This is the deliverable — one clean
// AUDIT_REPORT.md with evidence per finding.

import { relative } from "node:path";
import { getPatternById } from "./patterns";
import type { AuditResult, Finding, Severity } from "./types";

const SEVERITY_ICON: Record<Severity, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🟢",
};

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Append a "Verifier rejections (false positives)" section with up to
 * FP_SAMPLE_LIMIT entries. Designed to be spot-checkable: if the
 * user doesn't trust a 0-findings result, they can scan these to see
 * what the verifier threw out and judge the reasoning.
 */
const FP_SAMPLE_LIMIT = 10;
function renderFalsePositiveSection(result: AuditResult, lines: string[]): void {
  const details = result.false_positives_detail ?? [];
  if (details.length === 0) return;

  lines.push("## Verifier rejections (false positives)");
  lines.push("");
  lines.push(
    `The verifier rejected **${details.length}** candidate${details.length === 1 ? "" : "s"} ` +
      "as false positives. Spot-check these against the code to confirm the rejections were sensible; " +
      `full list is in \`AUDIT_REPORT.json → false_positives_detail\`.`,
  );
  lines.push("");

  const shown = details.slice(0, FP_SAMPLE_LIMIT);
  for (let i = 0; i < shown.length; i++) {
    const fp = shown[i]!;
    const rel = fp.file.startsWith(result.project + "/")
      ? fp.file.slice(result.project.length + 1)
      : fp.file;
    lines.push(
      `${i + 1}. \`${rel}:${fp.line}\` — pattern \`${fp.pattern_id}\` (${fp.severity})`,
    );
    lines.push(`   - Reason: ${fp.verification.reasoning.slice(0, 400).replace(/\n/g, " ")}`);
  }
  if (details.length > shown.length) {
    lines.push("");
    lines.push(
      `_…and ${details.length - shown.length} more. See \`AUDIT_REPORT.json\`._`,
    );
  }
  lines.push("");
}

/**
 * Append a per-pattern metrics section showing which patterns fired,
 * how many hits each had, and what the verifier did with them.
 * Helps the auditor spot patterns that fire heavily but rarely confirm
 * (low signal-to-noise) or never fire (candidate for removal). v2.10.330.
 *
 * Shows the top 10 patterns by hit count, sorted desc. If only one or
 * two patterns fired, we just list them; sorting is a no-op.
 */
function renderPatternMetricsSection(result: AuditResult, lines: string[]): void {
  const metrics = result.pattern_metrics ?? {};
  const entries = Object.entries(metrics);
  if (entries.length === 0) return;

  // Sort by hits desc, then by pattern_id for determinism.
  entries.sort((a, b) => {
    const diff = b[1].hits - a[1].hits;
    return diff !== 0 ? diff : a[0].localeCompare(b[0]);
  });
  const top = entries.slice(0, 10);

  lines.push("## Pattern hit-rate");
  lines.push("");
  lines.push(
    `${entries.length} pattern${entries.length === 1 ? "" : "s"} fired during this run. ` +
      "Top entries by hit count:",
  );
  lines.push("");
  lines.push("| Pattern | Hits | Sites | Confirmed | FP | needs_context | confirmed_rate |");
  lines.push("|---------|-----:|------:|----------:|---:|---:|---------------:|");
  for (const [pid, m] of top) {
    const rate = m.confirmed_rate !== undefined
      ? `${(m.confirmed_rate * 100).toFixed(0)}%`
      : "—";
    // unique_sites was added in v2.10.331 audit fix; older JSONs
    // without the field fall back to "—" so the column stays valid.
    const sites =
      (m as { unique_sites?: number }).unique_sites !== undefined
        ? String((m as { unique_sites: number }).unique_sites)
        : "—";
    lines.push(
      `| \`${pid}\` | ${m.hits} | ${sites} | ${m.confirmed} | ${m.false_positive} | ${m.needs_context} | ${rate} |`,
    );
  }
  if (entries.length > top.length) {
    lines.push("");
    lines.push(`_…and ${entries.length - top.length} more patterns. See \`AUDIT_REPORT.json → pattern_metrics\` for the full list._`);
  }
  lines.push("");
}

/**
 * Append a "Needs context (undecided)" section. Same shape + cap as
 * the FP section. These are candidates the verifier couldn't
 * classify — re-running with a better model (or passing more
 * context) may resolve them.
 */
/**
 * Surface AST grammar load status. Shown only when at least one
 * language failed to load — successful loads are silent. The point is
 * to tell the user "AST coverage is degraded for X; run `kcode
 * grammars install` to fix it" without spamming the happy-path report.
 *
 * v2.10.339.
 */
/**
 * v2.10.351 P1 — single-glance trustworthiness header rendered at
 * the very top of AUDIT_REPORT.md. Tells the reader at a glance:
 *   - how much was covered (files, mode)
 *   - whether the verifier ran or was skipped
 *   - which AST grammars loaded vs degraded
 *   - which patterns are noisy (top FP-rate)
 *   - autofix coverage breakdown
 *   - explicit warnings (truncated, skip-verify, missing grammars)
 *
 * Plain prose lines, no table — keeps it friendly for diff-viewers
 * and email digests. Warnings are emitted last so they're the final
 * thing the reader sees before the rest of the report.
 */
function renderAuditConfidence(result: AuditResult, lines: string[]): void {
  lines.push("## Audit Confidence");
  lines.push("");

  // ── Quantitative score (v2.10.362, F2) ────────────────────
  // Headline number first so a reader skimming the diff/email gets
  // "is this run trustworthy?" before any prose.
  const conf = result.audit_confidence;
  if (conf) {
    lines.push(`**Score:** ${conf.score} / 100`);
    lines.push("");
    const fmt = (n: number | null): string => (n === null ? "n/a" : `${n}`);
    lines.push("| Subscore | Value | Weight |");
    lines.push("|----------|-------|--------|");
    lines.push(`| Coverage | ${fmt(conf.coverage_score)} | 25% |`);
    lines.push(`| Verifier | ${fmt(conf.verifier_score)} | 20% |`);
    lines.push(`| AST | ${fmt(conf.ast_score)} | 15% |`);
    lines.push(`| Noise (FP justification) | ${fmt(conf.noise_score)} | 20% |`);
    lines.push(`| Fixability (rewrite-class) | ${fmt(conf.fixability_score)} | 20% |`);
    lines.push("");
  }

  // ── Coverage line ─────────────────────────────────────────
  const cov = result.coverage;
  if (cov) {
    const pct = cov.totalCandidateFiles > 0
      ? Math.round((cov.scannedFiles / cov.totalCandidateFiles) * 100)
      : 100;
    const since = (cov as { since?: string }).since;
    const mode = since ? `diff scan since \`${since}\`` : "full scan";
    lines.push(
      `**Coverage:** ${cov.scannedFiles} / ${cov.totalCandidateFiles} files ` +
        `(${pct}%) — ${mode}`,
    );
  }

  // ── Verifier line ─────────────────────────────────────────
  const vm = (result as { verification_mode?: "verified" | "skipped" }).verification_mode;
  if (vm === "skipped") {
    lines.push("**Verifier:** skipped (static-only output — see warnings)");
  } else if (vm === "verified") {
    lines.push("**Verifier:** active");
  }

  // ── AST grammars line ─────────────────────────────────────
  const astStatus = result.ast_grammar_status ?? [];
  if (astStatus.length > 0) {
    const loaded = astStatus.filter((s) => s.loaded).length;
    const missing = astStatus.length - loaded;
    if (missing === 0) {
      lines.push(`**AST grammars:** ${loaded} loaded`);
    } else {
      const missingLangs = astStatus
        .filter((s) => !s.loaded)
        .map((s) => s.language)
        .join(", ");
      lines.push(
        `**AST grammars:** ${loaded} loaded, ${missing} missing (${missingLangs})`,
      );
    }
  }

  // ── Findings line ─────────────────────────────────────────
  // After v2.10.351 P0.9 the actionable count can differ from
  // confirmed_findings; surface both when they diverge.
  const ignoredCount = result.findings.filter((f) => f.review_state === "ignored").length;
  const actionableCount = result.findings.filter(
    (f) => f.review_state !== "ignored" && f.review_state !== "demoted_fp",
  ).length;
  const fpCount = result.false_positives ?? 0;
  const ncCount = result.needs_context ?? 0;
  if (ignoredCount > 0) {
    lines.push(
      `**Findings:** ${actionableCount} actionable (${result.confirmed_findings} pre-review, ${ignoredCount} ignored) · ${fpCount} false-positive · ${ncCount} needs-context`,
    );
  } else {
    lines.push(
      `**Findings:** ${result.confirmed_findings} confirmed · ${fpCount} false-positive · ${ncCount} needs-context`,
    );
  }

  // ── Autofix line ──────────────────────────────────────────
  const fs = (result as { fix_support_summary?: { rewrite: number; annotate: number; manual: number } })
    .fix_support_summary;
  if (fs) {
    lines.push(
      `**Autofix:** ${fs.rewrite} rewrite · ${fs.annotate} annotate · ${fs.manual} manual-only`,
    );
  }

  // ── Learning loop suppression line ────────────────────────
  // CL.3 (v2.10.373) — surface when prior /review demotions caused
  // candidates to be pre-marked needs_context this run. Tells the
  // reader which findings showed up because the project's history
  // explicitly deprioritized them, not because the verifier saw
  // them and was uncertain.
  const suppressedCount = (result as { learning_loop_suppressed?: number })
    .learning_loop_suppressed;
  if (suppressedCount && suppressedCount > 0) {
    lines.push(
      `**Learning loop:** ${suppressedCount} candidate(s) pre-marked needs_context based on prior demotions in similar paths.`,
    );
  }

  // ── Pack breakdown ────────────────────────────────────────
  // F9 (v2.10.370) — show which vendible packs the findings landed
  // under. Skipped when no breakdown is present (no findings).
  const breakdown = (result as { pack_breakdown?: Record<string, number> }).pack_breakdown;
  const scopedPack = (result as { scoped_pack?: string }).scoped_pack;
  if (breakdown && Object.keys(breakdown).length > 0) {
    const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
    const summary = entries.map(([k, v]) => `${v} ${k}`).join(" · ");
    const scopeNote = scopedPack ? ` (scoped to --pack ${scopedPack})` : "";
    lines.push(`**Pack breakdown:** ${summary}${scopeNote}`);
  }

  // ── Top-noise line ────────────────────────────────────────
  // Patterns whose verifier-confirmed rate is < 50% are the noisy
  // ones. Show the top 3 ranked by absolute FP count so the reader
  // sees what's eating verifier time.
  const metrics = result.pattern_metrics;
  if (metrics) {
    type N = { id: string; fp: number; conf: number; rate: number };
    const noisy: N[] = [];
    for (const [id, m] of Object.entries(metrics)) {
      if (m.unique_sites < 3) continue; // ignore one-off noise
      const rate = m.confirmed_rate ?? 0;
      if (rate >= 0.5) continue;
      noisy.push({ id, fp: m.false_positive, conf: m.confirmed, rate });
    }
    noisy.sort((a, b) => b.fp - a.fp);
    const top = noisy.slice(0, 3);
    if (top.length > 0) {
      const summary = top
        .map((n) => `\`${n.id}\` (${Math.round(n.rate * 100)}% confirm)`)
        .join(", ");
      lines.push(
        `**Top noise (≥3 sites, <50% confirm):** ${summary}`,
      );
    }
  }

  lines.push("");

  // ── Warnings ──────────────────────────────────────────────
  const warnings: string[] = [];
  if (vm === "skipped") {
    warnings.push(
      "Verifier was skipped — every candidate is reported without LLM filtering. The 'confirmed' bucket contains raw regex hits; treat counts as upper-bound noise.",
    );
  }
  if (cov?.truncated) {
    warnings.push(
      `Coverage truncated — only ${cov.scannedFiles} / ${cov.totalCandidateFiles} files scanned. Re-run with \`--max-files ${Math.min(cov.totalCandidateFiles, cov.maxFiles * 4)}\` for full coverage.`,
    );
  }
  // v2.10.394 — surface files that carried `kcode-disable: audit`. Without
  // this line the marker mechanism would silently exclude findings.
  // External audit P1.
  const disabled = cov?.auditDisabledFiles ?? [];
  if (disabled.length > 0) {
    warnings.push(
      `Audit-disabled: ${disabled.length} file(s) carried a \`kcode-disable: audit\` directive and were skipped from pattern matching. ` +
      `Files: ${disabled.slice(0, 3).map((f) => f.split("/").pop()).join(", ")}${disabled.length > 3 ? `, +${disabled.length - 3} more` : ""}.`,
    );
  }
  if (astStatus.some((s) => !s.loaded)) {
    warnings.push(
      "AST coverage degraded — at least one grammar failed to load. Run `kcode grammars install` and re-run the audit.",
    );
  }
  if (warnings.length > 0) {
    lines.push("**⚠ Warnings:**");
    for (const w of warnings) lines.push(`- ${w}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
}

function renderAstGrammarStatus(result: AuditResult, lines: string[]): void {
  const status = result.ast_grammar_status ?? [];
  if (status.length === 0) return;
  const missing = status.filter((s) => !s.loaded);
  if (missing.length === 0) return;

  lines.push("## AST coverage");
  lines.push("");
  lines.push(
    `> ⚠ AST patterns ran with degraded coverage: ${missing.length} language` +
      `${missing.length === 1 ? "" : "s"} could not load a tree-sitter grammar. ` +
      "Regex patterns above are unaffected; the engine just couldn't run the " +
      "deeper taint-aware queries for these languages.",
  );
  lines.push("");
  for (const s of missing) {
    const reason = s.last_error ? ` — ${s.last_error}` : "";
    lines.push(
      `- \`${s.language}\`: ${s.patterns_attempted} pattern${s.patterns_attempted === 1 ? "" : "s"} skipped${reason}`,
    );
  }
  lines.push("");
  lines.push("**Fix:** install the bundled grammars into `~/.kcode/grammars/`:");
  lines.push("");
  lines.push("```");
  lines.push("kcode grammars install");
  lines.push("```");
  lines.push("");
  lines.push(
    "Re-run the audit afterwards. `kcode grammars list` shows what this build ships with.",
  );
  lines.push("");
}

/**
 * v2.10.351 P0.9 — list reviewer-ignored findings. Rendered as a
 * dedicated section so a reader can see WHAT was set aside and WHY,
 * without those entries polluting severity / count / fix sections.
 *
 * Called from BOTH the "no actionable findings" early-return path
 * AND the main render path, so the section appears regardless of
 * whether anything else is left to commit.
 */
function renderIgnoredFindingsSection(
  ignored: Finding[],
  projectRoot: string,
  lines: string[],
): void {
  if (ignored.length === 0) return;
  lines.push("## Reviewer-ignored findings");
  lines.push("");
  lines.push(
    `${ignored.length} finding${ignored.length === 1 ? "" : "s"} ` +
      "tagged as ignored by the reviewer. These were excluded from /fix, /pr, " +
      "SARIF output, and the severity breakdown above.",
  );
  lines.push("");
  for (const f of ignored) {
    const rel = f.file.startsWith(projectRoot + "/")
      ? f.file.slice(projectRoot.length + 1)
      : f.file;
    const reason = f.review_reason ? ` — ${f.review_reason}` : "";
    const tags = f.review_tags && f.review_tags.length > 0
      ? ` [${f.review_tags.join(", ")}]`
      : "";
    lines.push(`- \`${rel}:${f.line}\` — ${f.pattern_id}${reason}${tags}`);
  }
  lines.push("");
}

function renderNeedsContextSection(result: AuditResult, lines: string[]): void {
  const details = result.needs_context_detail ?? [];
  if (details.length === 0) return;

  lines.push("## Needs context (undecided by verifier)");
  lines.push("");
  lines.push(
    `The verifier returned **${details.length}** candidate${details.length === 1 ? "" : "s"} ` +
      "as needs_context — either the model's response didn't parse into a clean " +
      "confirmed/false_positive verdict, or the model explicitly said it couldn't " +
      "decide. These deserve a second look with a stronger model " +
      "(`/scan` → escalate, or `kcode audit --fallback-model`).",
  );
  lines.push("");

  const shown = details.slice(0, FP_SAMPLE_LIMIT);
  for (let i = 0; i < shown.length; i++) {
    const fp = shown[i]!;
    const rel = fp.file.startsWith(result.project + "/")
      ? fp.file.slice(result.project.length + 1)
      : fp.file;
    lines.push(
      `${i + 1}. \`${rel}:${fp.line}\` — pattern \`${fp.pattern_id}\` (${fp.severity})`,
    );
    lines.push(`   - Reason: ${fp.verification.reasoning.slice(0, 400).replace(/\n/g, " ")}`);
  }
  if (details.length > shown.length) {
    lines.push("");
    lines.push(
      `_…and ${details.length - shown.length} more. See \`AUDIT_REPORT.json\`._`,
    );
  }
  lines.push("");
}

export function generateMarkdownReport(result: AuditResult): string {
  const lines: string[] = [];
  const projectName = result.project.split("/").filter(Boolean).pop() ?? result.project;

  lines.push(`# Audit Report — ${projectName}`);
  lines.push("");
  lines.push(`**Auditor:** Astrolexis.space — Kulvex Code`);
  lines.push(`**Date:** ${result.timestamp}`);
  lines.push(`**Project:** ${result.project}`);
  lines.push(`**Languages:** ${result.languages_detected.join(", ")}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // v2.10.351 P1 — Audit Confidence header up front. Tells the
  // reader at a glance how much of the project was covered, whether
  // the verifier ran, what the AST grammar state is, and which
  // patterns are noisy. Warnings (truncation, skip-verify, missing
  // grammars) appear inline so a skim catches them before the data.
  renderAuditConfidence(result, lines);

  // Coverage — always emitted so a user can tell "scanned everything"
  // apart from "scanned the first 500 in traversal order". Critical for
  // judging whether the verdict is representative of the whole codebase
  // or only a slice of it.
  const cov = result.coverage;
  if (cov) {
    lines.push("## Coverage");
    lines.push("");
    const truncLabel = cov.truncated
      ? `**yes** (${cov.skippedByLimit} file${cov.skippedByLimit === 1 ? "" : "s"} skipped by --max-files)`
      : "no";
    // v2.10.335 — when the run was a diff-based audit, render that
    // first so consumers don't read "10 of 1505 files" as a coverage
    // gap instead of a deliberate scope filter.
    const since = (cov as { since?: string }).since;
    const changedFilesInDiff = (cov as { changedFilesInDiff?: number }).changedFilesInDiff;
    if (since) {
      lines.push(`- **Mode:** diff-based audit since \`${since}\``);
      if (changedFilesInDiff !== undefined) {
        lines.push(`- Files changed in diff: ${changedFilesInDiff}`);
      }
    }
    lines.push(`- Files in project: **${cov.totalCandidateFiles}**`);
    lines.push(`- Files scanned: **${cov.scannedFiles}** (${Math.round((cov.scannedFiles / Math.max(cov.totalCandidateFiles, 1)) * 100)}%)`);
    lines.push(`- Truncated: ${truncLabel}`);
    // MAX_SAFE_INTEGER (or numbers larger than reasonable project sizes)
    // mean "unlimited" — render as such instead of an ugly 9-quadrillion.
    const capLabel =
      cov.maxFiles >= Number.MAX_SAFE_INTEGER / 2 || cov.maxFiles > 1_000_000
        ? "unlimited"
        : String(cov.maxFiles);
    lines.push(`- Max-files cap: ${capLabel} (${cov.capSource})`);
    if (cov.truncated) {
      const suggestion = Math.min(cov.totalCandidateFiles, cov.maxFiles * 4);
      lines.push("");
      lines.push(
        `> ⚠ This report covers only ${cov.scannedFiles}/${cov.totalCandidateFiles} source files. ` +
          `Findings below reflect the scanned subset, not the whole codebase. ` +
          `Re-run with \`--max-files ${suggestion}\` (or higher) for full coverage.`,
      );
    }
    lines.push("");
  }

  // v2.10.351 P0 — review_state is the source of truth for which
  // findings reach the actionable list. ignored / demoted_fp are
  // dropped from severity breakdown, sort, and per-finding sections;
  // they get a dedicated 'Reviewer-ignored' row in the summary so
  // the human reader can see WHY the actionable count differs from
  // result.confirmed_findings.
  const ignoredFindings = result.findings.filter((f) => f.review_state === "ignored");
  const actionableFindings = result.findings.filter(
    (f) => f.review_state !== "ignored" && f.review_state !== "demoted_fp",
  );

  // Executive summary
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Files scanned: **${result.files_scanned}**`);
  lines.push(`- Candidates found: **${result.candidates_found}**`);
  if (ignoredFindings.length > 0 || actionableFindings.length !== result.confirmed_findings) {
    lines.push(`- Confirmed findings: **${actionableFindings.length}** (of ${result.confirmed_findings} pre-review)`);
    if (ignoredFindings.length > 0) {
      lines.push(`- Reviewer-ignored: **${ignoredFindings.length}** (excluded from /fix, /pr, SARIF, severity breakdown)`);
    }
  } else {
    lines.push(`- Confirmed findings: **${result.confirmed_findings}**`);
  }
  lines.push(`- False positives: **${result.false_positives}**`);
  const needsCtx = result.needs_context ?? 0;
  if (needsCtx > 0) {
    lines.push(`- Uncertain (needs_context): **${needsCtx}** — verifier could not decide`);
  }
  lines.push(`- Scan duration: ${(result.elapsed_ms / 1000).toFixed(1)}s`);
  lines.push("");

  renderAstGrammarStatus(result, lines);

  if (actionableFindings.length === 0) {
    if (ignoredFindings.length > 0) {
      lines.push(
        `All ${result.confirmed_findings} confirmed finding(s) were tagged as ignored by the reviewer. ` +
          "Nothing to commit; see the JSON report for the full review trail.",
      );
    } else {
      lines.push("No confirmed findings. Either the code is clean for the checked patterns,");
      lines.push("or the pattern library needs expansion for this codebase's language/style.");
    }
    lines.push("");
    renderFalsePositiveSection(result, lines);
    renderNeedsContextSection(result, lines);
    renderPatternMetricsSection(result, lines);
    // v2.10.351 P0.9 — even when actionable is empty (e.g. all
    // findings tagged ignored), surface the ignored section so the
    // reader can still see what was set aside.
    renderIgnoredFindingsSection(ignoredFindings, result.project, lines);
    return lines.join("\n");
  }

  // Severity breakdown — counts the actionable bucket only.
  const bySev: Record<Severity, Finding[]> = {
    critical: [],
    high: [],
    medium: [],
    low: [],
  };
  for (const f of actionableFindings) bySev[f.severity].push(f);

  lines.push("### Severity breakdown");
  lines.push("");
  lines.push("| Severity | Count |");
  lines.push("|----------|-------|");
  for (const sev of ["critical", "high", "medium", "low"] as Severity[]) {
    if (bySev[sev].length > 0) {
      lines.push(`| ${SEVERITY_ICON[sev]} ${sev.toUpperCase()} | ${bySev[sev].length} |`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  // Sort findings: critical → low, then by file, then by line.
  // Iterate the actionable subset only — ignored / demoted_fp are
  // listed separately at the bottom for transparency.
  const sorted = [...actionableFindings].sort((a, b) => {
    const sevCmp = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevCmp !== 0) return sevCmp;
    const fileCmp = a.file.localeCompare(b.file);
    if (fileCmp !== 0) return fileCmp;
    return a.line - b.line;
  });

  lines.push("## Findings");
  lines.push("");

  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i]!;
    const pattern = getPatternById(f.pattern_id);
    const relPath = relative(result.project, f.file);
    const cwe = f.cwe ?? pattern?.cwe;

    lines.push(
      `### ${i + 1}. ${SEVERITY_ICON[f.severity]} ${f.pattern_title}${cwe ? ` — ${cwe}` : ""}`,
    );
    lines.push("");
    lines.push(`**File:** \`${relPath}:${f.line}\``);
    lines.push(`**Severity:** ${f.severity.toUpperCase()}`);
    lines.push(`**Pattern:** \`${f.pattern_id}\``);
    lines.push("");

    if (pattern?.explanation) {
      lines.push("**Why this matters:**");
      lines.push(pattern.explanation);
      lines.push("");
    }

    lines.push("**Code:**");
    lines.push("```cpp");
    lines.push(f.context);
    lines.push("```");
    lines.push("");

    if (f.verification.reasoning) {
      lines.push(`**Verification:** ${f.verification.reasoning}`);
      lines.push("");
    }

    // Evidence Pack (v2.10.361+). When the verifier emits structured
    // JSON we render each field as its own labeled block. Falls back
    // to the legacy single-string fields when evidence is absent.
    const ev = f.verification.evidence;
    if (ev?.input_boundary) {
      lines.push(`**Input boundary:** ${ev.input_boundary}`);
      lines.push("");
    }

    if (ev?.sink) {
      lines.push(`**Sink:** \`${ev.sink}\``);
      lines.push("");
    }

    if (ev?.execution_path_steps && ev.execution_path_steps.length > 0) {
      lines.push("**Execution path:**");
      ev.execution_path_steps.forEach((step, i) => {
        lines.push(`${i + 1}. ${step}`);
      });
      lines.push("");
    } else if (f.verification.execution_path) {
      lines.push(`**Execution path:** ${f.verification.execution_path}`);
      lines.push("");
    }

    if (ev?.sanitizers_checked && ev.sanitizers_checked.length > 0) {
      lines.push("**Sanitizers checked:**");
      for (const s of ev.sanitizers_checked) {
        lines.push(`- ${s}`);
      }
      lines.push("");
    }

    if (ev?.mitigations_found && ev.mitigations_found.length > 0) {
      lines.push("**Mitigations found:**");
      for (const m of ev.mitigations_found) {
        lines.push(`- ${m}`);
      }
      lines.push("");
    }

    const fixText = ev?.suggested_fix ?? f.verification.suggested_fix;
    if (fixText) {
      const strategy = ev?.suggested_fix_strategy
        ? ` (${ev.suggested_fix_strategy})`
        : "";
      lines.push(`**Suggested fix${strategy}:**`);
      lines.push("```");
      lines.push(fixText);
      lines.push("```");
      lines.push("");
    } else if (pattern?.fix_template) {
      lines.push(`**Fix template:** ${pattern.fix_template}`);
      lines.push("");
    }

    if (ev?.test_suggestion) {
      lines.push(`**Regression test:** ${ev.test_suggestion}`);
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  // Exploit Proofs section (if present)
  if (result.exploits && result.exploits.length > 0) {
    lines.push("## Exploit Proofs");
    lines.push("");
    lines.push(
      `${result.exploits.length} proof-of-concept exploit${result.exploits.length === 1 ? "" : "s"} ` +
        "generated for confirmed findings. These demonstrate exploitability — " +
        "**do not run against production systems**.",
    );
    lines.push("");

    for (let i = 0; i < result.exploits.length; i++) {
      const e = result.exploits[i]!;
      const rel = e.file.replace(result.project + "/", "");
      lines.push(`### Exploit ${i + 1}: ${e.pattern_id}`);
      lines.push("");
      lines.push(`**Target:** \`${rel}:${e.line}\``);
      if (e.cwe) lines.push(`**CWE:** ${e.cwe}`);
      lines.push("");
      lines.push("**Attack vector:**");
      lines.push(e.attack_vector);
      lines.push("");
      lines.push("**Payload:**");
      lines.push("```");
      lines.push(e.payload);
      lines.push("```");
      lines.push("");
      lines.push("**Expected result:**");
      lines.push(e.expected_result);
      lines.push("");
      lines.push("**Reproduction steps:**");
      for (const step of e.reproduction_steps) {
        lines.push(step);
      }
      lines.push("");
      lines.push(`**Severity justification:** ${e.severity_justification}`);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  // Always render a false-positive section when there are any, so the
  // human auditor can spot-check the verifier's rejections.
  renderFalsePositiveSection(result, lines);
  // And the needs_context bucket so "33 candidates / 0 confirmed /
  // 0 FP" can't hide 33 undecided results.
  renderNeedsContextSection(result, lines);
  // Reviewer-ignored section — see helper docstring. v2.10.351 P0.9.
  renderIgnoredFindingsSection(ignoredFindings, result.project, lines);
  // Pattern hit-rate breakdown — shows which patterns fired heavily
  // and which had high FP rates. v2.10.330.
  renderPatternMetricsSection(result, lines);

  // Methodology footer
  lines.push("## Methodology");
  lines.push("");
  lines.push(
    "This audit was produced by the KCode audit engine: a deterministic pattern " +
      "library scanned the project for known-dangerous code patterns, then every " +
      "candidate was verified against the actual execution path. Findings listed " +
      "here are only those where the execution path was confirmed.",
  );
  if (result.exploits && result.exploits.length > 0) {
    lines.push(
      " Confirmed findings were then processed by the exploit-gen module, " +
        "which generates proof-of-concept payloads to demonstrate real-world " +
        "exploitability.",
    );
  }
  lines.push("");
  lines.push(
    "**Pattern library version:** 1.0 — patterns derived from real bugs found " +
      "in production C/C++ codebases (network I/O, USB/HID decoders, resource " +
      "lifecycle, integer arithmetic).",
  );
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("*Generated by KCode — [Astrolexis.space](https://astrolexis.dev)*");
  lines.push("");

  return lines.join("\n");
}
