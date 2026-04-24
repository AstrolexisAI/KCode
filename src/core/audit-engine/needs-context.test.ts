// Tests for v310 needs_context bucket accounting.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runAudit } from "./audit-engine";
import { generateMarkdownReport } from "./report-generator";

let TMP: string;
beforeEach(() => {
  TMP = `/tmp/kcode-needs-ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(TMP, { recursive: true });
});
afterEach(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

function w(relpath: string, content: string): void {
  const full = join(TMP, relpath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe("needs_context bucket", () => {
  it("populates needs_context + detail when verdict doesn't parse", async () => {
    // memset sizeof(ptr) — known to match a pattern.
    w(
      "bug.c",
      `#include <string.h>
void f(char *p) {
    memset(p, 0, sizeof(p));
}
`,
    );
    // Verifier that returns text with NO verdict: line → parses to needs_context.
    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: async () => "I'm not sure about this one.",
    });
    if (result.candidates_found > 0) {
      expect(result.needs_context).toBeGreaterThan(0);
      expect(result.needs_context_detail.length).toBe(result.needs_context);
      expect(result.confirmed_findings + result.false_positives + result.needs_context).toBe(
        result.candidates_found,
      );
      const first = result.needs_context_detail[0]!;
      expect(first.pattern_id).toBeTruthy();
      expect(first.file).toBeTruthy();
      expect(first.verification.verdict).toBe("needs_context");
    }
  });

  it("arithmetic always holds: candidates = confirmed + fp + needs_context", async () => {
    w("a.c", "int a = 0;\n");
    w("b.c", "int b = 0;\n");
    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: async () =>
        "VERDICT: confirmed\nREASONING: test\n",
    });
    expect(
      result.confirmed_findings + result.false_positives + result.needs_context,
    ).toBe(result.candidates_found);
  });

  it("renders a 'Needs context' section when count > 0", () => {
    const md = generateMarkdownReport({
      project: "/repo",
      timestamp: "2026-04-24",
      languages_detected: ["c"],
      files_scanned: 5,
      candidates_found: 3,
      confirmed_findings: 0,
      false_positives: 0,
      findings: [],
      false_positives_detail: [],
      needs_context: 3,
      needs_context_detail: [
        {
          pattern_id: "p1",
          pattern_title: "Test pattern",
          severity: "medium",
          file: "/repo/src/a.c",
          line: 10,
          matched_text: "x",
          context: "ctx",
          verification: {
            verdict: "needs_context",
            reasoning: "Model returned no parseable verdict.",
          },
        },
        {
          pattern_id: "p2",
          pattern_title: "Test pattern",
          severity: "medium",
          file: "/repo/src/b.c",
          line: 20,
          matched_text: "y",
          context: "ctx",
          verification: {
            verdict: "needs_context",
            reasoning: "Model uncertain.",
          },
        },
        {
          pattern_id: "p3",
          pattern_title: "Test pattern",
          severity: "high",
          file: "/repo/src/c.c",
          line: 30,
          matched_text: "z",
          context: "ctx",
          verification: {
            verdict: "needs_context",
            reasoning: "No verdict line in response.",
          },
        },
      ],
      coverage: {
        totalCandidateFiles: 5,
        scannedFiles: 5,
        skippedByLimit: 0,
        truncated: false,
        maxFiles: 500,
        capSource: "adaptive",
      },
      elapsed_ms: 100,
    });
    expect(md).toContain("## Needs context");
    expect(md).toContain("3");
    expect(md).toContain("src/a.c:10");
    expect(md).toContain("Uncertain (needs_context)");
  });

  it("omits Needs context section when count is 0", () => {
    const md = generateMarkdownReport({
      project: "/repo",
      timestamp: "2026-04-24",
      languages_detected: ["c"],
      files_scanned: 5,
      candidates_found: 0,
      confirmed_findings: 0,
      false_positives: 0,
      findings: [],
      false_positives_detail: [],
      needs_context: 0,
      needs_context_detail: [],
      coverage: {
        totalCandidateFiles: 5,
        scannedFiles: 5,
        skippedByLimit: 0,
        truncated: false,
        maxFiles: 500,
        capSource: "adaptive",
      },
      elapsed_ms: 100,
    });
    expect(md).not.toContain("## Needs context");
    expect(md).not.toContain("Uncertain (needs_context)");
  });
});
