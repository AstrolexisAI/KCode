// KCode - SSE Stream Parsers
// Handles parsing of Server-Sent Events from OpenAI-compatible and Anthropic APIs

import { createThinkTagParser } from "./think-tag-parser";
import { log } from "./logger";

const SSE_DEBUG = process.env.KCODE_DEBUG_SSE === "1";

// Auto-elevate log level when SSE debug is enabled
if (SSE_DEBUG && !process.env.KCODE_LOG_LEVEL) {
  process.env.KCODE_LOG_LEVEL = "debug";
}

export interface SSEChunk {
  type: "content_delta" | "thinking_delta" | "tool_call_delta" | "finish" | "usage" | "error";
  // content_delta
  content?: string;
  // thinking_delta (Qwen3 reasoning_content)
  thinking?: string;
  // tool_call_delta
  toolCallIndex?: number;
  toolCallId?: string;
  functionName?: string;
  functionArgDelta?: string;
  // finish
  finishReason?: string;
  // usage
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Parse an SSE stream from the OpenAI-compatible API and yield structured chunks.
 */
export async function* parseSSEStream(
  response: Response,
): AsyncGenerator<SSEChunk> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Streaming parser for <think>/<reasoning> tag extraction from content
  const thinkParser = createThinkTagParser();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue; // Skip empty lines and comments

        if (trimmed === "data: [DONE]") {
          return;
        }

        if (trimmed.startsWith("data: ")) {
          const jsonStr = trimmed.slice(6);
          let parsed: any;
          try {
            parsed = JSON.parse(jsonStr);
          } catch {
            continue; // Skip malformed JSON
          }

          if (SSE_DEBUG) {
            log.debug("sse", `SSE chunk: ${jsonStr.slice(0, 300)}`);
          }

          const choice = parsed.choices?.[0];
          if (!choice) {
            // Check for usage-only messages
            if (parsed.usage) {
              yield {
                type: "usage",
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
              };
            }
            continue;
          }

          const delta = choice.delta;
          const finishReason = choice.finish_reason;

          if (SSE_DEBUG) {
            const fields: string[] = [];
            if (delta?.content) fields.push(`content(${delta.content.length})`);
            if (delta?.reasoning_content) fields.push(`reasoning(${delta.reasoning_content.length})`);
            if (delta?.tool_calls) fields.push(`tool_calls(${delta.tool_calls.length})`);
            if (finishReason) fields.push(`finish=${finishReason}`);
            if (fields.length > 0) log.debug("sse", `SSE delta: ${fields.join(", ")}`);
          }

          // Thinking delta (native reasoning_content field — vLLM, OpenRouter, etc.)
          if (delta?.reasoning_content) {
            yield { type: "thinking_delta", thinking: delta.reasoning_content };
          }

          // Content delta — with thinking tag extraction for models that embed thinking in content
          if (delta?.content) {
            for (const ev of thinkParser.feed(delta.content)) {
              if (ev.type === "thinking") {
                yield { type: "thinking_delta", thinking: ev.text };
              } else {
                yield { type: "content_delta", content: ev.text };
              }
            }
          }

          // Tool call deltas
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              yield {
                type: "tool_call_delta",
                toolCallIndex: tc.index ?? 0,
                toolCallId: tc.id ?? undefined,
                functionName: tc.function?.name ?? undefined,
                functionArgDelta: tc.function?.arguments ?? undefined,
              };
            }
          }

          // Finish reason
          if (finishReason) {
            yield { type: "finish", finishReason };
          }

          // Usage in chunk
          if (parsed.usage) {
            yield {
              type: "usage",
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
            };
          }
        }
      }
    }

    // Flush any remaining think-tag buffer
    for (const ev of thinkParser.flush()) {
      if (ev.type === "thinking") {
        yield { type: "thinking_delta", thinking: ev.text };
      } else {
        yield { type: "content_delta", content: ev.text };
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
        try {
          const parsed = JSON.parse(trimmed.slice(6));
          if (parsed.usage) {
            yield {
              type: "usage",
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
            };
          }
        } catch {
          // ignore
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse an SSE stream from Anthropic's Messages API and yield structured chunks.
 * Anthropic uses event: lines before data: lines, and a different JSON structure.
 */
export async function* parseAnthropicSSEStream(
  response: Response,
): AsyncGenerator<SSEChunk> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEventType = "";
  // Track content block types by index so we know if a delta is text or tool input
  const blockTypes = new Map<number, string>(); // index -> "text" | "tool_use"
  const blockToolIds = new Map<number, string>(); // index -> tool_use id

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;

        // Track event type
        if (trimmed.startsWith("event: ")) {
          currentEventType = trimmed.slice(7).trim();
          continue;
        }

        if (!trimmed.startsWith("data: ")) continue;

        let parsed: any;
        try {
          parsed = JSON.parse(trimmed.slice(6));
        } catch {
          continue;
        }

        switch (currentEventType) {
          case "message_start": {
            // Contains usage.input_tokens
            const usage = parsed.message?.usage;
            if (usage) {
              yield {
                type: "usage",
                promptTokens: usage.input_tokens ?? 0,
                completionTokens: usage.output_tokens ?? 0,
              };
            }
            break;
          }

          case "content_block_start": {
            const idx = parsed.index ?? 0;
            const block = parsed.content_block;
            if (block?.type === "tool_use") {
              blockTypes.set(idx, "tool_use");
              blockToolIds.set(idx, block.id ?? "");
              yield {
                type: "tool_call_delta",
                toolCallIndex: idx,
                toolCallId: block.id,
                functionName: block.name,
              };
            } else if (block?.type === "thinking") {
              blockTypes.set(idx, "thinking");
            } else if (block?.type === "text") {
              blockTypes.set(idx, "text");
            }
            break;
          }

          case "content_block_delta": {
            const idx = parsed.index ?? 0;
            const delta = parsed.delta;

            if (delta?.type === "thinking_delta" && delta.thinking) {
              yield { type: "thinking_delta", thinking: delta.thinking };
            } else if (delta?.type === "text_delta" && delta.text) {
              yield { type: "content_delta", content: delta.text };
            } else if (delta?.type === "input_json_delta" && delta.partial_json !== undefined) {
              yield {
                type: "tool_call_delta",
                toolCallIndex: idx,
                toolCallId: blockToolIds.get(idx),
                functionArgDelta: delta.partial_json,
              };
            }
            break;
          }

          case "content_block_stop": {
            // Block finished — nothing special needed
            break;
          }

          case "message_delta": {
            // Contains stop_reason and output usage
            if (parsed.delta?.stop_reason) {
              const reason = parsed.delta.stop_reason;
              // Map Anthropic stop reasons to our internal format
              const mapped = reason === "end_turn" ? "stop"
                : reason === "tool_use" ? "tool_calls"
                : reason === "max_tokens" ? "length"
                : reason === "stop_sequence" ? "stop"
                : reason;
              yield { type: "finish", finishReason: mapped };
            }
            if (parsed.usage) {
              yield {
                type: "usage",
                promptTokens: parsed.usage.input_tokens ?? 0,
                completionTokens: parsed.usage.output_tokens ?? 0,
              };
            }
            break;
          }

          case "message_stop": {
            // Stream complete
            return;
          }

          case "error": {
            const errMsg = parsed.error?.message ?? "Unknown Anthropic API error";
            yield { type: "error", content: errMsg };
            return;
          }
        }

        currentEventType = ""; // Reset after processing
      }
    }
  } finally {
    reader.releaseLock();
  }
}
