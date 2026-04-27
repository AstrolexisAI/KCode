// SARIF v2.1.0 exporter for the audit engine.
//
// SARIF (Static Analysis Results Interchange Format, OASIS standard)
// is the canonical format for security-scanner output in enterprise
// pipelines. GitHub Advanced Security / Azure DevOps / SonarQube /
// Snyk all speak it. Emitting SARIF is the single-biggest unlock
// for KCode's enterprise adoption — without it, a CISO doing a
// pipeline eval can't plug KCode into their existing workflow.
//
// Spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html
// Schema: https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json

import { createHash } from "node:crypto";
import { getPatternById } from "./patterns";
import type { AuditResult, Finding, Severity } from "./types";

const SARIF_SCHEMA =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";
const SARIF_VERSION = "2.1.0";

/** SARIF severity levels. Tool output maps KCode severities below. */
type SarifLevel = "error" | "warning" | "note" | "none";

/**
 * Map KCode's 4-level severity to SARIF's 3-level. Critical + high
 * both become "error" because SARIF has no equivalent escalation
 * and enterprise dashboards treat "error" as "block merge". Medium
 * is "warning" (surface but don't block). Low is "note" (advisory).
 */
function severityToSarif(s: Severity): SarifLevel {
  switch (s) {
    case "critical":
    case "high":
      return "error";
    case "medium":
      return "warning";
    case "low":
      return "note";
  }
}

/**
 * Stable, content-addressable fingerprint for a finding. GitHub and
 * other SARIF consumers use fingerprints to deduplicate findings
 * across commits ("this is the same bug we saw on main") and to
 * track fix/regression. Must be deterministic across identical
 * findings, stable across unrelated code movement, unique per
 * pattern+file+match-line.
 */
function fingerprintFinding(f: Finding): string {
  const material = [f.pattern_id, f.file, f.line, f.matched_text.trim()].join("\x1f");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/**
 * Build the SARIF `rules` array — one entry per pattern referenced
 * by at least one finding. Each rule has a stable id, a short and
 * full description, the CWE (if any), and the recommended severity.
 */
function buildRules(findings: Finding[]): unknown[] {
  const patternIds = new Set(findings.map((f) => f.pattern_id));
  const rules: unknown[] = [];
  for (const id of patternIds) {
    const pattern = getPatternById(id);
    if (!pattern) continue;
    const tags: string[] = ["security"];
    if (pattern.cwe) tags.push(pattern.cwe);
    rules.push({
      id: pattern.id,
      name: pattern.id.replace(/-/g, "_"),
      shortDescription: { text: pattern.title },
      fullDescription: { text: pattern.explanation },
      defaultConfiguration: { level: severityToSarif(pattern.severity) },
      helpUri: pattern.cwe
        ? `https://cwe.mitre.org/data/definitions/${pattern.cwe.replace(/^CWE-/, "")}.html`
        : undefined,
      help: {
        text: pattern.fix_template,
        markdown: `**Fix:** ${pattern.fix_template}`,
      },
      properties: {
        tags,
        ...(pattern.cwe ? { cwe: pattern.cwe } : {}),
        "security-severity": scoreFromSeverity(pattern.severity),
      },
    });
  }
  return rules;
}

/**
 * CVSS-ish score (0-10) so GitHub's "security-severity" filter can
 * rank findings. SARIF doesn't prescribe a formula — we pick
 * numbers that bucket cleanly for GitHub code scanning alerts.
 */
function scoreFromSeverity(s: Severity): string {
  switch (s) {
    case "critical":
      return "9.0";
    case "high":
      return "7.5";
    case "medium":
      return "5.0";
    case "low":
      return "3.0";
  }
}

/**
 * Convert a single finding to SARIF result format. Uses the finding's
 * file path as a relative URI; enterprise consumers expect project-
 * relative paths for their "open in editor" links to work.
 */
function buildResult(finding: Finding, projectRoot: string): unknown {
  const relPath = relativize(finding.file, projectRoot);
  const ev = finding.verification.evidence;
  const reasoning = finding.verification.reasoning
    ? `\n\nVerifier: ${finding.verification.reasoning}`
    : "";
  // Surface the structured evidence inline in the SARIF message so
  // GH Code Scanning UI shows it without requiring a property
  // sidecar most viewers don't render.
  const sink = ev?.sink ? `\n\nSink: ${ev.sink}` : "";
  const boundary = ev?.input_boundary ? `\n\nInput boundary: ${ev.input_boundary}` : "";
  const path =
    ev?.execution_path_steps && ev.execution_path_steps.length > 0
      ? `\n\nExecution path:\n${ev.execution_path_steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
      : "";
  const fixText = ev?.suggested_fix ?? finding.verification.suggested_fix;
  const fix = fixText ? `\n\nSuggested fix: ${fixText}` : "";
  return {
    ruleId: finding.pattern_id,
    level: severityToSarif(finding.severity),
    message: {
      text: `${finding.pattern_title}${reasoning}${sink}${boundary}${path}${fix}`,
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: relPath },
          region: {
            startLine: finding.line,
            snippet: { text: finding.matched_text.slice(0, 200) },
          },
        },
      },
    ],
    partialFingerprints: {
      primaryLocationLineHash: fingerprintFinding(finding),
    },
  };
}

function relativize(filePath: string, projectRoot: string): string {
  // Normalize both to forward slashes (SARIF URIs are always forward-slash).
  const normalizedRoot = projectRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedFile = filePath.replace(/\\/g, "/");
  if (normalizedFile.startsWith(normalizedRoot + "/")) {
    return normalizedFile.slice(normalizedRoot.length + 1);
  }
  // Absolute path that doesn't live under the project root — fall
  // back to the basename so enterprise consumers don't choke on
  // invalid relative URIs.
  return normalizedFile.split("/").at(-1) ?? normalizedFile;
}

export interface BuildSarifOptions {
  /** KCode version string to embed under tool.driver.version. */
  toolVersion: string;
  /** Absolute path to the project root so result URIs can be made relative. */
  projectRoot: string;
}

/**
 * Convert an AuditResult into a SARIF v2.1.0 document. The output
 * is JSON-serializable with JSON.stringify — no dates, no functions,
 * no circular refs — so callers can write it with Bun.write(path,
 * JSON.stringify(sarif, null, 2)) and be done.
 */
export function buildSarif(audit: AuditResult, opts: BuildSarifOptions): unknown {
  // v2.10.351 P0 — SARIF results respect review_state. A finding
  // tagged 'ignored' by the human reviewer must not surface in
  // GitHub Code Scanning, IDE problem lists, or any other SARIF
  // consumer. demoted_fp is also excluded defensively even though
  // persist() should have moved them out of audit.findings already.
  // promoted, confirmed, and undefined all flow through normally.
  const actionable = audit.findings.filter(
    (f) => f.review_state !== "ignored" && f.review_state !== "demoted_fp",
  );
  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: "KCode",
            version: opts.toolVersion,
            informationUri: "https://github.com/AstrolexisAI/KCode",
            semanticVersion: opts.toolVersion,
            rules: buildRules(actionable),
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            endTimeUtc: audit.timestamp,
          },
        ],
        results: actionable.map((f) => buildResult(f, opts.projectRoot)),
        // SARIF-specific column: language hints used by consumers to
        // default which rule packs apply to which files.
        properties: {
          languagesDetected: audit.languages_detected,
          filesScanned: audit.files_scanned,
          candidatesFound: audit.candidates_found,
          falsePositives: audit.false_positives,
        },
      },
    ],
  };
}

export {
  fingerprintFinding,
  relativize,
  scoreFromSeverity,
  // Re-exports for unit testing the helpers directly.
  severityToSarif,
};
