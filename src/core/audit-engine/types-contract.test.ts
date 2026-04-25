// KCode - Contract migration tests for Sprint 1.
//
// The audit JSON contract gained optional fields in v2.10.326:
//   ReviewState, ReviewReason, FixSupport, PatternMaturity
//   Finding.review_state, .review_reason, .review_tags, .fix_support
//   FalsePositiveDetail.review_*
//   BugPattern.fix_support, .maturity, .fixture_covered
//   AuditResult.fix_support_summary
//
// These tests pin the migration's non-destructive guarantees:
//   1. Old AUDIT_REPORT.json files (no new fields) load without errors.
//   2. Code that constructs an AuditResult / Finding without the new
//      fields keeps compiling.
//   3. New fields, when present, round-trip through JSON.parse +
//      JSON.stringify unchanged.

import { describe, expect, it } from "bun:test";
import type {
  AuditResult,
  BugPattern,
  FalsePositiveDetail,
  Finding,
  FixSupport,
  PatternMaturity,
  ReviewReason,
  ReviewState,
} from "./types";

describe("v2.10.326 contract — backwards compat", () => {
  it("loads a pre-v326 AuditResult JSON without errors", () => {
    // This is the shape produced by v2.10.325 and earlier — no new
    // optional fields. Must still parse and satisfy the type.
    const legacyJson = `{
      "project": "/repo",
      "timestamp": "2026-04-25",
      "languages_detected": ["c", "cpp"],
      "files_scanned": 100,
      "candidates_found": 10,
      "confirmed_findings": 2,
      "false_positives": 7,
      "findings": [
        {
          "pattern_id": "fsw-010-cmd-arg-before-validate",
          "pattern_title": "Ground-command argument used before cmdResponse check",
          "severity": "high",
          "file": "/repo/Svc/X.cpp",
          "line": 42,
          "matched_text": "X_cmdHandler",
          "context": "void X::X_cmdHandler(...)",
          "verification": {
            "verdict": "confirmed",
            "reasoning": "ok"
          },
          "cwe": "CWE-20"
        }
      ],
      "false_positives_detail": [],
      "needs_context": 1,
      "needs_context_detail": [],
      "coverage": {
        "totalCandidateFiles": 100,
        "scannedFiles": 100,
        "skippedByLimit": 0,
        "truncated": false,
        "maxFiles": 500,
        "capSource": "adaptive"
      },
      "elapsed_ms": 12345
    }`;
    const r = JSON.parse(legacyJson) as AuditResult;
    expect(r.findings.length).toBe(1);
    expect(r.confirmed_findings).toBe(2);
    expect(r.fix_support_summary).toBeUndefined();
    expect(r.findings[0]!.review_state).toBeUndefined();
    expect(r.findings[0]!.fix_support).toBeUndefined();
  });

  it("constructs a Finding with no v326 fields and compiles", () => {
    const f: Finding = {
      pattern_id: "p1",
      pattern_title: "Test",
      severity: "high",
      file: "/x",
      line: 1,
      matched_text: "",
      context: "",
      verification: { verdict: "confirmed", reasoning: "" },
    };
    expect(f.review_state).toBeUndefined();
    expect(f.fix_support).toBeUndefined();
  });

  it("constructs a BugPattern without v326 fields and compiles", () => {
    // Cast the regex to satisfy the type signature for fixtures.
    const p: BugPattern = {
      id: "p1",
      title: "Test",
      severity: "medium",
      languages: ["c"],
      regex: /test/g,
      explanation: "",
      verify_prompt: "",
    };
    expect(p.maturity).toBeUndefined();
    expect(p.fix_support).toBeUndefined();
    expect(p.fixture_covered).toBeUndefined();
  });
});

describe("v2.10.326 contract — round-trip", () => {
  it("Finding with all v326 fields round-trips through JSON", () => {
    const f: Finding = {
      pattern_id: "p",
      pattern_title: "T",
      severity: "high",
      file: "/x",
      line: 1,
      matched_text: "",
      context: "",
      verification: { verdict: "confirmed", reasoning: "" },
      review_state: "promoted",
      review_reason: "manual_confirmation",
      review_tags: ["wontfix", "tracked-12345"],
      fix_support: "rewrite",
    };
    const round = JSON.parse(JSON.stringify(f)) as Finding;
    expect(round.review_state).toBe("promoted");
    expect(round.review_reason).toBe("manual_confirmation");
    expect(round.review_tags).toEqual(["wontfix", "tracked-12345"]);
    expect(round.fix_support).toBe("rewrite");
  });

  it("FalsePositiveDetail with review fields round-trips", () => {
    const fp: FalsePositiveDetail = {
      pattern_id: "p",
      pattern_title: "T",
      severity: "medium",
      file: "/x",
      line: 1,
      matched_text: "",
      context: "",
      verification: { verdict: "false_positive", reasoning: "trusted" },
      review_state: "promoted",
      review_reason: "manual_confirmation",
    };
    const round = JSON.parse(JSON.stringify(fp)) as FalsePositiveDetail;
    expect(round.review_state).toBe("promoted");
    expect(round.review_reason).toBe("manual_confirmation");
  });

  it("AuditResult.fix_support_summary round-trips", () => {
    const partial = {
      project: "/x",
      timestamp: "2026-04-25",
      languages_detected: ["c"] as const,
      files_scanned: 1,
      candidates_found: 0,
      confirmed_findings: 0,
      false_positives: 0,
      findings: [],
      false_positives_detail: [],
      needs_context: 0,
      needs_context_detail: [],
      coverage: {
        totalCandidateFiles: 1,
        scannedFiles: 1,
        skippedByLimit: 0,
        truncated: false,
        maxFiles: 500,
        capSource: "adaptive" as const,
      },
      fix_support_summary: { rewrite: 3, annotate: 2, manual: 1 },
      elapsed_ms: 10,
      // biome-ignore lint/suspicious/noExplicitAny: typed cast is fine for the test
    } as any;
    const r: AuditResult = partial;
    const round = JSON.parse(JSON.stringify(r)) as AuditResult;
    expect(round.fix_support_summary?.rewrite).toBe(3);
    expect(round.fix_support_summary?.annotate).toBe(2);
    expect(round.fix_support_summary?.manual).toBe(1);
  });
});

describe("v2.10.326 contract — discriminated unions are exhaustive", () => {
  it("ReviewState covers every documented state", () => {
    const states: ReviewState[] = [
      "confirmed",
      "demoted_fp",
      "promoted",
      "needs_context",
      "ignored",
    ];
    expect(states.length).toBe(5);
  });

  it("ReviewReason covers the documented reasons", () => {
    const reasons: ReviewReason[] = [
      "trusted_boundary",
      "test_only",
      "generated_code",
      "build_time_only",
      "placeholder_secret",
      "sanitized",
      "manual_confirmation",
      "other",
    ];
    expect(reasons.length).toBe(8);
  });

  it("FixSupport has rewrite/annotate/manual", () => {
    const tiers: FixSupport[] = ["rewrite", "annotate", "manual"];
    expect(tiers.length).toBe(3);
  });

  it("PatternMaturity has experimental/stable/high_precision", () => {
    const tiers: PatternMaturity[] = [
      "experimental",
      "stable",
      "high_precision",
    ];
    expect(tiers.length).toBe(3);
  });
});
