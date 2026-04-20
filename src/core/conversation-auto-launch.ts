// KCode - Conversation Phase-22 Auto-Launch Dev Server
// Extracted from conversation.ts runAgentLoop — when the model has
// finished its final response and the agent loop is about to exit,
// optionally auto-launch a dev server (next/vite/npm run dev) based
// on heuristics in ./auto-launch-dev-server. The inner
// hasRuntimeIntent + hasRunnableWriteInTurn guards inside
// maybeAutoLaunchDevServer are sufficient; the outer `stopReason
// === "end_turn"` gate was dropped in v2.10.x because it blocked
// firing on max_tokens and other legitimate end states.

import { log } from "./logger";
import type { ConversationState, StreamEvent } from "./types";

export interface AutoLaunchArgs {
  workingDirectory: string;
  state: ConversationState;
  stopReason: string;
}

/**
 * Run the Phase 22 auto-launch hook. When `maybeAutoLaunchDevServer`
 * fires, push the notice into the assistant history, yield it as a
 * `text_delta`, and log the launch URL. Non-fatal on any import or
 * runtime error.
 */
export async function* autoLaunchDevServerPhase22(
  args: AutoLaunchArgs,
): AsyncGenerator<StreamEvent> {
  try {
    const { maybeAutoLaunchDevServer } = await import("./auto-launch-dev-server.js");
    const { getUserTexts } = await import("./session-tracker.js");
    const launchResult = await maybeAutoLaunchDevServer(
      args.workingDirectory,
      args.state.messages,
      getUserTexts(),
    );
    if (launchResult) {
      args.state.messages.push({
        role: "assistant",
        content: launchResult.notice,
      });
      yield { type: "text_delta", text: launchResult.notice };
      log.info("auto-launch", `phase 22 fired: ${launchResult.url ?? "no url"}`);
    } else {
      log.debug("auto-launch", `phase 22 skipped at break (stopReason=${args.stopReason})`);
    }
  } catch (err) {
    log.debug("auto-launch", `hook failed (non-fatal): ${err}`);
  }
}
