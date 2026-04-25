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
  lines.push("| Pattern | Hits | Confirmed | FP | needs_context | confirmed_rate |");
  lines.push("|---------|-----:|----------:|---:|---:|---------------:|");
  for (const [pid, m] of top) {
    const rate = m.confirmed_rate !== undefined
      ? `${(m.confirmed_rate * 100).toFixed(0)}%`
      : "—";
    lines.push(
      `| \`${pid}\` | ${m.hits} | ${m.confirmed} | ${m.false_positive} | ${m.needs_context} | ${rate} |`,
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

  // Executive summary
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Files scanned: **${result.files_scanned}**`);
  lines.push(`- Candidates found: **${result.candidates_found}**`);
  lines.push(`- Confirmed findings: **${result.confirmed_findings}**`);
  lines.push(`- False positives: **${result.false_positives}**`);
  const needsCtx = result.needs_context ?? 0;
  if (needsCtx > 0) {
    lines.push(`- Uncertain (needs_context): **${needsCtx}** — verifier could not decide`);
  }
  lines.push(`- Scan duration: ${(result.elapsed_ms / 1000).toFixed(1)}s`);
  lines.push("");

  if (result.findings.length === 0) {
    lines.push("No confirmed findings. Either the code is clean for the checked patterns,");
    lines.push("or the pattern library needs expansion for this codebase's language/style.");
    lines.push("");
    renderFalsePositiveSection(result, lines);
    renderNeedsContextSection(result, lines);
    renderPatternMetricsSection(result, lines);
    return lines.join("\n");
  }

  // Severity breakdown
  const bySev: Record<Severity, Finding[]> = {
    critical: [],
    high: [],
    medium: [],
    low: [],
  };
  for (const f of result.findings) bySev[f.severity].push(f);

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

  // Sort findings: critical → low, then by file, then by line
  const sorted = [...result.findings].sort((a, b) => {
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

    if (f.verification.execution_path) {
      lines.push(`**Execution path:** ${f.verification.execution_path}`);
      lines.push("");
    }

    if (f.verification.suggested_fix) {
      lines.push("**Suggested fix:**");
      lines.push("```");
      lines.push(f.verification.suggested_fix);
      lines.push("```");
      lines.push("");
    } else if (pattern?.fix_template) {
      lines.push(`**Fix template:** ${pattern.fix_template}`);
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
