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

/**
 * Per-pattern statistics from a single audit run. Lets the report
 * surface which patterns fired heavily, which had a high FP rate,
 * and which never fire (candidates for removal). Aggregated across
 * many runs, this is the input to a pattern-quality dashboard.
 *
 * v2.10.330 (Sprint 5/6 of the audit-pipeline maturity roadmap).
 */
export interface PatternMetrics {
  /**
   * Total raw regex matches for this pattern across the run, before
   * dedupe-by-(pattern,file). Useful for "this regex fired heavily"
   * regardless of whether each site was a separate verifier call.
   */
  hits: number;
  /**
   * Number of unique (pattern_id, file) sites the verifier was
   * actually asked about. Always ≤ hits (dedupe collapses N matches
   * in 1 file to 1 verifier call). This is the denominator for
   * confirmed_rate / false_positive_rate so the rates stay coherent
   * with the verdict counts. v2.10.331 audit fix — earlier rates
   * mixed denominators (numerator was per-site, denominator was
   * per-hit), giving misleadingly low rates for heavy-firing patterns.
   */
  unique_sites: number;
  /** Verifier said confirmed (per unique site). */
  confirmed: number;
  /** Verifier said false_positive (per unique site). */
  false_positive: number;
  /** Verifier said needs_context (or response didn't parse). */
  needs_context: number;
  /**
   * confirmed / unique_sites, undefined when unique_sites === 0.
   * A pattern with persistently low confirmed_rate across runs is a
   * candidate for tightening or maturity downgrade.
   */
  confirmed_rate?: number;
  /** false_positive / unique_sites, undefined when unique_sites === 0. */
  false_positive_rate?: number;
}
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
  /**
   * Vendible pack the pattern belongs to. Lets users scope an audit
   * to a specific concern (`--pack ai-ml`) and lets the report show
   * a per-pack finding breakdown. Patterns without a pack land in
   * "general". v2.10.370 (F9 of audit product plan).
   *
   * Stable pack names (additions go through the patterns review):
   *   - "web"          XSS, SQLi, command injection, prototype pollution, SSRF, path traversal
   *   - "ai-ml"        pickle.loads, torch.load, LLM prompt injection, AI API keys, vector DB
   *   - "cloud"        Terraform, IAM, exposed secrets, security groups, Docker root
   *   - "supply-chain" dependency confusion, install scripts, GH Actions poisoning
   *   - "embedded"     flight software (FW_ASSERT, port handlers, command framers)
   */
  pack?: PatternPack;
}

/** Stable pack names for the F9 vendible-packs taxonomy. */
export type PatternPack =
  | "web"
  | "ai-ml"
  | "cloud"
  | "supply-chain"
  | "embedded";

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

/**
 * Strategy hint for /fix to pick the right fixer policy without
 * re-asking the model. `rewrite` = deterministic source change,
 * `annotate` = audit-note only (no logic change), `manual` = needs
 * human + design decision.
 */
export type FixStrategy = "rewrite" | "annotate" | "manual";

/**
 * Structured "Evidence Pack" the verifier emits per candidate. The
 * verifier prompt produces a JSON object matching this shape; the
 * parser validates and degrades to a partial verdict only on failure.
 *
 * v2.10.361 (F3 of audit product plan). Replaces the v1 prose
 * contract where `reasoning` carried everything in free text and
 * downstream callers had to scrape it. Lets the report, PR body, and
 * confidence score read structured fields directly.
 *
 * All fields except `sink` are optional because:
 *   - `false_positive` verdicts often have no `input_boundary` (the
 *     whole point is there is no exploit path).
 *   - `needs_context` verdicts have neither path nor sanitizer info
 *     by definition.
 *   - Older AUDIT_REPORT.json files predating F3 won't have evidence
 *     at all; parsers tolerate the absence.
 */
export interface VerifierEvidence {
  /**
   * Where the untrusted input enters the program. Examples: "HTTP
   * request body", "CLI argv", "deserialized JSON from network",
   * "ground command handler". Empty/undefined for false_positive when
   * there is no external input to name.
   */
  input_boundary?: string;
  /**
   * Ordered list of code locations between the input boundary and
   * the sink. Each entry is human-readable: "route handler
   * /api/upload (server.ts:88)", "service.parseFilename
   * (service.ts:142)", "child_process.exec call (sink)".
   */
  execution_path_steps?: string[];
  /**
   * The dangerous operation the input flows into. Required for any
   * `confirmed` verdict — without naming the sink the finding is
   * unactionable. Examples: "child_process.exec", "Buffer.alloc",
   * "eval", "fs.readFile path", "SQL string concat".
   */
  sink: string;
  /**
   * Sanitizers/validators the verifier explicitly looked for while
   * triaging. Useful for the report ("we checked these and they were
   * absent") and for noise tracking ("these patterns rule out 80%").
   */
  sanitizers_checked?: string[];
  /**
   * Mitigations the verifier *did* find. Populated when the verdict
   * is false_positive — names the exact line / function / type
   * constraint that made the candidate safe. Empty array on
   * confirmed verdicts.
   */
  mitigations_found?: string[];
  /** Strategy hint for /fix to choose its policy. */
  suggested_fix_strategy?: FixStrategy;
  /**
   * Concrete fix prose (the same content as the legacy
   * `Verification.suggested_fix` field). Lifted into the evidence
   * pack so report/PR readers get one consistent object.
   */
  suggested_fix?: string;
  /**
   * One-line recipe for a regression test that would fail without
   * the fix. Example: "POST /api/upload with body
   * filename=foo;rm%20-rf%20/ — expect 400, no shell exec".
   */
  test_suggestion?: string;
}

export interface Verification {
  verdict: VerifyVerdict;
  reasoning: string;
  /** Legacy single-string path. New code reads `evidence.execution_path_steps` first. */
  execution_path?: string;
  /** Legacy fix string. New code reads `evidence.suggested_fix` first. */
  suggested_fix?: string;
  /**
   * Structured Evidence Pack from the JSON verifier (v2.10.361+).
   * Optional so older serialized verifications still type-check.
   */
  evidence?: VerifierEvidence;
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
   * Stable, deterministic identifier for this finding across audit
   * runs. Computed from sha256(pattern_id + relativePath + normalized
   * matched_text). Survives line-number drift after edits because
   * it doesn't include the line number in the hash. Lets /review
   * commands address findings by an ID that doesn't shift between
   * runs — the legacy integer index still works as a fallback.
   * v2.10.372 (CL.2 of the close-the-loops sweep).
   */
  finding_id?: string;
  /**
   * Free-text reviewer annotation set via `/review … note <idx> "..."`.
   * Distinct from `review_tags` (structured taxonomy) — `review_note`
   * is one-line prose that explains a particular triage decision.
   * v2.10.363 (F5).
   */
  review_note?: string;
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
   * Stable finding ID — same semantics as Finding.finding_id.
   * Lets a reviewer reference an FP across runs without relying
   * on its bucket-local index. v2.10.372 (CL.2).
   */
  finding_id?: string;
  /**
   * /review state — same semantics as on Finding. Lets a reviewer
   * promote a false_positive back to confirmed if they suspect the
   * verifier got it wrong, without losing the original verdict.
   * v2.10.326.
   */
  review_state?: ReviewState;
  review_reason?: ReviewReason;
  review_tags?: string[];
  /** Free-text reviewer annotation. v2.10.363 (F5). */
  review_note?: string;
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
  /**
   * Set when the run was a diff-based audit (`--since <ref>`). Tells
   * downstream consumers that "scanned only X of Y files" reflects a
   * deliberate scope filter, not a coverage gap. The reference matches
   * what was passed to the CLI/option (e.g. "main", "HEAD~10",
   * "origin/main"). v2.10.335.
   */
  since?: string;
  /**
   * When `since` is set: the count of files git reported as changed
   * vs the project's HEAD. Some of those files may not be source
   * files (markdown, lockfiles) and won't appear in scannedFiles.
   * Surfacing both lets the report distinguish "no source changes"
   * from "no diff at all". v2.10.335.
   */
  changedFilesInDiff?: number;
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

/**
 * Quantitative trustworthiness score for an audit run, computed at
 * the end of `runAudit` from the verifier output, coverage, AST
 * grammar status, and FP-quality data the verifier already ships.
 *
 * Five subscores, each in [0, 100]:
 *   - coverage_score    — what fraction of in-scope files actually got scanned
 *   - verifier_score    — what fraction of verifier outputs parsed cleanly
 *   - ast_score         — what fraction of AST grammars loaded successfully
 *   - noise_score       — what fraction of false_positives carry a real mitigation reason
 *   - fixability_score  — what fraction of confirmed findings have a `rewrite`-class fix
 *
 * The aggregate `score` is a weighted average. When a subscore is
 * not derivable for a given run (e.g. `verifier_score` when
 * `--skip-verify` was used) the field is null and the contribution
 * is dropped from the weighted average — the headline number stays
 * meaningful instead of pretending zero.
 *
 * v2.10.362 (F2 of audit product plan).
 */
export interface AuditConfidence {
  /** Aggregate weighted score 0-100. */
  score: number;
  coverage_score: number | null;
  verifier_score: number | null;
  ast_score: number | null;
  noise_score: number | null;
  fixability_score: number | null;
  /**
   * One-line strings describing why subscores are degraded or null.
   * Same flavor as the existing prose warnings (truncation,
   * skipVerify, missing grammars), but tied to the numeric score so
   * the reader knows what's pulling the headline down.
   */
  warnings: string[];
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
  /**
   * Per-pattern statistics, keyed by pattern_id. Populated at scan
   * time for every pattern that produced at least one candidate
   * during the run. Patterns that never matched are absent (vs. with
   * 0 hits) so consumers can distinguish "didn't fire" from "fired
   * but everything passed". v2.10.330.
   */
  pattern_metrics?: Record<string, PatternMetrics>;
  exploits?: ExploitProof[];
  /**
   * Whether the LLM verifier was run on each candidate or skipped
   * entirely (--skip-verify). When "skipped", every candidate is
   * marked confirmed without a real verdict — the report should
   * surface this prominently because the false-positive rate is
   * essentially the regex's own precision, not the verifier's.
   * v2.10.351 P1.
   */
  verification_mode?: "verified" | "skipped";
  /**
   * Per-language AST grammar load status. Present when at least one
   * AST pattern was attempted during the run. Lets the report tell the
   * user that AST coverage is degraded for a specific language and
   * suggest `kcode grammars install`. v2.10.339.
   *
   * Aggregated from the stats array of the AST runner: a language is
   * "loaded" if any pattern of that language reported grammar_loaded:
   * true at least once during the run. Last load_error is captured for
   * the unloaded case so the user sees why.
   */
  ast_grammar_status?: Array<{
    language: string;
    /** Number of AST patterns of this language that ran during the audit. */
    patterns_attempted: number;
    /** True iff at least one pattern of this language successfully parsed at least one file. */
    loaded: boolean;
    /** Most recent load_error seen for this language (when loaded === false). */
    last_error?: string;
  }>;
  /**
   * Quantitative trustworthiness score for this run. Populated by
   * `confidence-scorer.ts` post-audit; absent on legacy AuditResult
   * snapshots. v2.10.362 (F2).
   */
  audit_confidence?: AuditConfidence;
  /**
   * Number of candidates the learning loop pre-marked as
   * needs_context (so the verifier was skipped) because the pattern
   * has been demoted >=10 times in similar paths in this project.
   * v2.10.373 (CL.3). Absent when zero suppressions, so legacy
   * report renderers don't have to special-case the field.
   */
  learning_loop_suppressed?: number;
  /**
   * F9 (v2.10.370) — counts of confirmed findings broken down by
   * vendible pack. Lets the report show "3 ai-ml, 5 web, 0 cloud"
   * so the reader sees which security lens each finding came from.
   * Findings with no pack land in `general`. Absent when no findings
   * exist; the renderer skips the section.
   */
  pack_breakdown?: Record<string, number>;
  /** F9 — the pack the run was scoped to via --pack, if any. */
  scoped_pack?: PatternPack;
  elapsed_ms: number;
}
