// KCode - Per-finding confidence scorer (v2.10.400)
//
// Combines six signals into a 0-100 score and a coarse band
// (high / medium / low). Used by the report breakdown and the
// `kcode audit --confidence <band>` filter so the user picks
// their position on the precision/recall curve instead of
// taking whatever the default surface layer produces.
//
// Signals (additive, all in [-25, +30]):
//
//   pattern_maturity    — high_precision / stable / experimental
//   taint_origin        — sanitized / constant / unknown / tainted (Fix #3)
//   sanitizer_seen      — file-level scan for OWASP-style sanitizers
//   verifier_verdict    — confirmed / needs_context / skipped
//   learning_loop_noise — prior /review demotions for (pattern, path)
//   fix_support         — rewrite (mature) / annotate / manual (less)
//
// Band thresholds default to ≥75 high, 50-74 medium, <50 low.
// Calibration on the 4 KCode benchmark corpora (in-house,
// OWASP sqli, OWASP full, KCode self-audit) may move them
// before v2.10.400 ships.
//
// Each signal contribution is preserved on `signals` so the
// report can show "scored 72 because: pattern stable +15,
// taint unknown +0, no sanitizer +20, verifier skipped n/a,
// no demotions +10, fix rewrite +20".

import type {
  BugPattern,
  ConfidenceBand,
  ConfidenceSignal,
  Finding,
  FindingConfidence,
  PatternMaturity,
  Verification,
} from "./types";

/**
 * The fields the scorer needs from a pattern. Both `BugPattern` and
 * the AST `LookupPattern` returned by `getPatternById` satisfy this
 * shape — the scorer doesn't need the regex / explanation /
 * verify_prompt etc., just the maturity-related metadata. v2.10.400.
 */
export type PatternView = Pick<BugPattern, "id" | "maturity" | "fix_support" | "fixture_covered">;

// ── Maturity inference ────────────────────────────────────────────

const BROAD_PATTERN_RE = /(?:non-literal|var-flow|broad)\b/i;

/**
 * Derive a pattern's maturity tier from the pattern itself plus the
 * harness-set `fixture_covered` flag. Explicit `pattern.maturity` is
 * always honored; otherwise:
 *
 *   high_precision — fixture_covered AND fix_support === "rewrite"
 *                    AND id doesn't look broad
 *   experimental   — id matches BROAD_PATTERN_RE (the v2.10.398
 *                    sink-flagging patterns are the canonical case)
 *   stable         — everything else
 */
export function derivePatternMaturity(pattern: PatternView): PatternMaturity {
  if (pattern.maturity) return pattern.maturity;
  if (BROAD_PATTERN_RE.test(pattern.id)) return "experimental";
  if (pattern.fixture_covered === true && pattern.fix_support === "rewrite") {
    return "high_precision";
  }
  return "stable";
}

// ── Per-signal weights ────────────────────────────────────────────

function maturityWeight(m: PatternMaturity): number {
  // Maturity is the dominant signal when the verifier is opted out
  // (the default for `kcode audit --skip-verify` and any non-LLM
  // run). A high_precision pattern alone scores into the HIGH band
  // because by definition it's a categorical-API match that can't
  // be a false positive — `Math.random()` for security is wrong
  // every time it appears regardless of surrounding context.
  if (m === "high_precision") return 60;
  if (m === "stable") return 30;
  return 10; // experimental — broad / non-literal patterns
}

function taintWeight(origin: TaintOrigin): number {
  // Constant / sanitized are already suppressed before scoring, so
  // those entries are theoretical. Tainted is the strongest signal
  // we ship: Fix #3 traced the value end-to-end.
  if (origin === "tainted") return 25;
  if (origin === "unknown") return 10;
  return 5; // n/a (pattern wasn't taint-analyzed)
}

function sanitizerSeenWeight(seen: boolean | null): number {
  if (seen === null) return 5; // not analyzed → tiny benefit-of-the-doubt
  return seen ? -15 : 15; // sanitizer in scope lowers confidence
}

function verifierWeight(verdict: Verification["verdict"] | "skipped"): number {
  // Verifier confirmation is a real positive signal but it's
  // opt-in. We keep its weight modest so a `--skip-verify` user
  // can still get high-band findings on the strongest patterns.
  if (verdict === "confirmed") return 15;
  if (verdict === "false_positive") return -50; // strong negative
  return 0; // skipped / needs_context
}

function noiseWeight(demotionCount: number): number {
  if (demotionCount === 0) return 10;
  if (demotionCount < 5) return 0;
  if (demotionCount < 10) return -10;
  return -25; // high-noise pattern in this project
}

function fixSupportWeight(fixSupport: PatternView["fix_support"]): number {
  if (fixSupport === "rewrite") return 10; // a deterministic fixer => pattern is mature
  if (fixSupport === "annotate") return 5;
  return 0; // manual or undefined
}

// ── Public types ──────────────────────────────────────────────────

export type TaintOrigin = "tainted" | "constant" | "sanitized" | "unknown" | "n/a";

export interface ScoreInputs {
  pattern: PatternView;
  /** Fix #3 verdict from the taint walker. n/a means the pattern
   *  isn't in the taint-flow set. */
  taintOrigin: TaintOrigin;
  /** True if the file contained a known sanitizer call near the
   *  candidate, false if it didn't, null if we didn't check. */
  sanitizerSeen: boolean | null;
  verification: Verification;
  demotionCount: number;
  /** When the audit ran with --skip-verify, the verifier_verdict
   *  signal is not informative — every candidate gets a synthetic
   *  "confirmed" verdict that doesn't reflect any model judgment.
   *  Pass true here so the scorer treats verifier as `skipped`
   *  instead of giving free +25 for the synthetic confirmation. */
  verificationSkipped?: boolean;
}

// ── Aggregate ─────────────────────────────────────────────────────

const BAND_HIGH = 75;
const BAND_MEDIUM = 50;

export function scoreFinding(inputs: ScoreInputs): FindingConfidence {
  const signals: ConfidenceSignal[] = [];
  let score = 0;

  const maturity = derivePatternMaturity(inputs.pattern);
  const w1 = maturityWeight(maturity);
  signals.push({ name: "pattern_maturity", value: maturity, weight: w1 });
  score += w1;

  const w2 = taintWeight(inputs.taintOrigin);
  signals.push({ name: "taint_origin", value: inputs.taintOrigin, weight: w2 });
  score += w2;

  const w3 = sanitizerSeenWeight(inputs.sanitizerSeen);
  signals.push({
    name: "sanitizer_seen",
    value: inputs.sanitizerSeen === null ? "n/a" : inputs.sanitizerSeen ? "yes" : "no",
    weight: w3,
  });
  score += w3;

  const verdict = inputs.verificationSkipped
    ? ("skipped" as const)
    : (inputs.verification.verdict ?? "skipped");
  const w4 = verifierWeight(verdict);
  signals.push({ name: "verifier_verdict", value: verdict, weight: w4 });
  score += w4;

  const w5 = noiseWeight(inputs.demotionCount);
  signals.push({
    name: "learning_loop_noise",
    value: `${inputs.demotionCount} demotions`,
    weight: w5,
  });
  score += w5;

  const w6 = fixSupportWeight(inputs.pattern.fix_support);
  signals.push({
    name: "fix_support",
    value: inputs.pattern.fix_support ?? "manual",
    weight: w6,
  });
  score += w6;

  // Clamp to [0, 100] before banding.
  const clamped = Math.max(0, Math.min(100, score));
  const band: ConfidenceBand =
    clamped >= BAND_HIGH ? "high" : clamped >= BAND_MEDIUM ? "medium" : "low";

  return { score: clamped, band, signals };
}

// ── Filter helpers ────────────────────────────────────────────────

/**
 * Decide whether a finding survives a `--confidence <band>` filter.
 * The filter is a floor: `--confidence high` keeps only high-band
 * findings, `--confidence medium` keeps medium AND high, `--confidence
 * low` (or `all`) keeps everything.
 */
export function passesConfidenceFilter(
  finding: Finding,
  minBand: ConfidenceBand | "all" | undefined,
): boolean {
  if (!minBand || minBand === "all" || minBand === "low") return true;
  const f = finding.confidence;
  if (!f) return true; // no score → don't filter (recall-preserving)
  if (minBand === "high") return f.band === "high";
  if (minBand === "medium") return f.band === "high" || f.band === "medium";
  return true;
}

/**
 * Count findings per band. Used by the report breakdown to show
 *   Confirmed findings: 1292
 *     High confidence:   430
 *     Medium confidence: 510
 *     Low confidence:    352
 */
export function countByBand(findings: Finding[]): Record<ConfidenceBand, number> {
  const out: Record<ConfidenceBand, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    const band = f.confidence?.band ?? "medium";
    out[band] += 1;
  }
  return out;
}
