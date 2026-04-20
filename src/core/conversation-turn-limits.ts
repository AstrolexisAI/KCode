// KCode - Conversation Turn-Count Guards
// Extracted from conversation.ts runAgentLoop — three-stage guard that
// fires before each iteration's LLM request: hard-kill above the max,
// soft force-stop at the max, a mid-run nudge at turn 15, and an
// abort-signal early return.

import type { LoopGuardState } from "./agent-loop-guards";
import type { DebugTracer } from "./debug-tracer";
import { log } from "./logger";
import type { ConversationState, KCodeConfig, StreamEvent } from "./types";

export interface TurnLimitArgs {
  turnCount: number;
  effectiveMaxTurns: number;
  state: ConversationState;
  guardState: LoopGuardState;
  config: KCodeConfig;
  debugTracer: DebugTracer | null;
}

/**
 * Enforce the per-conversation turn budget. Stages:
 *   turn > max+1  → hard-kill (return force_stop; caller ends loop)
 *   turn > max    → mark `forceStopLoop` and inject a STOP message
 *                   so the next turn produces a final text summary
 *   turn === 15   → inject a softer "wrap up soon" nudge
 * Returns a `turn_end` StreamEvent when the caller must terminate,
 * otherwise null.
 */
export function enforceTurnLimit(args: TurnLimitArgs): StreamEvent | null {
  const { turnCount, effectiveMaxTurns, state, guardState, config, debugTracer } = args;

  if (turnCount > effectiveMaxTurns + 1) {
    log.warn("session", `Agent loop hard-killed at turn ${turnCount} — model refused to stop`);
    return { type: "turn_end", stopReason: "force_stop" };
  }

  if (turnCount > effectiveMaxTurns) {
    log.warn("session", `Agent loop exceeded ${effectiveMaxTurns} turns, forcing stop`);
    if (debugTracer?.isEnabled()) {
      debugTracer.traceGuard(
        "max-turns",
        true,
        `Turn ${turnCount} exceeds limit of ${effectiveMaxTurns} (effort: ${config.effortLevel ?? "medium"})`,
      );
    }
    state.messages.push({
      role: "user",
      content: `[SYSTEM] STOP. You have used ${turnCount} consecutive tool turns. Summarize what you accomplished and stop. Do NOT make any more tool calls.`,
    });
    guardState.forceStopLoop = true;
    return null;
  }

  if (turnCount === 15) {
    state.messages.push({
      role: "user",
      content:
        "[SYSTEM] You have been running tools for 15 turns. Please wrap up your current task soon and report your progress. Only continue if you are close to finishing.",
    });
  }

  return null;
}

/**
 * Check whether an AbortController signal has fired; if so, return the
 * `aborted` StreamEvent so the caller can yield and exit the loop.
 */
export function checkAborted(signal: AbortSignal | undefined): StreamEvent | null {
  if (signal?.aborted) {
    return { type: "turn_end", stopReason: "aborted" };
  }
  return null;
}
