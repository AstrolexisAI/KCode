// KCode - Conversation Inline Warning Handler
// Extracted from conversation.ts runAgentLoop — mid-turn repeated-action
// detection via the intention engine. Injects SYSTEM warnings of escalating
// severity into the message log and, past the 5th warning, flags the loop
// for a force-stop after the current turn.

import { getIntentionEngine } from "./intentions";
import type { LoopGuardState } from "./agent-loop-guards";
import { log } from "./logger";
import type { ConversationState } from "./types";

export interface InlineWarningArgs {
  state: ConversationState;
  guardState: LoopGuardState;
}

/**
 * Layer 9: inspect the intention engine for a mid-loop warning about
 * wasted context / repeated tool calls. If present, escalate from a
 * soft warning (first occurrence) to a strong redirect (2+) to a force
 * stop (5+). Mutates `args.state.messages` and `args.guardState`
 * in place. Swallows errors non-fatally.
 */
export function handleInlineWarnings(args: InlineWarningArgs): void {
  try {
    const inlineWarning = getIntentionEngine().getInlineWarning();
    if (inlineWarning) {
      args.guardState.inlineWarningCount++;
      log.warn(
        "intentions",
        `Inline warning #${args.guardState.inlineWarningCount}: ${inlineWarning.slice(0, 100)}`,
      );

      if (args.guardState.inlineWarningCount >= 5) {
        log.warn(
          "intentions",
          "Infinite loop detected: forcing agent loop stop after 5 inline warnings",
        );
        args.state.messages.push({
          role: "user",
          content: `[SYSTEM] FORCE STOP: You have been warned ${args.guardState.inlineWarningCount} times about repeating the same actions. The agent loop is being terminated. Reply with text only — summarize what you accomplished and what you could not complete.`,
        });
        args.guardState.forceStopLoop = true;
      } else if (args.guardState.inlineWarningCount >= 2) {
        log.warn(
          "intentions",
          `Inline warning #${args.guardState.inlineWarningCount}: model repeating actions, injecting strong redirect`,
        );
        args.state.messages.push({
          role: "user",
          content: `[SYSTEM] WARNING #${args.guardState.inlineWarningCount}: You are repeating the same tool calls. The repeated calls are being BLOCKED. MOVE ON to a different task or try a completely different approach. Do NOT keep reading the same file — use offset/limit to read different sections, or use Bash with sed/grep to find what you need.`,
        });
      } else {
        args.state.messages.push({
          role: "user",
          content: `\u26a0\ufe0f SYSTEM WARNING: ${inlineWarning}`,
        });
      }
    }
  } catch (err) {
    log.debug("intention", "Failed to generate inline warning: " + err);
  }
}
