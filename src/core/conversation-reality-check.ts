// KCode - Conversation Phase-28 Reality Check
// Extracted from conversation.ts runAgentLoop — when the agent loop is
// about to exit and the assistant claimed a fix was applied but zero
// mutation tools succeeded in this turn, emit a USER-VISIBLE warning
// before the turn actually ends. Phase 15 fires on the NEXT turn as a
// reminder to the model; Phase 28 fires IN-TURN so the user reads the
// warning before trusting the false green checkmark.
//
// Canonical trigger: v2.10.72 Nexus Telemetry chart session where the
// model claimed "✅ AUDIT & FIX APLICADO" with zero successful mutations
// while the chart bug remained.

import { log } from "./logger";
import type { Message, StreamEvent } from "./types";

export interface RealityCheckArgs {
  textChunks: string[];
  messages: Message[];
}

/**
 * Run the Phase 28 hallucinated-completion check and yield a
 * user-visible `text_delta` warning when the current turn's assistant
 * text claims a fix while zero mutation tools succeeded. Non-fatal on
 * import / runtime errors — always logs and continues without yielding.
 */
export async function* checkRealityPhase28(args: RealityCheckArgs): AsyncGenerator<StreamEvent> {
  try {
    const { checkClaimReality, countSuccessfulMutations } = await import(
      "./claim-reality-check.js"
    );
    // Build the current turn's assistant text from textChunks (collected
    // during streaming) rather than walking the message history, since
    // the assistant message hasn't been pushed yet when postTurn fires.
    const currentAssistantText = args.textChunks.join("");
    if (!currentAssistantText) return;

    const verdict = checkClaimReality(currentAssistantText, args.messages);
    if (verdict.isHallucinatedCompletion) {
      const warning =
        `\n\n⚠️  REALITY CHECK (shown to user)\n` +
        `   The assistant claimed a fix was applied but ZERO mutation\n` +
        `   tools (Write/Edit/MultiEdit/GrepReplace) succeeded in this\n` +
        `   turn. ${verdict.claims.length} completion claim(s) detected in the\n` +
        `   assistant's text. The file was NOT modified.\n` +
        `   \n` +
        `   Before trusting the fix, re-prompt with "show me the Read\n` +
        `   output first" or verify the file contents directly.`;
      yield { type: "text_delta", text: warning };
      log.info(
        "reality-check",
        `phase 28 fired: ${verdict.claims.length} claims, 0 mutations in current turn`,
      );
    } else {
      // Compute the count for logging visibility into near-fires
      const { successful } = countSuccessfulMutations(args.messages);
      log.debug(
        "reality-check",
        `phase 28 skipped: ${verdict.claims.length} claims, ${successful} mutations`,
      );
    }
  } catch (err) {
    log.debug("reality-check", `phase 28 failed (non-fatal): ${err}`);
  }
}
