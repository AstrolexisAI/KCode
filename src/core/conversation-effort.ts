// KCode - Conversation Effort Level
// Extracted from conversation.ts — resolve the effective `maxAgentTurns`
// budget from the user-configured effort level, falling back to the
// effort-classifier's reading of the most recent user message.

import { MAX_AGENT_TURNS } from "./agent-loop-guards";
import type { KCodeConfig, Message } from "./types";

/** Translate an effort level to a concrete maxAgentTurns budget. */
function effortLevelToMaxTurns(level: KCodeConfig["effortLevel"]): number {
  switch (level) {
    case "low":
      return 5;
    case "high":
      return 40;
    case "max":
      return 60;
    default:
      return MAX_AGENT_TURNS; // "medium" or unset = 25
  }
}

/**
 * Return the effective max agent turns for the current conversation:
 * use `config.effortLevel` if set, otherwise infer from the most
 * recent user message via the effort-classifier (only if confidence
 * is at least 0.5). Falls through to MAX_AGENT_TURNS when neither
 * path yields a level.
 */
export function getEffectiveMaxTurns(config: KCodeConfig, messages: Message[]): number {
  let level = config.effortLevel;
  if (!level) {
    try {
      const { classifyEffort } =
        require("./effort-classifier") as typeof import("./effort-classifier");
      const recentUserMsg =
        messages
          .filter((m) => m.role === "user")
          .map((m) => (typeof m.content === "string" ? m.content : ""))
          .pop() ?? "";
      if (recentUserMsg) {
        const result = classifyEffort(recentUserMsg);
        if (result.confidence >= 0.5) level = result.level;
      }
    } catch {
      /* effort-classifier not available, use default */
    }
  }
  return effortLevelToMaxTurns(level);
}
