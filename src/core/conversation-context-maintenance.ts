// KCode - Conversation Context Maintenance
// Extracted from conversation.ts runAgentLoop — the per-turn housekeeping
// that runs before the LLM request: microcompact stale tool results,
// optional debug-trace of compaction thresholds, prune if above the
// compactThreshold, run multi-strategy auto-compaction (image strip /
// micro / full LLM / emergency) and a hard-safety emergency prune if
// still over 95%.

import {
  compactMultiStrategy,
  emergencyPrune,
  estimateContextTokens,
  microcompactToolResults,
  pruneMessagesIfNeeded,
} from "./context-manager";
import type { DebugTracer } from "./debug-tracer";
import { log } from "./logger";
import type { ConversationState, KCodeConfig, StreamEvent, TokenUsage } from "./types";

export interface ContextMaintenanceArgs {
  state: ConversationState;
  systemPrompt: string;
  contextWindowSize: number;
  compactThreshold: number;
  config: KCodeConfig;
  debugTracer: DebugTracer | null;
  /**
   * Last observed input tokens from the LLM's actual response. Used to
   * calibrate the chars-per-token estimate, which defaults to 3.5
   * (English) but Gemma + Spanish + code typically tokenizes at ~2.4
   * chars/token. Without this calibration, KCode would think context
   * was at 60% while actually being at 90%+ → no auto-compact fires →
   * MLX gets a request over its context window and either truncates
   * or crashes (verified 2026-05-10 with Gemma 4 31B Q6, 141k input
   * vs 131k window).
   */
  lastObservedInputTokens?: number;
  /** Total chars sent in the last LLM request — used with above to calibrate. */
  lastObservedInputChars?: number;
}

/**
 * Run the per-turn context-maintenance pipeline. Yields any StreamEvents
 * produced by `pruneMessagesIfNeeded` / `emergencyPrune`. Mutates
 * `args.state.messages` in place via the underlying pruners.
 */
export async function* runContextMaintenance(
  args: ContextMaintenanceArgs,
): AsyncGenerator<StreamEvent> {
  // Microcompact: proactively clear old tool results every turn (zero LLM cost)
  microcompactToolResults(args.state.messages);

  // Prune context if approaching the limit (auto-compacts via LLM when possible)
  if (args.debugTracer?.isEnabled()) {
    const preTokens = estimateContextTokens(args.systemPrompt, args.state.messages);
    const threshold = args.contextWindowSize * args.compactThreshold;
    if (preTokens >= threshold) {
      args.debugTracer.trace(
        "context",
        "Compaction triggered",
        `Estimated ${preTokens} tokens >= threshold ${Math.floor(threshold)} (${Math.round(args.compactThreshold * 100)}% of ${args.contextWindowSize})`,
        { tokens: preTokens, threshold: Math.floor(threshold) },
      );
    }
  }
  yield* pruneMessagesIfNeeded(
    args.state,
    args.systemPrompt,
    args.contextWindowSize,
    args.compactThreshold,
    args.config,
  );

  // AUTO-COMPACT (#111 v285): if tool-result compression + aggressive
  // clearing didn't get us below threshold, run the multi-strategy
  // orchestrator. It escalates through micro-compact (>=60%),
  // LLM-based full summarization (>=75%), and emergency prune (>=90%)
  // so the user doesn't have to type /compact manually. Historically
  // the multi-strategy orchestrator was defined but never wired — the
  // UI would show "context at 100% — /compact soon" and just stay
  // there until the user acted. This closes that loop.
  //
  // Opt-out: KCODE_DISABLE_AUTO_COMPACT=1.
  if (process.env.KCODE_DISABLE_AUTO_COMPACT !== "1") {
    const postPruneEstimate = estimateContextTokens(args.systemPrompt, args.state.messages);

    // Calibrate the estimate with the last observed input tokens. If the
    // model reported (e.g.) 141K input from a request whose chars
    // implied 80K via the 3.5 ratio, the true chars-per-token is closer
    // to 2.0 — apply that ratio to subsequent estimates so we trigger
    // compaction before MLX rejects an overflowing request.
    let calibratedTokens = postPruneEstimate;
    if (
      args.lastObservedInputTokens &&
      args.lastObservedInputChars &&
      args.lastObservedInputChars > 1000
    ) {
      const observedRatio = args.lastObservedInputChars / args.lastObservedInputTokens;
      // Default ratio is 3.5; only correct when observed is materially
      // smaller (model is more verbose than estimate). Don't pump UP
      // estimates if observed is higher — that would trigger spurious
      // compaction on cloud models that pack tighter than 3.5.
      if (observedRatio < 3.0) {
        const correction = 3.5 / observedRatio;
        calibratedTokens = Math.ceil(postPruneEstimate * correction);
        log.debug(
          "session",
          `token-calibration: observed ${observedRatio.toFixed(2)} chars/tok, correcting estimate ${postPruneEstimate} → ${calibratedTokens}`,
        );
      }
    }

    const usage = calibratedTokens / args.contextWindowSize;
    // Trigger multi-strategy at 75% — same as full-compact phase
    // inside the orchestrator. Below that, plain microcompact is
    // enough.
    if (usage >= 0.75) {
      log.info(
        "session",
        `auto-compact: triggering multi-strategy at ${Math.round(usage * 100)}% (~${calibratedTokens} tokens, raw estimate ${postPruneEstimate})`,
      );
      try {
        yield* compactMultiStrategy(
          args.state,
          args.systemPrompt,
          args.contextWindowSize,
          args.config,
        );
      } catch (err) {
        log.warn("session", `auto-compact failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Hard safety: emergency prune if still over 95%
  for (const evt of emergencyPrune(args.state, args.systemPrompt, args.contextWindowSize)) {
    yield evt;
  }
}
