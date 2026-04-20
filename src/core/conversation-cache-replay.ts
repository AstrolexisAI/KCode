// KCode - Conversation Cache Replay
// Extracted from conversation.ts runAgentLoop — stream a cached response
// back to the caller as simulated text_delta events, then a turn_end.
// Used when `getCachedResponse(cacheKey)` returns a hit before the LLM
// request goes out.

import { log } from "./logger";
import type { ContentBlock, ConversationState, StreamEvent } from "./types";

export interface CacheReplayArgs {
  state: ConversationState;
  cachedText: string;
  textChunks: string[];
  assistantContent: ContentBlock[];
}

/**
 * Replay `args.cachedText` as word-chunked `text_delta` events, then
 * emit a `turn_end` with `end_turn`. Appends each chunk to the mutable
 * `args.textChunks` and the full text to `args.assistantContent` so
 * the caller's bookkeeping matches a live LLM response. Also appends
 * the assistant message to `args.state.messages`.
 */
export async function* replayFromCache(args: CacheReplayArgs): AsyncGenerator<StreamEvent> {
  log.info("cache", "Cache hit — replaying response");
  const words = args.cachedText.split(" ");
  for (let wi = 0; wi < words.length; wi++) {
    const chunk = (wi > 0 ? " " : "") + words[wi];
    yield { type: "text_delta", text: chunk };
    args.textChunks.push(chunk);
  }
  args.assistantContent.push({ type: "text", text: args.cachedText });
  args.state.messages.push({ role: "assistant", content: args.cachedText });
  yield { type: "turn_end", stopReason: "end_turn" };
}
