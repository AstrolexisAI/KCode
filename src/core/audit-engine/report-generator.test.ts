// Tests for the Evidence Pack rendering added in F3.5 (v2.10.361).
// Verifies the Markdown report uses structured evidence fields when
// present and falls back cleanly to legacy single-string fields when
// they're not.

import { describe, expect, test } from "bun:test";
import type { AuditResult, Finding, Severity } from "./types";
import { generateMarkdownReport } from "./report-generator";

function makeFinding(over: Partial<Finding> = {}): Finding {
  const base: Finding = {
    pattern_id: "js-001-eval",
    pattern_title: "Use of eval()",
    severity: "high" as Severity,
    file: "/proj/src/x.js",
    line: 42,
    matched_text: "eval(userInput)",
    context: "eval(userInput);",
    verification: {
      verdict: "confirmed",
      reasoning: "User input flows directly into eval.",
    },
  };
  return { ...base, ...over };
}

function makeResult(findings: Finding[]): AuditResult {
  return {
    project: "/proj",
    timestamp: new Date().toISOString(),
    languages_detected: ["javascript"],
    files_scanned: 1,
    candidates_found: findings.length,
    confirmed_findings: findings.length,
    false_positives: 0,
    findings,
    false_positives_detail: [],
    needs_context: 0,
    needs_context_detail: [],
    coverage: {
      totalCandidateFiles: 1,
      scannedFiles: 1,
      skippedByLimit: 0,
      truncated: false,
      maxFiles: 100,
      capSource: "adaptive",
    },
    elapsed_ms: 1234,
  };
}

describe("generateMarkdownReport — Evidence Pack rendering", () => {
  test("renders sink, input_boundary, execution_path_steps, mitigations from evidence", () => {
    const result = makeResult([
      makeFinding({
        verification: {
          verdict: "confirmed",
          reasoning: "User input flows directly into eval.",
          evidence: {
            sink: "eval()",
            input_boundary: "HTTP POST body",
            execution_path_steps: [
              "express route /api/run (server.js:12)",
              "controller.handleRun (controller.js:25)",
              "eval(req.body.code) (controller.js:28)",
            ],
            sanitizers_checked: ["JSON.parse type guard", "regex allowlist"],
            mitigations_found: [],
            suggested_fix_strategy: "rewrite",
            suggested_fix: "Use a sandboxed JS interpreter or remove eval",
            test_suggestion: "POST /api/run with body { code: 'process.exit(1)' } and assert 400",
          },
        },
      }),
    ]);

    const md = generateMarkdownReport(result);

    expect(md).toContain("**Sink:** `eval()`");
    expect(md).toContain("**Input boundary:** HTTP POST body");
    expect(md).toContain("**Execution path:**");
    expect(md).toContain("1. express route /api/run (server.js:12)");
    expect(md).toContain("2. controller.handleRun (controller.js:25)");
    expect(md).toContain("3. eval(req.body.code) (controller.js:28)");
    expect(md).toContain("**Sanitizers checked:**");
    expect(md).toContain("- JSON.parse type guard");
    expect(md).toContain("**Suggested fix (rewrite):**");
    expect(md).toContain("Use a sandboxed JS interpreter");
    expect(md).toContain("**Regression test:**");
    expect(md).toContain("POST /api/run with body");
  });

  test("renders mitigations_found when present (false_positive case)", () => {
    const result = makeResult([
      makeFinding({
        verification: {
          verdict: "confirmed",
          reasoning: "Originally suspected; mitigations found upstream.",
          evidence: {
            sink: "memcpy",
            mitigations_found: [
              "caller validates `len <= sizeof(dst)` at line 22",
              "static_assert(sizeof(dst) >= MAX_LEN) at line 5",
            ],
          },
        },
      }),
    ]);

    const md = generateMarkdownReport(result);

    expect(md).toContain("**Mitigations found:**");
    expect(md).toContain("- caller validates `len <= sizeof(dst)` at line 22");
    expect(md).toContain("- static_assert");
  });

  test("falls back to legacy execution_path string when steps not present", () => {
    const result = makeResult([
      makeFinding({
        verification: {
          verdict: "confirmed",
          reasoning: "real bug",
          execution_path: "callerA → callerB → sink",
          // no evidence block
        },
      }),
    ]);

    const md = generateMarkdownReport(result);

    expect(md).toContain("**Execution path:** callerA → callerB → sink");
    // No structured "1. callerA" numbered list
    expect(md).not.toContain("1. callerA");
  });

  test("falls back to legacy suggested_fix when evidence absent", () => {
    const result = makeResult([
      makeFinding({
        verification: {
          verdict: "confirmed",
          reasoning: "real bug",
          suggested_fix: "Use parameterized query.",
        },
      }),
    ]);

    const md = generateMarkdownReport(result);

    expect(md).toContain("Use parameterized query.");
    // No strategy parenthetical when evidence is absent
    expect(md).not.toContain("**Suggested fix (");
  });

  test("does not render evidence sections when verification has no evidence", () => {
    const result = makeResult([
      makeFinding({
        verification: {
          verdict: "confirmed",
          reasoning: "minimal verdict",
        },
      }),
    ]);

    const md = generateMarkdownReport(result);

    expect(md).not.toContain("**Sink:**");
    expect(md).not.toContain("**Input boundary:**");
    expect(md).not.toContain("**Sanitizers checked:**");
    expect(md).not.toContain("**Mitigations found:**");
    expect(md).not.toContain("**Regression test:**");
  });

  test("evidence with only sink renders just the sink line", () => {
    const result = makeResult([
      makeFinding({
        verification: {
          verdict: "false_positive",
          reasoning: "test path",
          evidence: { sink: "memcpy" },
        },
      }),
    ]);

    const md = generateMarkdownReport(result);

    expect(md).toContain("**Sink:** `memcpy`");
    expect(md).not.toContain("**Input boundary:**");
    expect(md).not.toContain("**Execution path:**");
    expect(md).not.toContain("**Mitigations found:**");
  });
});
