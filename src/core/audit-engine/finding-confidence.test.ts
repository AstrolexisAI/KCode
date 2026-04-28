// Per-finding confidence scorer tests (v2.10.400).

import { describe, expect, it } from "bun:test";
import {
  countByBand,
  derivePatternMaturity,
  passesConfidenceFilter,
  scoreFinding,
} from "./finding-confidence";
import type { BugPattern, Finding, Verification } from "./types";

const stablePattern: BugPattern = {
  id: "java-019-tls-trust-all",
  title: "TLS trust-all",
  severity: "critical",
  languages: ["java"],
  regex: /TrustAll/g,
  explanation: "",
  verify_prompt: "",
  fix_support: "rewrite",
  fixture_covered: true,
};

const broadPattern: BugPattern = {
  id: "java-030-xss-writer-non-literal",
  title: "XSS writer non-literal",
  severity: "high",
  languages: ["java"],
  regex: /println/g,
  explanation: "",
  verify_prompt: "",
};

const verifiedConfirmed: Verification = { verdict: "confirmed", reasoning: "" };
const verifiedFP: Verification = { verdict: "false_positive", reasoning: "" };
const verifiedSkipped: Verification = { verdict: "confirmed", reasoning: "skipped" };

describe("derivePatternMaturity", () => {
  it("respects explicit maturity", () => {
    expect(derivePatternMaturity({ ...stablePattern, maturity: "high_precision" })).toBe(
      "high_precision",
    );
  });
  it("classifies broad patterns as experimental", () => {
    expect(derivePatternMaturity(broadPattern)).toBe("experimental");
  });
  it("promotes fixture+rewrite to high_precision", () => {
    expect(derivePatternMaturity(stablePattern)).toBe("high_precision");
  });
  it("falls back to stable", () => {
    const p: BugPattern = { ...stablePattern, fixture_covered: false };
    expect(derivePatternMaturity(p)).toBe("stable");
  });
});

describe("scoreFinding — band assignment", () => {
  it("high-precision pattern + tainted + confirmed verifier → high band", () => {
    const r = scoreFinding({
      pattern: stablePattern,
      taintOrigin: "tainted",
      sanitizerSeen: false,
      verification: verifiedConfirmed,
      demotionCount: 0,
    });
    expect(r.band).toBe("high");
    expect(r.score).toBeGreaterThanOrEqual(75);
  });

  it("broad pattern + unknown taint + skipped verifier + demotions → low band", () => {
    const r = scoreFinding({
      pattern: broadPattern,
      taintOrigin: "unknown",
      sanitizerSeen: null,
      verification: verifiedSkipped,
      demotionCount: 12,
    });
    expect(r.band).toBe("low");
  });

  it("stable + n/a taint + skipped verifier + clean → medium band", () => {
    const r = scoreFinding({
      pattern: { ...stablePattern, fixture_covered: false },
      taintOrigin: "n/a",
      sanitizerSeen: null,
      verification: verifiedSkipped,
      verificationSkipped: true,
      demotionCount: 0,
    });
    expect(r.band).toBe("medium");
  });

  it("verifier false_positive penalises hard", () => {
    const r = scoreFinding({
      pattern: stablePattern,
      taintOrigin: "tainted",
      sanitizerSeen: false,
      verification: verifiedFP,
      demotionCount: 0,
    });
    expect(r.band).toBe("medium"); // would-be-high is dragged down by FP signal
  });
});

describe("scoreFinding — signal breakdown", () => {
  it("includes all six signals in order", () => {
    const r = scoreFinding({
      pattern: stablePattern,
      taintOrigin: "tainted",
      sanitizerSeen: false,
      verification: verifiedConfirmed,
      demotionCount: 0,
    });
    const names = r.signals.map((s) => s.name);
    expect(names).toEqual([
      "pattern_maturity",
      "taint_origin",
      "sanitizer_seen",
      "verifier_verdict",
      "learning_loop_noise",
      "fix_support",
    ]);
  });
});

describe("passesConfidenceFilter", () => {
  const finding = (band: "high" | "medium" | "low"): Finding => ({
    pattern_id: "x",
    pattern_title: "x",
    severity: "high",
    file: "x.java",
    line: 1,
    matched_text: "",
    context: "",
    verification: verifiedConfirmed,
    confidence: { score: 0, band, signals: [] },
  });

  it("--confidence high keeps only high", () => {
    expect(passesConfidenceFilter(finding("high"), "high")).toBe(true);
    expect(passesConfidenceFilter(finding("medium"), "high")).toBe(false);
    expect(passesConfidenceFilter(finding("low"), "high")).toBe(false);
  });

  it("--confidence medium keeps high + medium", () => {
    expect(passesConfidenceFilter(finding("high"), "medium")).toBe(true);
    expect(passesConfidenceFilter(finding("medium"), "medium")).toBe(true);
    expect(passesConfidenceFilter(finding("low"), "medium")).toBe(false);
  });

  it("--confidence all (or undefined) keeps everything", () => {
    expect(passesConfidenceFilter(finding("low"), "all")).toBe(true);
    expect(passesConfidenceFilter(finding("low"), undefined)).toBe(true);
  });

  it("missing confidence is preserved (recall-safe default)", () => {
    const f: Finding = {
      pattern_id: "x",
      pattern_title: "x",
      severity: "high",
      file: "x.java",
      line: 1,
      matched_text: "",
      context: "",
      verification: verifiedConfirmed,
    };
    expect(passesConfidenceFilter(f, "high")).toBe(true);
  });
});

describe("countByBand", () => {
  it("counts each band independently", () => {
    const findings: Finding[] = [
      {
        pattern_id: "x",
        pattern_title: "x",
        severity: "high",
        file: "x.java",
        line: 1,
        matched_text: "",
        context: "",
        verification: verifiedConfirmed,
        confidence: { score: 80, band: "high", signals: [] },
      },
      {
        pattern_id: "x",
        pattern_title: "x",
        severity: "high",
        file: "x.java",
        line: 2,
        matched_text: "",
        context: "",
        verification: verifiedConfirmed,
        confidence: { score: 60, band: "medium", signals: [] },
      },
      {
        pattern_id: "x",
        pattern_title: "x",
        severity: "high",
        file: "x.java",
        line: 3,
        matched_text: "",
        context: "",
        verification: verifiedConfirmed,
        confidence: { score: 30, band: "low", signals: [] },
      },
    ];
    expect(countByBand(findings)).toEqual({ high: 1, medium: 1, low: 1 });
  });
});
