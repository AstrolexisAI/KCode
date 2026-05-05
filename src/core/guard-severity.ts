// KCode - Tiered guard severity + orienting messages
//
// Historically every guard ("audit edit", "phantom typo", "sibling
// proliferation", "grounding check") rendered the same way: a wall-of-text
// ALL-CAPS BLOCKED message with imperative scolds ("STOP guessing", "DO
// NOT"). That style catches the bad action but does not orient the model
// toward the next correct step — open-weights ~30B models in particular
// spiral into Bash heredocs and Write-with-suffix workarounds because
// they have no path forward.
//
// This module standardizes:
//   - Three severity tiers (critical / warning / advisory) with clear
//     contracts for callers.
//   - A `formatGuardMessage` helper that emits a consistent structure:
//        [PROBLEM] one-line statement
//        [CAUSE]   why this is detected (when known)
//        [NEXT]    concrete recovery action
//   - A `GuardResult` shape every guard returns, so the dispatcher
//     decides block-vs-pass based on tier rather than each guard
//     hard-coding "blocked: true".
//
// Migrating an existing guard to this module is a 3-line change:
//   1. Classify its tier.
//   2. Wrap its reason string with formatGuardMessage(...).
//   3. Return a GuardResult instead of an ad-hoc boolean+string.

/**
 * How strictly a guard should be enforced.
 *
 * - **critical**: Always blocks. Reserved for actions with no safe recovery
 *   (irreversible writes, secret leaks, sandbox escape attempts). Message
 *   is terse — no point coaching the model on something it must never do.
 *
 * - **warning**: Blocks the current attempt but the model is expected to
 *   recover. Message MUST include a concrete next step (re-Read, rename,
 *   use the AskUser tool, etc.). Most tool-level safety guards live here:
 *   PHANTOM_TYPO, sibling proliferation, audit-edit-before-report.
 *
 * - **advisory**: Does NOT block. The action proceeds; the guard's hint
 *   is appended to the tool result so the model sees the warning and can
 *   self-correct on the next turn. Use when the heuristic has a real
 *   false-positive rate (edit-location-mismatch, grounding-check).
 */
export type GuardSeverity = "critical" | "warning" | "advisory";

/**
 * What a guard returns. The dispatcher pattern is:
 *   const r = guard(...);
 *   if (r.blocked) return r.message;       // critical/warning paths
 *   if (r.advisoryHint) appendHint(...);   // advisory path
 *
 * `blocked` is derived from severity by the helpers below; callers only
 * need to declare severity. This keeps the rule "advisory never blocks"
 * enforced by construction.
 */
export interface GuardResult {
  severity: GuardSeverity;
  /** True when severity is critical or warning. False for advisory. */
  blocked: boolean;
  /** The full formatted message (for blocked) or hint (for advisory). */
  message: string;
  /** A short identifier for logging, telemetry, and config-based overrides. */
  guardId: string;
}

interface GuardMessageInput {
  /** Stable identifier — appears as `[guardId]` in logs and overrides. */
  guardId: string;
  severity: GuardSeverity;
  /** One-line problem statement. Avoid scolding ("STOP", "DO NOT", caps). */
  problem: string;
  /**
   * Why this was triggered. Optional but strongly recommended — without it
   * the model has to guess what the guard is reacting to.
   */
  cause?: string;
  /**
   * Concrete next step the model can take. REQUIRED for warning-tier;
   * optional for critical (some criticals have no recovery) and advisory
   * (the hint itself usually IS the next step).
   */
  next?: string;
}

/**
 * Compose a guard message with the standard PROBLEM / CAUSE / NEXT shape.
 * The output is plain text, not markdown — many tools render the result
 * verbatim into chat and we want it readable in any frontend.
 */
function formatGuardMessage(input: GuardMessageInput): string {
  const lines: string[] = [];
  const tag =
    input.severity === "critical"
      ? "BLOCKED"
      : input.severity === "warning"
        ? "BLOCKED — recoverable"
        : "Note";
  lines.push(`${tag}: ${input.problem}`);
  if (input.cause) lines.push(`Cause: ${input.cause}`);
  if (input.next) lines.push(`Next step: ${input.next}`);
  lines.push(`(guard: ${input.guardId})`);
  return lines.join("\n");
}

/** Build a critical-tier result — always blocks, terse message. */
export function critical(input: Omit<GuardMessageInput, "severity">): GuardResult {
  return {
    severity: "critical",
    blocked: true,
    guardId: input.guardId,
    message: formatGuardMessage({ ...input, severity: "critical" }),
  };
}

/** Build a warning-tier result — blocks but the model can recover. */
export function warning(input: Omit<GuardMessageInput, "severity">): GuardResult {
  if (!input.next) {
    // Compile-time check would be nicer but we want a runtime safety net
    // so future contributors don't accidentally ship a "warning" with no
    // recovery instruction (which collapses back into the old hostile-
    // BLOCKED behavior the tier was created to fix).
    throw new Error(
      `Guard '${input.guardId}' is warning-tier but missing a 'next' step. ` +
        "Warning-tier guards MUST include concrete recovery instructions.",
    );
  }
  return {
    severity: "warning",
    blocked: true,
    guardId: input.guardId,
    message: formatGuardMessage({ ...input, severity: "warning" }),
  };
}

/** Build an advisory-tier result — never blocks, just appends a hint. */
export function advisory(input: Omit<GuardMessageInput, "severity">): GuardResult {
  return {
    severity: "advisory",
    blocked: false,
    guardId: input.guardId,
    message: formatGuardMessage({ ...input, severity: "advisory" }),
  };
}

/** Helper for adapting legacy boolean+reason guards to the new shape. */
export function passed(): GuardResult {
  return { severity: "advisory", blocked: false, guardId: "passed", message: "" };
}
