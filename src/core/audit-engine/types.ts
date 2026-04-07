// KCode - Audit Engine Types
// Core types for the deterministic audit pipeline.

export type Severity = "critical" | "high" | "medium" | "low";
export type Language =
  | "c" | "cpp" | "python" | "go" | "rust"
  | "javascript" | "typescript" | "swift" | "java"
  | "kotlin" | "csharp" | "php" | "ruby" | "dart"
  | "scala" | "elixir" | "lua" | "zig" | "haskell"
  | "perl" | "r" | "julia" | "sql" | "matlab";

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
  elapsed_ms: number;
}
