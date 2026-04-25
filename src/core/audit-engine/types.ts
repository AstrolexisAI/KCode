// KCode - Audit Engine Types
// Core types for the deterministic audit pipeline.
//
// v2.10.326 (Sprint 1 of audit-pipeline maturity roadmap) introduces
// non-breaking extensions to the contract. Every new field is OPTIONAL
// so existing AUDIT_REPORT.json files keep loading and emitting code
// keeps compiling without changes. The intent is to enable richer
// downstream features (/review v2 with promote/demote/tag, /fix with
// honest fix_support, /pr structured-first) without forcing a
// migration.

export type Severity = "critical" | "high" | "medium" | "low";

/**
 * State assigned by a human reviewer in /review (Sprint 2).
 *
 *   confirmed     — the verifier said yes; reviewer agrees (default)
 *   demoted_fp    — reviewer downgraded a confirmed finding to FP
 *   promoted     — reviewer escalated a needs_context to confirmed
 *   needs_context — reviewer punted; same as the verifier's verdict
 *   ignored       — reviewer wants this excluded from /fix and /pr
 *
 * Persisted on Finding so the reviewer's decisions survive across
 * reruns of /fix and /pr without re-running /scan.
 */
export type ReviewState =
  | "confirmed"
  | "demoted_fp"
  | "promoted"
  | "needs_context"
  | "ignored";

/**
 * Why a reviewer made a decision in /review (Sprint 2). Used to
 * generate richer report sections AND to feed back into pattern
 * priority — patterns that consistently get demoted with reason
 * "trusted_boundary" or "test_only" should drop in ranking.
 */
export type ReviewReason =
  | "trusted_boundary"     // intra-process IPC, sibling component, framework guarantee
  | "test_only"            // file is in a test/spec/fixture path
  | "generated_code"       // autogen — fixing requires regenerating, not patching
  | "build_time_only"      // CMake / scripts / autocoder — outside runtime threat model
  | "placeholder_secret"   // hardcoded value is a doc / fixture / changeme
  | "sanitized"            // input is validated upstream, verifier missed the guard
  | "manual_confirmation"  // reviewer confirmed by inspection
  | "other";

/**
 * Whether a pattern can be fixed mechanically, only annotated, or
 * requires human judgment. Driven by the bespoke-fixer registry vs
 * recipe-only PATTERN_RECIPES vs no entry. Lets /fix be honest about
 * what it actually applied (rewrite vs annotate vs nothing) and lets
 * the report show "X autofixable, Y annotate-only, Z manual-only"
 * upfront instead of after running /fix.
 */
export type FixSupport = "rewrite" | "annotate" | "manual";

/**
 * Maturity tier of a pattern. Used in the report to surface
 * confidence: high_precision rules have curated fixtures and a low
 * historical false-positive rate; experimental rules are recent
 * additions where the regex/verifier-prompt pair has not been
 * stress-tested yet.
 */
export type PatternMaturity = "experimental" | "stable" | "high_precision";
export type Language =
  | "c" | "cpp" | "python" | "go" | "rust"
  | "javascript" | "typescript" | "swift" | "java"
  | "kotlin" | "csharp" | "php" | "ruby" | "dart"
  | "scala" | "elixir" | "lua" | "zig" | "haskell"
  | "perl" | "r" | "julia" | "sql" | "matlab" | "shell";

/**
 * A bug pattern is a rule that identifies a specific class of dangerous code.
 * Patterns are the core of the audit engine — they transform "the model looks
 * for bugs" (unreliable) into "the pipeline looks for KNOWN dangerous patterns,
 * then asks the model to verify each one" (reliable).
 */
export interface BugPattern {
  /** Stable unique ID, used for tracking and reporting */
  id: string;
  /** Short human-readable title */
  title: string;
  /** Severity if the pattern is confirmed as a real bug */
  severity: Severity;
  /** Languages this pattern applies to */
  languages: Language[];
  /** Regex (multi-line aware) to locate candidate sites */
  regex: RegExp;
  /** Short explanation shown in the report */
  explanation: string;
  /** The specific question the model must answer to verify */
  verify_prompt: string;
  /** CWE reference, if applicable */
  cwe?: string;
  /** Suggested fix template (human-readable) */
  fix_template?: string;
  /**
   * Whether /fix can mechanically rewrite this pattern, can only
   * annotate it with an advisory comment, or requires manual review.
   * Inferred at scan time from the fixer registry; declaring it on
   * the pattern itself is also allowed for explicit overrides.
   * v2.10.326. Default behaviour when undefined: derived from fixer
   * (BESPOKE_PATTERN_IDS → rewrite, PATTERN_RECIPES → annotate, else
   * manual).
   */
  fix_support?: FixSupport;
  /**
   * Confidence tier. Defaults to "experimental" when undefined to
   * keep the bar high — patterns must be promoted explicitly after
   * fixture coverage and FP-rate review. v2.10.326.
   */
  maturity?: PatternMaturity;
  /**
   * Whether the pattern has positive + negative fixtures under
   * tests/patterns/. Set by the test harness, not authored on the
   * pattern. Used by the report to flag patterns that fired without
   * fixture coverage. v2.10.326.
   */
  fixture_covered?: boolean;
}

/** A candidate finding — a pattern match that hasn't been verified yet. */
export interface Candidate {
  pattern_id: string;
  severity: Severity;
  file: string;
  line: number;
  matched_text: string;
  context: string; // surrounding lines
}

/** Verification result from the model. */
export type VerifyVerdict = "confirmed" | "false_positive" | "needs_context";

export interface Verification {
  verdict: VerifyVerdict;
  reasoning: string;
  execution_path?: string;
  suggested_fix?: string;
}

/** A confirmed finding ready to go into the report. */
export interface Finding {
  pattern_id: string;
  pattern_title: string;
  severity: Severity;
  file: string;
  line: number;
  matched_text: string;
  context: string;
  verification: Verification;
  cwe?: string;
  /**
   * Reviewer-assigned state from /review. Undefined means the
   * reviewer has not touched the finding since the last /scan.
   * Default behaviour for /fix and /pr when undefined is to treat
   * it as "confirmed" (i.e. proceed) — same as pre-v326. v2.10.326.
   */
  review_state?: ReviewState;
  /**
   * Reason recorded by the reviewer (only meaningful when
   * review_state is demoted_fp / promoted / ignored). Drives the
   * report's "why findings were rejected" section and feeds back
   * into pattern weighting. v2.10.326.
   */
  review_reason?: ReviewReason;
  /**
   * Free-form tags assigned by the reviewer (e.g. "wontfix",
   * "tracked-elsewhere"). Persisted as-is. v2.10.326.
   */
  review_tags?: string[];
  /**
   * Snapshot of the pattern's fix_support at scan time. Lets /fix
   * report counts of rewrite/annotate/manual without re-resolving
   * the registry, and lets /pr distinguish "auto-applied" from
   * "manual review needed" in the body. v2.10.326.
   */
  fix_support?: FixSupport;
}

/**
 * Detail about a candidate that the verifier rejected. Persisted
 * alongside confirmed findings so a human auditor can spot-check
 * whether the rejection was sensible — v2.10.306 session showed 0
 * confirmed / 27 false_positives with zero visibility into what
 * was thrown out, making the audit result untrustworthy even when
 * correct.
 */
export interface FalsePositiveDetail {
  pattern_id: string;
  pattern_title: string;
  severity: Severity;
  file: string;
  line: number;
  matched_text: string;
  context: string;
  verification: Verification;
  cwe?: string;
  /**
   * /review state — same semantics as on Finding. Lets a reviewer
   * promote a false_positive back to confirmed if they suspect the
   * verifier got it wrong, without losing the original verdict.
   * v2.10.326.
   */
  review_state?: ReviewState;
  review_reason?: ReviewReason;
  review_tags?: string[];
}

/**
 * Detail about a candidate the verifier couldn't classify. Shares the
 * FalsePositiveDetail shape; persisted separately so the report can
 * distinguish "model said safe" from "model couldn't decide".
 *
 * v2.10.309 session showed 33 candidates / 0 confirmed / 0 FP —
 * which arithmetically means 33 needs_context silently dropped.
 * Making the bucket first-class restores accounting:
 *   candidates_found == confirmed + false_positives + needs_context.
 */
export type NeedsContextDetail = FalsePositiveDetail;

/**
 * Coverage report: how many source files the project had vs how
 * many were actually scanned, so a truncated audit is visibly
 * truncated instead of silently under-covering.
 */
export interface AuditCoverage {
  /** Source files the scanner identified as in-scope before capping. */
  totalCandidateFiles: number;
  /** Source files actually handed to pattern scanning. */
  scannedFiles: number;
  /** totalCandidateFiles - scannedFiles. */
  skippedByLimit: number;
  /** Whether skippedByLimit > 0. */
  truncated: boolean;
  /** The cap that produced the truncation (either explicit or adaptive). */
  maxFiles: number;
  /** Did the cap come from the user (--max-files) or the adaptive default? */
  capSource: "user" | "adaptive";
}

/**
 * Proof-of-concept exploit for a confirmed finding.
 *
 * Generated by the exploit-gen module AFTER verification. Proves the
 * finding is exploitable by providing a concrete attack payload, the
 * delivery vector, and the expected outcome. This is the difference
 * between "this pattern matched" and "an attacker can do X".
 */
export interface ExploitProof {
  /** The finding this exploit targets */
  pattern_id: string;
  /** File + line reference */
  file: string;
  line: number;
  /** How the attack is delivered (e.g., "malformed HID packet", "crafted JSON API response") */
  attack_vector: string;
  /** The concrete malicious input / payload */
  payload: string;
  /** What happens when the exploit fires */
  expected_result: string;
  /** Step-by-step reproduction instructions */
  reproduction_steps: string[];
  /** CVSS-like severity justification */
  severity_justification: string;
  /** CWE reference from the pattern */
  cwe?: string;
}

/** Result of the full audit pipeline. */
export interface AuditResult {
  project: string;
  timestamp: string;
  languages_detected: Language[];
  files_scanned: number;
  candidates_found: number;
  confirmed_findings: number;
  false_positives: number;
  findings: Finding[];
  /**
   * Persisted rejected candidates (verdict=false_positive). Kept so
   * a human auditor can spot-check the verifier's decisions rather
   * than trusting a bare counter. Empty when the audit ran without
   * candidates or when the verifier was disabled.
   */
  false_positives_detail: FalsePositiveDetail[];
  /**
   * Candidates the verifier returned verdict=needs_context for. The
   * model either couldn't decide or the response didn't parse cleanly
   * into confirmed/false_positive. Surfacing them keeps the arithmetic
   * honest:
   *   candidates_found == confirmed_findings + false_positives + needs_context.
   */
  needs_context: number;
  needs_context_detail: NeedsContextDetail[];
  /**
   * Coverage accounting. Always present so consumers can tell
   * "scanned all the code" from "scanned the first 500 files in
   * traversal order". See AuditCoverage for field semantics.
   */
  coverage: AuditCoverage;
  /**
   * Counts of confirmed findings by fix_support tier. Lets /fix and
   * the report announce up front: "8 confirmed (3 rewrite, 2
   * annotate, 3 manual)" instead of revealing it only after /fix
   * runs. Optional for backwards compat; when missing, downstream
   * code derives it from finding.fix_support if present, else falls
   * back to the legacy "all confirmed" model. v2.10.326.
   */
  fix_support_summary?: {
    rewrite: number;
    annotate: number;
    manual: number;
  };
  exploits?: ExploitProof[];
  elapsed_ms: number;
}
