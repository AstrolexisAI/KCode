// KCode - Response Handlers
// Extracted from conversation.ts to reduce the size of runAgentLoop.
// These handlers deal with response continuation, empty responses, truncation detection,
// and post-turn processing.

import { log } from "./logger";
import {
  cacheResponseIfEligible,
  evaluateIntentionSuggestions,
  processKnowledgeAndBenchmark,
  sendDesktopNotification,
} from "./post-turn";
import { looksIncomplete } from "./prompt-analysis";
import type { ContentBlock, StreamEvent } from "./types";

// ─── Types ──────────────────────────────────────────────────────

export type EmptyType =
  | "thinking_only"
  | "tools_only"
  | "thinking_and_tools"
  | "no_output"
  | undefined;

export interface ResponseAction {
  action: "break" | "continue";
  stopReason: string;
  emptyType?: EmptyType;
  /** Extra events to yield before the turn_end */
  extraEvents?: StreamEvent[];
  /** Message to inject as user role */
  injectMessage?: string;
}

// ─── Max Tokens Continue ────────────────────────────────────────

export function handleMaxTokensContinue(
  stopReason: string,
  continuationCount: number,
  turnCount: number,
): ResponseAction | null {
  if (stopReason !== "max_tokens" || continuationCount >= 3) return null;

  log.info(
    "session",
    `Model hit output token limit (continuation ${continuationCount + 1}/3) — injecting continue prompt`,
  );
  return {
    action: "continue",
    stopReason: "max_tokens_continue",
    injectMessage:
      "[SYSTEM] Your previous response was cut off because you hit the output token limit. Continue EXACTLY where you left off. Do not repeat what you already said — pick up mid-sentence if needed.",
  };
}

// ─── Intention Suggestions & Auto-Continue ──────────────────────

export function handleIntentionSuggestions(turnCount: number): {
  suggestions: StreamEvent | null;
  shouldAutoContinue: boolean;
  continueMessage?: string;
} {
  const { suggestions, hasHighPrioritySuggestion } = evaluateIntentionSuggestions();

  const suggestionEvent =
    suggestions.length > 0 ? ({ type: "suggestion" as const, suggestions } as StreamEvent) : null;

  const shouldAutoContinue = hasHighPrioritySuggestion && turnCount <= 3;

  return {
    suggestions: suggestionEvent,
    shouldAutoContinue,
    continueMessage: shouldAutoContinue
      ? "You stopped before completing the task. Continue working — create the actual files and finish what you planned. Do not re-plan, just execute."
      : undefined,
  };
}

// ─── Empty Response Classification & Retry ──────────────────────

export function classifyEmptyResponse(
  hasTextOutput: boolean,
  hasThinkingOutput: boolean,
  hasToolOutput: boolean,
  stopReason: string,
): EmptyType {
  if (hasTextOutput || stopReason !== "end_turn") return undefined;

  if (hasThinkingOutput && !hasToolOutput) return "thinking_only";
  if (hasToolOutput && !hasThinkingOutput) return "tools_only";
  if (hasThinkingOutput && hasToolOutput) return "thinking_and_tools";
  return "no_output";
}

export function handleEmptyResponseRetry(
  emptyType: EmptyType,
  emptyCount: number,
  turnCount: number,
  toolUseCount: number,
): ResponseAction | null {
  if (!emptyType || emptyCount >= 2) return null;

  log.info(
    "session",
    `Empty response (${emptyType}) on turn ${turnCount} — retry ${emptyCount + 1}/2`,
  );

  const retryPrompt =
    emptyType === "thinking_only"
      ? "[SYSTEM] You reasoned but produced no visible answer. Stop thinking and answer the user directly in plain text now."
      : emptyType === "tools_only" || toolUseCount > 0
        ? `[SYSTEM] You executed ${toolUseCount} tools but didn't provide any response text. You MUST now write a brief summary (3-6 sentences) of what you accomplished. Do NOT use any more tools — just respond with text.`
        : emptyType === "thinking_and_tools"
          ? "[SYSTEM] You reasoned and used tools but gave no visible answer. Provide a direct response to the user now."
          : "[SYSTEM] Your previous turn produced no output at all. Respond directly to the user now.";

  return {
    action: "continue",
    stopReason: "empty_response_retry",
    emptyType,
    injectMessage: retryPrompt,
  };
}

// ─── Truncation Detection & Retry ───────────────────────────────

export function handleTruncationRetry(
  fullText: string,
  truncationRetries: number,
): { action: "continue"; injectMessage: string; previousTurnTail: string } | null {
  if (truncationRetries >= 2 || !looksIncomplete(fullText)) return null;

  log.info(
    "session",
    `Response looks truncated (attempt ${truncationRetries + 1}) — pushing for continuation`,
  );
  const tail = fullText.slice(-200);

  return {
    action: "continue",
    injectMessage: `[SYSTEM] Your response was cut off. Here is how it ended:\n\n"…${tail}"\n\nContinue EXACTLY from that point. Do NOT repeat any previous content. Do NOT restart the response. Just write the next sentence.`,
    previousTurnTail: fullText.slice(-300),
  };
}

// ─── Post-Turn Notifications ────────────────────────────────────

export function handlePostTurnNotifications(elapsedMs: number, turnCount: number): void {
  if (elapsedMs > 30_000 || turnCount >= 3) {
    sendDesktopNotification(
      "KCode",
      `Task completed (${turnCount} turns, ${Math.round(elapsedMs / 1000)}s)`,
    );
  }
}
