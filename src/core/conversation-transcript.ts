// KCode - Conversation Transcript Recorder
// Extracted from conversation.ts — fan-out of StreamEvent types into the
// TranscriptManager log. Also tracks tool-error fingerprints on the active
// LoopGuardState so repeat failures burn retry budget.

import type { LoopGuardState } from "./agent-loop-guards";
import { log } from "./logger";
import type { TranscriptManager } from "./transcript";
import type { Message, StreamEvent } from "./types";

export interface TranscriptRecorderContext {
  transcript: TranscriptManager;
  messages: Message[];
  activeGuardState: LoopGuardState | null;
}

export function recordTranscriptEvent(
  ctx: TranscriptRecorderContext,
  event: StreamEvent,
): void {
  switch (event.type) {
    case "text_delta":
      // Text deltas are accumulated — we record the final text in turn_end via messages
      break;
    case "thinking_delta":
      break;
    case "tool_executing":
      ctx.transcript.append(
        "assistant",
        "tool_use",
        JSON.stringify({
          id: event.toolUseId,
          name: event.name,
          input: event.input,
        }),
      );
      break;
    case "tool_result":
      ctx.transcript.append(
        "tool",
        "tool_result",
        JSON.stringify({
          tool_use_id: event.toolUseId,
          name: event.name,
          content: (event.result ?? "").slice(0, 2000),
          is_error: event.isError,
        }),
      );
      // Track error fingerprints for retry discipline
      if (event.isError && event.result && ctx.activeGuardState) {
        const burned = ctx.activeGuardState.recordToolError(event.name, event.result);
        if (burned) {
          log.warn(
            "session",
            `Tool error fingerprint burned: ${event.name} — same error seen twice, will block retries`,
          );
        }
      }
      break;
    case "error":
      ctx.transcript.append("system", "error", event.error.message);
      break;
    case "turn_end": {
      // Record the final assistant text from the last message
      const lastMsg = ctx.messages[ctx.messages.length - 1];
      if (lastMsg?.role === "assistant" && Array.isArray(lastMsg.content)) {
        for (const block of lastMsg.content) {
          if (block.type === "text") {
            ctx.transcript.append("assistant", "assistant_text", block.text);
          } else if (block.type === "thinking") {
            ctx.transcript.append("assistant", "thinking", block.thinking);
          }
        }
      }
      break;
    }
  }
}
