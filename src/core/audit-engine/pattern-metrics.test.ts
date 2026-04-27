// KCode - Tests for v2.10.330 pattern metrics (Sprint 5/6).

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runAudit } from "./audit-engine";
import { generateMarkdownReport } from "./report-generator";
import type { AuditResult } from "./types";

let TMP: string;
beforeEach(() => {
  TMP = `/tmp/kcode-pat-metrics-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(TMP, { recursive: true });
});
afterEach(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

function w(rel: string, content: string): void {
  const full = join(TMP, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe("pattern_metrics", () => {
  it("populates hits / unique_sites / confirmed / false_positive / needs_context", async () => {
    w("a.c", `void f(const char* src) { char buf[16]; strcpy(buf, src); }\n`);
    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
    });
    expect(result.pattern_metrics).toBeDefined();
    const ids = Object.keys(result.pattern_metrics ?? {});
    expect(ids.length).toBeGreaterThan(0);
    // v2.10.331 audit fix: the unique_sites total must equal the
    // verdict counts, not hits. hits ≥ unique_sites since multiples
    // of the same pattern in the same file are deduped before
    // verification but still count as hits.
    for (const m of Object.values(result.pattern_metrics ?? {})) {
      const verdictTotal = m.confirmed + m.false_positive + m.needs_context;
      expect((m as { unique_sites?: number }).unique_sites ?? m.hits).toBe(verdictTotal);
      expect(m.hits).toBeGreaterThanOrEqual(verdictTotal);
    }
  });

  it("unique_sites = matches on distinct lines (site-level dedupe, v2.10.389)", async () => {
    // Three strcpy calls on three distinct lines → 3 verifier sites
    // (one per line), 3 hits. Prior to v2.10.389 (P1.1) all three
    // collapsed into one verifier site under (pattern, file) keying;
    // we now keep them distinct because each is a genuinely separate
    // bug worth verifying.
    w(
      "multi.c",
      `void f(const char* a, const char* b, const char* c) {
  char x[16]; char y[16]; char z[16];
  strcpy(x, a);
  strcpy(y, b);
  strcpy(z, c);
}
`,
    );
    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
    });
    const m = (result.pattern_metrics ?? {})["cpp-006-strcpy-family"];
    if (m) {
      // With site-level dedupe each distinct line is its own verifier
      // call, so unique_sites equals the number of matched lines.
      expect((m as { unique_sites?: number }).unique_sites).toBe(3);
      expect(m.hits).toBeGreaterThanOrEqual(3);
    }
  });

  it("confirmed_rate uses unique_sites as denominator (v2.10.331 audit fix)", async () => {
    // Same multi-match scenario — verifier confirms the single site.
    // Rate must be 1.0 (100%), not 0.33 (1/3).
    w(
      "rate.c",
      `void f(const char* a, const char* b, const char* c) {
  char x[16]; char y[16]; char z[16];
  strcpy(x, a);
  strcpy(y, b);
  strcpy(z, c);
}
`,
    );
    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
    });
    const m = (result.pattern_metrics ?? {})["cpp-006-strcpy-family"];
    if (m) {
      expect(m.confirmed_rate).toBe(1);
    }
  });

  it("computes confirmed_rate when hits > 0", async () => {
    w("a.c", `void f(const char* src) { char buf[16]; strcpy(buf, src); }\n`);
    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
    });
    for (const [, m] of Object.entries(result.pattern_metrics ?? {})) {
      if (m.hits === 0) continue;
      expect(m.confirmed_rate).toBeDefined();
      expect(m.confirmed_rate).toBeGreaterThanOrEqual(0);
      expect(m.confirmed_rate).toBeLessThanOrEqual(1);
    }
  });

  it("omits patterns that never matched (vs. emitting hits=0)", async () => {
    w("clean.c", "int main(void) { return 0; }\n");
    const result = await runAudit({
      projectRoot: TMP,
      llmCallback: async () => JSON.stringify({verdict:"confirmed",reasoning:"test",evidence:{sink:"test"}}),
    });
    // Without any pattern matches, pattern_metrics should be empty.
    // (Some patterns may still fire on innocuous code; the assertion
    // is that whatever IS in the map has hits > 0.)
    for (const [, m] of Object.entries(result.pattern_metrics ?? {})) {
      expect(m.hits).toBeGreaterThan(0);
    }
  });
});

describe("renderPatternMetricsSection", () => {
  function makeResult(): AuditResult {
    // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
    return {
      project: "/repo",
      timestamp: "2026-04-25",
      languages_detected: ["c"],
      files_scanned: 5,
      candidates_found: 12,
      confirmed_findings: 1,
      false_positives: 8,
      findings: [
        {
          pattern_id: "fsw-010-cmd-arg-before-validate",
          pattern_title: "Cmd arg unvalidated",
          severity: "high",
          file: "/repo/x.cpp",
          line: 1,
          matched_text: "",
          context: "",
          verification: { verdict: "confirmed", reasoning: "x" },
          // biome-ignore lint/suspicious/noExplicitAny: optional
        } as any,
      ],
      false_positives_detail: [],
      needs_context: 3,
      needs_context_detail: [],
      coverage: {
        totalCandidateFiles: 5,
        scannedFiles: 5,
        skippedByLimit: 0,
        truncated: false,
        maxFiles: 500,
        capSource: "adaptive",
      },
      pattern_metrics: {
        "fsw-010-cmd-arg-before-validate": {
          hits: 1,
          confirmed: 1,
          false_positive: 0,
          needs_context: 0,
          confirmed_rate: 1,
          false_positive_rate: 0,
        },
        "cpp-012-loop-unvalidated-bound": {
          hits: 8,
          confirmed: 0,
          false_positive: 7,
          needs_context: 1,
          confirmed_rate: 0,
          false_positive_rate: 0.875,
        },
        "fsw-005-buffer-getdata-unchecked": {
          hits: 3,
          confirmed: 0,
          false_positive: 1,
          needs_context: 2,
          confirmed_rate: 0,
          false_positive_rate: 0.333,
        },
      },
      elapsed_ms: 1234,
      // biome-ignore lint/suspicious/noExplicitAny: type cast
    } as any;
  }

  it("renders the metrics table sorted by hit count desc", () => {
    const md = generateMarkdownReport(makeResult());
    expect(md).toContain("## Pattern hit-rate");
    // cpp-012 has 8 hits → must come before fsw-005 (3 hits) in table.
    const cppIdx = md.indexOf("cpp-012-loop-unvalidated-bound");
    const fswIdx = md.indexOf("fsw-005-buffer-getdata-unchecked");
    expect(cppIdx).toBeGreaterThan(0);
    expect(fswIdx).toBeGreaterThan(0);
    expect(cppIdx).toBeLessThan(fswIdx);
  });

  it("formats confirmed_rate as a percentage", () => {
    const md = generateMarkdownReport(makeResult());
    expect(md).toContain("100%"); // fsw-010 with 1/1
    expect(md).toContain("0%");   // cpp-012 with 0/8
  });

  it("omits the section when pattern_metrics is empty", () => {
    const r = makeResult();
    r.pattern_metrics = {};
    const md = generateMarkdownReport(r);
    expect(md).not.toContain("## Pattern hit-rate");
  });
});
