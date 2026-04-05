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

  // Executive summary
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Files scanned: **${result.files_scanned}**`);
  lines.push(`- Candidates found: **${result.candidates_found}**`);
  lines.push(`- Confirmed findings: **${result.confirmed_findings}**`);
  lines.push(`- False positives: **${result.false_positives}**`);
  lines.push(`- Scan duration: ${(result.elapsed_ms / 1000).toFixed(1)}s`);
  lines.push("");

  if (result.findings.length === 0) {
    lines.push("No confirmed findings. Either the code is clean for the checked patterns,");
    lines.push("or the pattern library needs expansion for this codebase's language/style.");
    lines.push("");
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

  // Methodology footer
  lines.push("## Methodology");
  lines.push("");
  lines.push(
    "This audit was produced by the KCode audit engine: a deterministic pattern " +
      "library scanned the project for known-dangerous code patterns, then every " +
      "candidate was verified against the actual execution path. Findings listed " +
      "here are only those where the execution path was confirmed.",
  );
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
