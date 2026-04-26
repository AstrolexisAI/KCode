// Tests for the F2 (v2.10.362) Audit Confidence scorer.
// Each subscore exercised independently; aggregate verified for the
// common shapes (clean run, --skip-verify, truncated coverage,
// degraded AST, noisy FPs, no fixability data).

import { describe, expect, test } from "bun:test";
import { computeAuditConfidence } from "./confidence-scorer";
import type {
  AuditResult,
  FalsePositiveDetail,
  Finding,
  Severity,
} from "./types";

function makeFinding(over: Partial<Finding> = {}): Finding {
  const base: Finding = {
    pattern_id: "js-001-eval",
    pattern_title: "Use of eval()",
    severity: "high" as Severity,
    file: "/proj/x.js",
    line: 1,
    matched_text: "eval(x)",
    context: "eval(x)",
    verification: {
      verdict: "confirmed",
      reasoning: "real bug",
      evidence: { sink: "eval", suggested_fix_strategy: "rewrite" },
    },
  };
  return { ...base, ...over };
}

function makeFp(over: Partial<FalsePositiveDetail> = {}): FalsePositiveDetail {
  const base: FalsePositiveDetail = {
    pattern_id: "js-001-eval",
    pattern_title: "Use of eval()",
    severity: "high" as Severity,
    file: "/proj/x.js",
    line: 1,
    matched_text: "eval(x)",
    context: "eval(x)",
    verification: {
      verdict: "false_positive",
      reasoning: "test path",
      evidence: { sink: "eval", mitigations_found: ["test path filter at line 22"] },
    },
  };
  return { ...base, ...over };
}

function makeResult(over: Partial<AuditResult> = {}): AuditResult {
  const base: AuditResult = {
    project: "/proj",
    timestamp: new Date().toISOString(),
    languages_detected: ["javascript"],
    files_scanned: 100,
    candidates_found: 0,
    confirmed_findings: 0,
    false_positives: 0,
    findings: [],
    false_positives_detail: [],
    needs_context: 0,
    needs_context_detail: [],
    coverage: {
      totalCandidateFiles: 100,
      scannedFiles: 100,
      skippedByLimit: 0,
      truncated: false,
      maxFiles: 100,
      capSource: "adaptive",
    },
    elapsed_ms: 1000,
    verification_mode: "verified",
  };
  return { ...base, ...over };
}

describe("coverage_score", () => {
  test("100 when scannedFiles == totalCandidateFiles", () => {
    const c = computeAuditConfidence(makeResult());
    expect(c.coverage_score).toBe(100);
  });

  test("partial when truncated, plus warning", () => {
    const c = computeAuditConfidence(
      makeResult({
        coverage: {
          totalCandidateFiles: 1000,
          scannedFiles: 250,
          skippedByLimit: 750,
          truncated: true,
          maxFiles: 250,
          capSource: "user",
        },
      }),
    );
    expect(c.coverage_score).toBe(25);
    expect(c.warnings.some((w) => w.includes("truncated"))).toBe(true);
  });

  test("100 for diff-based scans (since: ...), regardless of file count ratio", () => {
    const c = computeAuditConfidence(
      makeResult({
        coverage: {
          totalCandidateFiles: 1000,
          scannedFiles: 12,
          skippedByLimit: 988,
          truncated: false,
          maxFiles: 1000,
          capSource: "adaptive",
          since: "origin/main",
        } as never,
      }),
    );
    expect(c.coverage_score).toBe(100);
  });
});

describe("verifier_score", () => {
  test("100 with no verifications (no candidates)", () => {
    const c = computeAuditConfidence(makeResult());
    expect(c.verifier_score).toBe(100);
  });

  test("100 when all verifications are clean", () => {
    const c = computeAuditConfidence(
      makeResult({
        findings: [makeFinding(), makeFinding()],
        confirmed_findings: 2,
      }),
    );
    expect(c.verifier_score).toBe(100);
  });

  test("partial when some verifications degraded with [verifier output unparseable]", () => {
    const degraded = makeFinding({
      verification: { verdict: "needs_context", reasoning: "[verifier output unparseable] junk" },
    });
    const clean = makeFinding();
    const c = computeAuditConfidence(
      makeResult({
        findings: [clean, clean, degraded, degraded],
        confirmed_findings: 2,
        needs_context: 2,
      }),
    );
    expect(c.verifier_score).toBe(50);
  });

  test("null when verification_mode is skipped", () => {
    const c = computeAuditConfidence(
      makeResult({ verification_mode: "skipped" }),
    );
    expect(c.verifier_score).toBeNull();
    expect(c.warnings.some((w) => w.includes("skipped"))).toBe(true);
  });
});

describe("ast_score", () => {
  test("100 when no AST patterns ran", () => {
    const c = computeAuditConfidence(makeResult());
    expect(c.ast_score).toBe(100);
  });

  test("100 when all grammars loaded", () => {
    const c = computeAuditConfidence(
      makeResult({
        ast_grammar_status: [
          { language: "javascript", patterns_attempted: 3, loaded: true },
          { language: "python", patterns_attempted: 2, loaded: true },
        ],
      }),
    );
    expect(c.ast_score).toBe(100);
  });

  test("partial with degraded grammar + warning", () => {
    const c = computeAuditConfidence(
      makeResult({
        ast_grammar_status: [
          { language: "javascript", patterns_attempted: 3, loaded: true },
          { language: "php", patterns_attempted: 2, loaded: false, last_error: "wasm not found" },
        ],
      }),
    );
    expect(c.ast_score).toBe(50);
    expect(c.warnings.some((w) => w.includes("php"))).toBe(true);
  });
});

describe("noise_score", () => {
  test("100 with no false_positives", () => {
    const c = computeAuditConfidence(makeResult());
    expect(c.noise_score).toBe(100);
  });

  test("100 when every FP carries mitigations_found", () => {
    const c = computeAuditConfidence(
      makeResult({
        false_positives: 3,
        false_positives_detail: [makeFp(), makeFp(), makeFp()],
      }),
    );
    expect(c.noise_score).toBe(100);
  });

  test("partial when some FPs have no mitigations + warning when below 50%", () => {
    const empty = makeFp({
      verification: { verdict: "false_positive", reasoning: "looks safe", evidence: { sink: "x" } },
    });
    const justified = makeFp();
    const c = computeAuditConfidence(
      makeResult({
        false_positives: 4,
        false_positives_detail: [empty, empty, empty, justified],
      }),
    );
    expect(c.noise_score).toBe(25);
    expect(c.warnings.some((w) => w.includes("mitigation"))).toBe(true);
  });

  test("null when verifier was skipped", () => {
    const c = computeAuditConfidence(
      makeResult({ verification_mode: "skipped" }),
    );
    expect(c.noise_score).toBeNull();
  });
});

describe("fixability_score", () => {
  test("100 with no confirmed findings", () => {
    const c = computeAuditConfidence(makeResult());
    expect(c.fixability_score).toBe(100);
  });

  test("100 when every confirmed finding has rewrite strategy", () => {
    const c = computeAuditConfidence(
      makeResult({
        findings: [makeFinding(), makeFinding()],
        confirmed_findings: 2,
      }),
    );
    expect(c.fixability_score).toBe(100);
  });

  test("annotate counts as half credit", () => {
    const annotate = makeFinding({
      verification: {
        verdict: "confirmed",
        reasoning: "real",
        evidence: { sink: "x", suggested_fix_strategy: "annotate" },
      },
    });
    const c = computeAuditConfidence(
      makeResult({ findings: [annotate, annotate], confirmed_findings: 2 }),
    );
    expect(c.fixability_score).toBe(50);
  });

  test("manual counts as zero credit", () => {
    const manual = makeFinding({
      verification: {
        verdict: "confirmed",
        reasoning: "real",
        evidence: { sink: "x", suggested_fix_strategy: "manual" },
      },
    });
    const c = computeAuditConfidence(
      makeResult({ findings: [manual, manual], confirmed_findings: 2 }),
    );
    expect(c.fixability_score).toBe(0);
  });

  test("findings without strategy reduce fixability proportionally", () => {
    const noStrategy = makeFinding({
      verification: {
        verdict: "confirmed",
        reasoning: "legacy",
        // no evidence at all
      },
    });
    const rewrite = makeFinding();
    const c = computeAuditConfidence(
      makeResult({
        findings: [rewrite, rewrite, noStrategy, noStrategy],
        confirmed_findings: 4,
      }),
    );
    expect(c.fixability_score).toBe(50);
  });

  test("null when no finding has any strategy (legacy run)", () => {
    const noStrategy = makeFinding({
      verification: { verdict: "confirmed", reasoning: "legacy run" },
    });
    const c = computeAuditConfidence(
      makeResult({
        findings: [noStrategy, noStrategy],
        confirmed_findings: 2,
      }),
    );
    expect(c.fixability_score).toBeNull();
  });
});

describe("aggregate score", () => {
  test("100 for a perfectly clean run", () => {
    const c = computeAuditConfidence(
      makeResult({
        findings: [makeFinding()],
        confirmed_findings: 1,
        false_positives: 1,
        false_positives_detail: [makeFp()],
        ast_grammar_status: [
          { language: "javascript", patterns_attempted: 1, loaded: true },
        ],
      }),
    );
    expect(c.score).toBe(100);
  });

  test("dropped subscores are excluded from the weighted average, not zeroed", () => {
    // skip-verify nulls verifier_score and noise_score directly; in
    // realistic skip-verify output the synthesized findings have no
    // evidence, so fixability is also null.
    const noStrategy = makeFinding({
      verification: { verdict: "confirmed", reasoning: "Verification skipped — static-only mode" },
    });
    const c = computeAuditConfidence(
      makeResult({
        verification_mode: "skipped",
        findings: [noStrategy, noStrategy],
        confirmed_findings: 2,
        ast_grammar_status: [
          { language: "javascript", patterns_attempted: 1, loaded: true },
        ],
      }),
    );
    expect(c.verifier_score).toBeNull();
    expect(c.noise_score).toBeNull();
    expect(c.fixability_score).toBeNull();
    // Coverage 100 (weight 0.25) + AST 100 (weight 0.15) = 100
    expect(c.score).toBe(100);
  });

  test("realistic mixed run: 25% coverage + clean verifier + half-fixable", () => {
    const annotate = makeFinding({
      verification: {
        verdict: "confirmed",
        reasoning: "real",
        evidence: { sink: "x", suggested_fix_strategy: "annotate" },
      },
    });
    const rewrite = makeFinding();
    const c = computeAuditConfidence(
      makeResult({
        coverage: {
          totalCandidateFiles: 1000,
          scannedFiles: 250,
          skippedByLimit: 750,
          truncated: true,
          maxFiles: 250,
          capSource: "user",
        },
        findings: [rewrite, rewrite, annotate, annotate],
        confirmed_findings: 4,
        false_positives_detail: [makeFp()],
        false_positives: 1,
      }),
    );
    // coverage 25 (w 0.25) = 6.25
    // verifier 100 (w 0.20) = 20
    // ast 100 (w 0.15) = 15
    // noise 100 (w 0.20) = 20
    // fixability 75 (w 0.20) = 15  (rewrite=2*1 + annotate=2*0.5 = 3 / 4 = 75)
    // total = 76.25 ≈ 76
    expect(c.score).toBe(76);
  });

  test("warnings collected from all subscores", () => {
    const c = computeAuditConfidence(
      makeResult({
        coverage: {
          totalCandidateFiles: 1000,
          scannedFiles: 100,
          skippedByLimit: 900,
          truncated: true,
          maxFiles: 100,
          capSource: "user",
        },
        ast_grammar_status: [
          { language: "php", patterns_attempted: 1, loaded: false, last_error: "missing" },
        ],
      }),
    );
    expect(c.warnings.length).toBeGreaterThanOrEqual(2);
    expect(c.warnings.some((w) => w.includes("truncated"))).toBe(true);
    expect(c.warnings.some((w) => w.includes("php"))).toBe(true);
  });
});
