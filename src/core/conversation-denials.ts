// KCode - Conversation Denial Tracker
// Extracted from conversation.ts runAgentLoop — escalate consecutive
// permission denials across turns. Short-circuits the loop when the
// configured `deny` mode fires or when MAX_CONSECUTIVE_DENIALS is
// reached, otherwise injects a SYSTEM message pointing the model
// away from retrying the same tool.

import { type LoopGuardState, MAX_CONSECUTIVE_DENIALS } from "./agent-loop-guards";
import { log } from "./logger";
import type { ConversationState, KCodeConfig, StreamEvent } from "./types";

export interface DenialTrackerArgs {
  state: ConversationState;
  guardState: LoopGuardState;
  config: KCodeConfig;
  turnHadDenial: boolean;
}

/**
 * Update the consecutive-denial counter for this turn. Returns a
 * `turn_end` StreamEvent if the loop must terminate (permission limit
 * reached), otherwise null. Mutates `args.state.messages` and
 * `args.guardState.consecutiveDenials` in place for the non-terminating
 * branches.
 */
export function handleConsecutiveDenials(args: DenialTrackerArgs): StreamEvent | null {
  if (!args.turnHadDenial) {
    args.guardState.consecutiveDenials = 0;
    return null;
  }

  args.guardState.consecutiveDenials++;

  if (args.config.permissionMode === "deny") {
    log.info("session", "Deny mode: stopping agent loop after first denial");
    args.state.messages.push({
      role: "user",
      content:
        "[SYSTEM] Permission mode is 'deny'. All tools are blocked. Do NOT attempt any tool calls. Reply with text only, explaining that you cannot perform this action because all tools are blocked. Suggest using -p auto or -p ask.",
    });
    args.guardState.consecutiveDenials = MAX_CONSECUTIVE_DENIALS - 1;
    return null;
  }

  if (args.guardState.consecutiveDenials >= MAX_CONSECUTIVE_DENIALS) {
    log.warn(
      "session",
      `${MAX_CONSECUTIVE_DENIALS} consecutive permission denials, stopping agent loop`,
    );
    return { type: "turn_end", stopReason: "permission_denied" };
  }

  args.state.messages.push({
    role: "user",
    content:
      "[SYSTEM] Tool call was denied by the permission system. Do NOT retry the same tool. Reply with a text message explaining what happened.",
  });
  return null;
}
