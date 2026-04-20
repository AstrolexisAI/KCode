// KCode - Conversation SSE Stream Acquisition
// Extracted from conversation.ts runAgentLoop — rate-limit, open the
// upstream SSE stream with retry, and on failure classify the error
// as either a user-aborted exit (silent) or a real error (surface
// `error` + `turn_end`). Returns a discriminated union so the caller
// can yield termination events + return in the error branches.

import { log } from "./logger";
import type { RateLimiter } from "./rate-limiter";
import type { SSEChunk } from "./sse-parser";
import type { StreamEvent } from "./types";

export type StreamAcquireResult =
  | { kind: "success"; stream: AsyncGenerator<SSEChunk> }
  | { kind: "terminate"; events: StreamEvent[] };

export interface StreamAcquireArgs {
  rateLimiter: RateLimiter;
  createStream: () => Promise<AsyncGenerator<SSEChunk>>;
  abortSignal: AbortSignal | undefined;
}

/**
 * Acquire the SSE stream for the next LLM request, going through the
 * per-conversation rate limiter. On error, release the rate limiter
 * and classify:
 *   - aborted (user pressed Esc or signal fired) → silent `turn_end`
 *   - any other error → `error` event + `turn_end: "error"`
 */
export async function acquireSseStream(args: StreamAcquireArgs): Promise<StreamAcquireResult> {
  try {
    const _tStream = Date.now();
    await args.rateLimiter.acquire();
    log.debug("perf", `rateLimiter.acquire: ${Date.now() - _tStream}ms`);
    const _tFetch = Date.now();
    const stream = await args.createStream();
    log.debug("perf", `createStreamWithRetry (fetch+connect): ${Date.now() - _tFetch}ms`);
    return { kind: "success", stream };
  } catch (error) {
    args.rateLimiter.release();
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes("aborted") || args.abortSignal?.aborted) {
      return {
        kind: "terminate",
        events: [{ type: "turn_end", stopReason: "aborted" }],
      };
    }
    return {
      kind: "terminate",
      events: [
        {
          type: "error",
          error: error instanceof Error ? error : new Error(String(error)),
          retryable: false,
        },
        { type: "turn_end", stopReason: "error" },
      ],
    };
  }
}
