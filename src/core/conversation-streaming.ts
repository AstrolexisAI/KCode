// KCode - SSE Streaming Processor
// Extracted from conversation.ts runAgentLoop — processes the SSE stream from the LLM,
// accumulating assistant content, tool calls, and usage data.

import { log } from "./logger";
import type { SSEChunk } from "./sse-parser";
import { CHARS_PER_TOKEN } from "./token-budget";
import { extractToolCallsFromText } from "./tool-call-extractor";
import type { ToolRegistry } from "./tool-registry";
import type { ContentBlock, StreamEvent, TokenUsage, ToolUseBlock } from "./types";

// ─── Repetition Detection ──────────────────────────────────────
// Detects when a model enters a generation loop (repeating the same
// phrase/pattern). Common with local quantized models.

const REPETITION_CHECK_INTERVAL = 500; // check every N chars of new content
const MAX_OUTPUT_CHARS = 200_000; // hard cap: 200K chars (~50K tokens)
const REPETITION_MIN_PERIOD = 15; // shortest repeating unit to detect
const REPETITION_MAX_PERIOD = 500; // longest repeating unit to detect
const REPETITION_MIN_TEXT = 200; // minimum text length before checking
const REPETITION_CONSECUTIVE = 3; // require 3 consecutive identical blocks

/**
 * Detect repeating patterns in generated text by checking if the tail
 * consists of N consecutive identical blocks (periodicity detection).
 *
 * This catches the common local-model failure mode where output degenerates
 * into "/now, /today, /tomorrow, /yesterday, /now, /today, ..." endlessly.
 *
 * Returns the repeated phrase if a loop is detected, null otherwise.
 */
export function detectRepetitionLoop(text: string): string | null {
  if (text.length < REPETITION_MIN_TEXT) return null;

  const maxPeriod = Math.min(
    REPETITION_MAX_PERIOD,
    Math.floor(text.length / REPETITION_CONSECUTIVE),
  );

  for (let pLen = REPETITION_MIN_PERIOD; pLen <= maxPeriod; pLen++) {
    // Check if the last REPETITION_CONSECUTIVE blocks of length pLen are all identical
    const tail = text.slice(-pLen);
    let allMatch = true;
    for (let i = 1; i < REPETITION_CONSECUTIVE; i++) {
      const start = text.length - (i + 1) * pLen;
      const block = text.slice(start, start + pLen);
      if (block !== tail) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      return tail.length > 60 ? tail.slice(0, 60) + "..." : tail;
    }
  }
  return null;
}

// ─── Types ──────────────────────────────────────────────────────

export interface StreamAccumulator {
  assistantContent: ContentBlock[];
  toolCalls: ToolUseBlock[];
  stopReason: string;
  textChunks: string[];
  turnInputTokens: number;
  turnOutputTokens: number;
  thinkingChunks: string[];
}

export interface ProcessSSEStreamConfig {
  sseStream: AsyncGenerator<SSEChunk>;
  tools: ToolRegistry;
  accumulateUsage: (usage: TokenUsage) => void;
  cumulativeUsage: TokenUsage;
}

// ─── SSE Stream Processing ──────────────────────────────────────

/**
 * Process the SSE stream from the LLM, yielding StreamEvents and returning
 * the accumulated state (assistant content, tool calls, stop reason, etc.)
 *
 * This is the core streaming loop extracted from runAgentLoop.
 */
export async function* processSSEStream(
  cfg: ProcessSSEStreamConfig,
): AsyncGenerator<StreamEvent, StreamAccumulator> {
  const assistantContent: ContentBlock[] = [];
  const toolCalls: ToolUseBlock[] = [];
  let stopReason = "end_turn";
  let turnInputTokens = 0;
  let turnOutputTokens = 0;
  let thinkingChunks: string[] = [];

  const activeToolCalls = new Map<number, { id: string; name: string; argChunks: string[] }>();
  const textChunks: string[] = [];
  let streamedOutputChars = 0;
  let charsSinceRepCheck = 0;
  let repetitionAborted = false;
  const streamStartMs = Date.now();

  for await (const chunk of cfg.sseStream) {
    // Hard abort if repetition was already detected (drain remaining chunks)
    if (repetitionAborted) continue;

    switch (chunk.type) {
      case "thinking_delta": {
        if (chunk.thinking) {
          thinkingChunks.push(chunk.thinking);
          streamedOutputChars += chunk.thinking.length;
          yield { type: "thinking_delta", thinking: chunk.thinking };
        }
        break;
      }

      case "content_delta": {
        if (chunk.content) {
          if (thinkingChunks.length > 0) {
            const fullThinking = thinkingChunks.join("");
            if (fullThinking.trim()) {
              assistantContent.push({ type: "thinking", thinking: fullThinking });
            }
            thinkingChunks = [];
          }
          textChunks.push(chunk.content);
          streamedOutputChars += chunk.content.length;
          charsSinceRepCheck += chunk.content.length;
          yield { type: "text_delta", text: chunk.content };
          const estimatedTokens = Math.round(streamedOutputChars / CHARS_PER_TOKEN);
          yield { type: "token_count", tokens: estimatedTokens };

          // ── Repetition & runaway detection ──────────────────
          if (charsSinceRepCheck >= REPETITION_CHECK_INTERVAL) {
            charsSinceRepCheck = 0;

            // Hard output cap
            if (streamedOutputChars >= MAX_OUTPUT_CHARS) {
              log.warn("llm", `Output exceeded ${MAX_OUTPUT_CHARS} chars — aborting generation`);
              repetitionAborted = true;
              stopReason = "end_turn";
              yield { type: "text_delta", text: "\n\n[Output truncated: exceeded maximum length]" };
              textChunks.push("\n\n[Output truncated: exceeded maximum length]");
              break;
            }

            // Repetition loop detection
            const fullSoFar = textChunks.join("");
            const repeated = detectRepetitionLoop(fullSoFar);
            if (repeated) {
              log.warn("llm", `Repetition loop detected: "${repeated}" — aborting generation`);
              repetitionAborted = true;
              stopReason = "end_turn";
              yield {
                type: "text_delta",
                text: `\n\n[Generation stopped: repetition loop detected]`,
              };
              textChunks.push(`\n\n[Generation stopped: repetition loop detected]`);
              break;
            }
          }
        }
        break;
      }

      case "tool_call_delta": {
        const idx = chunk.toolCallIndex ?? 0;
        let active = activeToolCalls.get(idx);

        if (chunk.toolCallId && chunk.functionName) {
          active = { id: chunk.toolCallId, name: chunk.functionName, argChunks: [] };
          activeToolCalls.set(idx, active);
          yield {
            type: "tool_use_start",
            toolUseId: chunk.toolCallId,
            name: chunk.functionName,
          };
        } else if (!active && chunk.toolCallId) {
          active = { id: chunk.toolCallId, name: "", argChunks: [] };
          activeToolCalls.set(idx, active);
        } else if (!active && chunk.functionName) {
          const id = `call_${Date.now()}_${idx}`;
          active = { id, name: chunk.functionName, argChunks: [] };
          activeToolCalls.set(idx, active);
          yield { type: "tool_use_start", toolUseId: id, name: chunk.functionName };
        }

        if (active && chunk.functionName && !active.name) {
          active.name = chunk.functionName;
          yield { type: "tool_use_start", toolUseId: active.id, name: active.name };
        }

        if (active && chunk.functionArgDelta) {
          active.argChunks.push(chunk.functionArgDelta);
          streamedOutputChars += chunk.functionArgDelta.length;
          yield {
            type: "tool_input_delta",
            toolUseId: active.id,
            partialJson: chunk.functionArgDelta,
          };
          const estimatedTokens = Math.round(streamedOutputChars / CHARS_PER_TOKEN);
          yield { type: "token_count", tokens: estimatedTokens };
        }
        break;
      }

      case "finish": {
        if (chunk.finishReason === "tool_calls") {
          stopReason = "tool_use";
        } else if (chunk.finishReason === "stop") {
          stopReason = "end_turn";
        } else if (chunk.finishReason === "length") {
          stopReason = "max_tokens";
        } else {
          stopReason = chunk.finishReason ?? "end_turn";
        }
        break;
      }

      case "usage": {
        const usage: TokenUsage = {
          inputTokens: chunk.promptTokens ?? 0,
          outputTokens: chunk.completionTokens ?? 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        };
        turnInputTokens += usage.inputTokens;
        turnOutputTokens += usage.outputTokens;
        cfg.accumulateUsage(usage);
        yield { type: "usage_update", usage: { ...cfg.cumulativeUsage } };
        break;
      }
    }
  }

  // Finalize any remaining thinking
  if (thinkingChunks.length > 0) {
    const fullThinking = thinkingChunks.join("");
    if (fullThinking.trim()) {
      assistantContent.push({ type: "thinking", thinking: fullThinking });
    }
    thinkingChunks = [];
  }

  // Finalize text content
  const fullText = textChunks.join("");

  // Extract tool calls from text when the model doesn't use native tool_calls
  if (activeToolCalls.size === 0 && fullText.length > 0) {
    const extracted = extractToolCallsFromText(fullText, cfg.tools);
    if (extracted.length > 0) {
      if (extracted[0]!.prefixText.trim()) {
        assistantContent.push({ type: "text", text: extracted[0]!.prefixText.trim() });
      }
      for (const ext of extracted) {
        const toolBlock: ToolUseBlock = {
          type: "tool_use",
          id: `toolu_text_${crypto.randomUUID().slice(0, 8)}`,
          name: ext.name,
          input: ext.input,
        };
        assistantContent.push(toolBlock);
        toolCalls.push(toolBlock);
      }
      stopReason = "tool_use";
    } else if (fullText.length > 0) {
      assistantContent.push({ type: "text", text: fullText });
    }
  } else if (fullText.length > 0) {
    assistantContent.push({ type: "text", text: fullText });
  }

  // Finalize tool calls from streaming
  for (const [, active] of activeToolCalls) {
    const fullJson = active.argChunks.join("");
    let parsedInput: Record<string, unknown> = {};
    if (fullJson.length > 0) {
      try {
        parsedInput = JSON.parse(fullJson);
      } catch (err) {
        log.debug(
          "parse",
          "Failed to parse tool call JSON (" + fullJson.length + " chars): " + err,
        );
        if (fullJson.length > 50000) {
          parsedInput = {
            _parseError: true,
            _raw: `[truncated: ${fullJson.length} chars of malformed JSON]`,
          };
          log.warn("llm", `Truncated malformed tool args: ${fullJson.length} chars`);
        } else {
          parsedInput = { _parseError: true, _raw: fullJson };
        }
      }
    }
    const toolBlock: ToolUseBlock = {
      type: "tool_use",
      id: active.id,
      name: active.name,
      input: parsedInput,
    };
    assistantContent.push(toolBlock);
    toolCalls.push(toolBlock);
  }

  return {
    assistantContent,
    toolCalls,
    stopReason,
    textChunks,
    turnInputTokens,
    turnOutputTokens,
    thinkingChunks,
  };
}
