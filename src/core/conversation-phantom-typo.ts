// KCode - Conversation Phantom-Typo Detector
// Extracted from conversation.ts runAgentLoop — Phase 32 guard. Scans
// the assistant's prose for "X en lugar de X" (phantom-typo) claims
// and stashes the detection on the active LoopGuardState so the tool
// executor can block any Edit/MultiEdit that follows. The guard is
// reset at the top of each turn so a claim from turn N does not leak
// into turn N+1.

import type { LoopGuardState } from "./agent-loop-guards";
import { log } from "./logger";

/**
 * Run the phantom-typo detector against the assistant's accumulated
 * text for the turn. Mutates `guardState.activePhantomClaim` in place.
 * Non-fatal on detector import / runtime errors — resets the claim
 * to null so we never stash stale state.
 */
export async function detectPhantomTypoForTurn(
  guardState: LoopGuardState,
  fullText: string,
): Promise<void> {
  try {
    const { detectPhantomTypoClaim } = await import("./phantom-typo-detector.js");
    const phantomMatch = detectPhantomTypoClaim(fullText);
    if (phantomMatch) {
      guardState.activePhantomClaim = phantomMatch;
      log.warn(
        "phase-32",
        `phantom-typo claim detected: "${phantomMatch.phrase.slice(0, 80)}" (token="${phantomMatch.token}")`,
      );
    } else {
      guardState.activePhantomClaim = null;
    }
  } catch (err) {
    log.debug("phase-32", `detector failed (non-fatal): ${err}`);
    guardState.activePhantomClaim = null;
  }
}
