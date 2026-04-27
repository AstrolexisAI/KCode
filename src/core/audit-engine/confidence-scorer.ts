// KCode - Audit Confidence Scorer
//
// F2 of the audit product plan (v2.10.362). Derives a quantitative
// trustworthiness score for an AuditResult so the headline of every
// report is "score: 87/100" instead of "we found N things, trust us".
//
// All five subscores live in [0, 100]. Each one can also be `null`
// when it isn't derivable for the current run (e.g. verifier_score
// is null for `--skip-verify` runs because there's no verifier
// output to grade). Null subscores are EXCLUDED from the weighted
// aggregate — we degrade the headline by dropping their contribution
// rather than pretending they're zero.
//
// Weights (sum to 1.0):
//   coverage  0.25  — how much of the codebase actually got scanned
//   verifier  0.20  — how often the verifier produced parseable JSON
//   ast       0.15  — how many AST grammars loaded
//   noise     0.20  — how often false_positives carry a real reason
//   fixability 0.20 — how many confirmed findings have rewrite-class fixes

import type { AuditConfidence, AuditResult, FalsePositiveDetail, Finding } from "./types";

const WEIGHTS = {
  coverage: 0.25,
  verifier: 0.2,
  ast: 0.15,
  noise: 0.2,
  fixability: 0.2,
} as const;

const UNPARSEABLE_PREFIX = "[verifier output unparseable]";

function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 100;
  return Math.round((numerator / denominator) * 100);
}

/**
 * `coverage_score` — what fraction of in-scope source files actually
 * got handed to the pattern scanner. A diff scan is treated as 100%
 * because the diff IS the in-scope set; the user opted into the
 * filter and we shouldn't penalize them for it.
 */
function computeCoverageScore(result: AuditResult): {
  score: number | null;
  warning?: string;
} {
  const cov = result.coverage;
  if (!cov) return { score: null, warning: "Coverage data missing." };

  // diff scans (since: ...) are scope-by-design, not coverage gaps.
  if ((cov as { since?: string }).since) return { score: 100 };

  if (cov.totalCandidateFiles === 0) return { score: 100 };
  const score = pct(cov.scannedFiles, cov.totalCandidateFiles);
  if (cov.truncated) {
    return {
      score,
      warning: `Coverage truncated to ${cov.scannedFiles}/${cov.totalCandidateFiles} files.`,
    };
  }
  return { score };
}

/**
 * `verifier_score` — what fraction of verifier outputs parsed
 * cleanly. We detect "didn't parse" via the
 * "[verifier output unparseable]" prefix the parser stamps on
 * degraded verdicts (see `degradedVerdict` in verifier.ts). Runs
 * with `--skip-verify` get null because there's no verifier output
 * to grade.
 */
function computeVerifierScore(result: AuditResult): {
  score: number | null;
  warning?: string;
} {
  if (result.verification_mode === "skipped") {
    return {
      score: null,
      warning: "Verifier was skipped (--skip-verify) — score excluded from aggregate.",
    };
  }

  const allVerifications: Array<{ verification: { reasoning: string } }> = [
    ...result.findings.map((f) => ({ verification: f.verification })),
    ...(result.false_positives_detail ?? []).map((d: FalsePositiveDetail) => ({
      verification: d.verification,
    })),
    ...(result.needs_context_detail ?? []).map((d) => ({
      verification: d.verification,
    })),
  ];

  if (allVerifications.length === 0) return { score: 100 };

  const cleanCount = allVerifications.filter(
    (v) => !v.verification.reasoning.startsWith(UNPARSEABLE_PREFIX),
  ).length;

  return { score: pct(cleanCount, allVerifications.length) };
}

/**
 * `ast_score` — what fraction of attempted AST grammars actually
 * loaded. When no AST pattern ran (regex-only languages or empty
 * scope) we return 100 — there's nothing to be uncertain about.
 */
function computeAstScore(result: AuditResult): {
  score: number | null;
  warning?: string;
} {
  const status = result.ast_grammar_status ?? [];
  if (status.length === 0) return { score: 100 };
  const loaded = status.filter((s) => s.loaded).length;
  const score = pct(loaded, status.length);
  if (loaded < status.length) {
    const missing = status
      .filter((s) => !s.loaded)
      .map((s) => s.language)
      .join(", ");
    return {
      score,
      warning: `AST grammars degraded for: ${missing}.`,
    };
  }
  return { score };
}

/**
 * `noise_score` — what fraction of false_positives carry a non-empty
 * `mitigations_found` list. A FP with mitigations names the exact
 * reason it was thrown out; an empty FP is the "model said safe and
 * stopped there" case which is harder to trust.
 *
 * Returns 100 when there are no FPs (trivially low noise) and null
 * when the run had no verifier (we can't grade rejection quality).
 */
function computeNoiseScore(result: AuditResult): {
  score: number | null;
  warning?: string;
} {
  if (result.verification_mode === "skipped") {
    return {
      score: null,
      warning: "Noise score requires the verifier; --skip-verify excludes it.",
    };
  }

  const fps = result.false_positives_detail ?? [];
  if (fps.length === 0) return { score: 100 };

  const justified = fps.filter((fp: FalsePositiveDetail) => {
    const m = fp.verification.evidence?.mitigations_found;
    return Array.isArray(m) && m.length > 0;
  }).length;

  const score = pct(justified, fps.length);
  if (score < 50) {
    return {
      score,
      warning: `Only ${justified}/${fps.length} false_positives cite a concrete mitigation.`,
    };
  }
  return { score };
}

/**
 * `fixability_score` — what fraction of confirmed findings have a
 * rewrite-class strategy attached. Higher is better because it
 * means /fix --safe-only can deal with most of the report
 * automatically. Annotate/manual still count; they just don't
 * contribute the full weight.
 */
function computeFixabilityScore(result: AuditResult): {
  score: number | null;
  warning?: string;
} {
  const confirmed: Finding[] = result.findings;
  // v2.10.367 — was returning 100 (vacuously fixable) for zero
  // findings, which inflated the headline confidence in clean runs.
  // Null + drop-from-aggregate is more honest: there's nothing to
  // grade fixability against.
  if (confirmed.length === 0) {
    return { score: null, warning: "No confirmed findings to grade fixability against." };
  }

  const withStrategy = confirmed.filter((f) => !!f.verification.evidence?.suggested_fix_strategy);
  if (withStrategy.length === 0) {
    // No structured fix strategy on any finding — likely a legacy run
    // that predates F3, can't grade. Score null + warning.
    return {
      score: null,
      warning: "No verifier evidence with `suggested_fix_strategy` — fixability undetermined.",
    };
  }

  // Weight rewrite as full credit, annotate as half, manual as 0.
  // Findings with strategy but unknown weight (shouldn't happen — the
  // type is a closed union) count as 0.
  let weighted = 0;
  for (const f of withStrategy) {
    const s = f.verification.evidence?.suggested_fix_strategy;
    if (s === "rewrite") weighted += 1;
    else if (s === "annotate") weighted += 0.5;
  }
  // Findings WITHOUT any strategy are penalized as if they were "manual"
  // (zero credit) so a partially-evidenced run doesn't game the score.
  const score = Math.round((weighted / confirmed.length) * 100);
  return { score };
}

export function computeAuditConfidence(result: AuditResult): AuditConfidence {
  const coverage = computeCoverageScore(result);
  const verifier = computeVerifierScore(result);
  const ast = computeAstScore(result);
  const noise = computeNoiseScore(result);
  const fixability = computeFixabilityScore(result);

  const warnings: string[] = [];
  for (const w of [
    coverage.warning,
    verifier.warning,
    ast.warning,
    noise.warning,
    fixability.warning,
  ]) {
    if (w) warnings.push(w);
  }

  // v2.10.388 P0 fix — divide by the FULL original-weight sum (1.0),
  // not the surviving weights. Previously the script renormalized over
  // surviving weights, so a `--skip-verify` run with coverage+ast+
  // fixability at 100 produced a 100/100 headline that hid the missing
  // semantic verification. The intended behavior (already stated in
  // the prior comment, just contradicted by the implementation) is:
  //   - keep the original 1.0 weight budget
  //   - missing subscores contribute 0
  //   - headline naturally caps at sum-of-surviving-weights * 100
  //
  // Concrete: --skip-verify drops verifier (0.2) and noise (0.2);
  // headline can't exceed 60 even if everything else is perfect.
  // The numeric cap reinforces the explicit `warnings[]` text without
  // letting users glance at a headline and miss the gap.
  const TOTAL_WEIGHT =
    WEIGHTS.coverage + WEIGHTS.verifier + WEIGHTS.ast + WEIGHTS.noise + WEIGHTS.fixability;
  let weightedSum = 0;
  if (coverage.score !== null) weightedSum += coverage.score * WEIGHTS.coverage;
  if (verifier.score !== null) weightedSum += verifier.score * WEIGHTS.verifier;
  if (ast.score !== null) weightedSum += ast.score * WEIGHTS.ast;
  if (noise.score !== null) weightedSum += noise.score * WEIGHTS.noise;
  if (fixability.score !== null) weightedSum += fixability.score * WEIGHTS.fixability;
  const score = Math.round(weightedSum / TOTAL_WEIGHT);

  return {
    score,
    coverage_score: coverage.score,
    verifier_score: verifier.score,
    ast_score: ast.score,
    noise_score: noise.score,
    fixability_score: fixability.score,
    warnings,
  };
}
