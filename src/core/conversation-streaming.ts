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

// ─── Phase 23: large-block repetition detection ────────────────
//
// detectRepetitionLoop (above) requires identical CONSECUTIVE blocks up
// to REPETITION_MAX_PERIOD = 500 chars. That catches short phrase loops
// like "/now, /today, /yesterday, /now, /today..." but MISSES the
// Orbital session failure mode, where grok-4.20 looped on a ~3000-char
// block ("✅ Refactor Final — Barra Superior (Flight Control Room)...")
// twenty times. Block size was above the max period AND the trailing
// instance was mid-generation so the "consecutive identical" test
// never matched.
//
// detectLargeBlockRepetition complements it with a substring-count
// approach: take a short unique fingerprint from the current tail
// region, count how many times that exact fingerprint appears in the
// whole accumulated text, abort if ≥ MIN_OCCURRENCES.

/** Minimum accumulated text before large-block detection runs. */
const LARGE_BLOCK_MIN_TEXT = 1500;
/** Length of the fingerprint substring sampled from the text. */
const LARGE_BLOCK_FINGERPRINT_LEN = 80;
/** Number of fingerprint occurrences required to declare a loop. */
const LARGE_BLOCK_MIN_OCCURRENCES = 3;
/** How far back from the tail the fingerprint is sampled. This is a
 *  "recent but not brand-new" window — we want text that's already
 *  been generated and is likely to be part of a completed repeated
 *  block, not the still-being-generated tail. */
const LARGE_BLOCK_SAMPLE_OFFSET = 400;

/**
 * Detect repeated large blocks by fingerprinting a region of recent
 * text and counting its occurrences across the full transcript.
 *
 * Returns the fingerprint (truncated) if a large-block loop is
 * detected, or null.
 *
 * Complexity: O(n) via String.indexOf. Run at the same cadence as
 * detectRepetitionLoop (every REPETITION_CHECK_INTERVAL chars).
 */
export function detectLargeBlockRepetition(text: string): string | null {
  if (text.length < LARGE_BLOCK_MIN_TEXT) return null;

  // Sample a fingerprint from a stable point: LARGE_BLOCK_SAMPLE_OFFSET
  // characters back from the tail, taking LARGE_BLOCK_FINGERPRINT_LEN
  // characters forward. Whitespace is normalized so minor tokenization
  // differences (e.g. extra newline) don't defeat the match.
  const samplePoint = text.length - LARGE_BLOCK_SAMPLE_OFFSET;
  if (samplePoint < 0) return null;

  const rawFingerprint = text
    .slice(samplePoint, samplePoint + LARGE_BLOCK_FINGERPRINT_LEN);
  const fingerprint = rawFingerprint.replace(/\s+/g, " ").trim();
  if (fingerprint.length < 40) return null; // degenerate / whitespace
  // Skip fingerprints that are mostly punctuation or box-drawing
  // chars — those appear legitimately in code fences and markdown
  // tables and would false-positive on well-formed prose.
  const alnum = fingerprint.match(/[A-Za-z0-9]/g)?.length ?? 0;
  if (alnum < 20) return null;

  const normalizedText = text.replace(/\s+/g, " ");

  // Count non-overlapping occurrences of the fingerprint
  let count = 0;
  let searchIdx = 0;
  while (true) {
    const found = normalizedText.indexOf(fingerprint, searchIdx);
    if (found === -1) break;
    count++;
    if (count >= LARGE_BLOCK_MIN_OCCURRENCES) {
      return fingerprint.length > 60
        ? fingerprint.slice(0, 60) + "..."
        : fingerprint;
    }
    searchIdx = found + fingerprint.length;
  }
  return null;
}

// ─── Phase 23.5: completion-marker loop detection ───────────────
//
// detectLargeBlockRepetition requires a byte-identical 80-char
// fingerprint appearing 3+ times. That fails when the model re-emits
// a completion summary with slightly different wording each time:
//
//   "✅ ¡Aplicación 'Orbital' completada con éxito!..."
//   "✅ ¡Orbital completada!..."
//   "✅ ¡Orbital completada con éxito!..."
//   "✅ ¡Orbital completada!..."
//   "✅ ¡Orbital completada con éxito!..."
//
// Each block is ~2KB of prose with different phrasing, so byte-
// identical fingerprints don't match 3+ times, and phase 23 stays
// silent while the model burns tokens restating the same summary.
//
// This detector scans for completion-marker phrases and counts how
// many DISTINCT occurrences exist in the accumulated text. When the
// model re-emits ≥ 3 completion summaries in a single turn, that's
// almost always a loop — a well-behaved model summarizes exactly
// once.

/** Minimum text length before the completion-marker detector runs. */
const COMPLETION_MARKER_MIN_TEXT = 1500;
/** Number of completion-marker occurrences required to declare a loop. */
const COMPLETION_MARKER_MIN_OCCURRENCES = 3;

/**
 * Patterns that indicate the model is starting a "task complete"
 * summary. Narrow enough to avoid false positives on normal prose —
 * requires a leading ✅, 🎉, or explicit "task complete" phrase
 * near a completion verb (completed, finished, done, listo,
 * creada, generada, etc.).
 */
const COMPLETION_MARKER_PATTERNS: RegExp[] = [
  // ✅ ¡Completada! / ✅ Task complete! / ✅ Done! (must have emoji
  // followed within 80 chars by a completion verb)
  /[✅✔✓🎉🚀]\s*[¡!]?[^\n]{0,80}\b(?:completad[ao]|complete[d]?|creada|creado|generad[ao]|finalizad[ao]|listo|lista|done|finished|ready|terminad[ao])\b/gi,
  // Explicit "task complete", "aplicación creada", "done!", "listo!"
  /\b(?:task\s+complete|aplicaci[oó]n\s+(?:completad[ao]|creada|lista|generad[ao]|terminad[ao])|done[.!]?\s*[¡!]?\s*$|listo\s*[¡!]?\s*$)/gim,
];

/**
 * Detect when the model has emitted multiple completion-summary
 * markers in one streamed turn. Returns the first matching marker
 * phrase when the count reaches COMPLETION_MARKER_MIN_OCCURRENCES,
 * or null otherwise.
 *
 * Deduplicates overlapping matches (two patterns hitting the same
 * phrase only count once) by normalizing to the string-indexed
 * position.
 */
export function detectCompletionMarkerLoop(text: string): string | null {
  if (text.length < COMPLETION_MARKER_MIN_TEXT) return null;

  const positions = new Set<number>();
  let firstMatch: string | null = null;

  for (const pattern of COMPLETION_MARKER_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      if (!firstMatch) {
        firstMatch = m[0].trim().slice(0, 80);
      }
      positions.add(m.index);
      // Prevent zero-length match infinite loop
      if (m.index === pattern.lastIndex) pattern.lastIndex++;
    }
  }

  if (positions.size >= COMPLETION_MARKER_MIN_OCCURRENCES) {
    return firstMatch ?? "completion marker";
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
  /** Abort signal — checked every chunk to allow immediate Esc interruption */
  abortSignal?: AbortSignal;
  /** Callback when a complete tool_use block is ready (for early execution) */
  onToolReady?: (tool: ToolUseBlock) => void;
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
    // Immediate abort on Esc — don't process buffered chunks
    if (cfg.abortSignal?.aborted) break;
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

            // Repetition loop detection. Three complementary detectors:
            //   1. detectRepetitionLoop — short consecutive blocks (≤500 chars)
            //   2. detectLargeBlockRepetition — long byte-identical blocks
            //      (catches "✅ Refactor Final" 20x loop)
            //   3. detectCompletionMarkerLoop — semantic variant of (2)
            //      catches the case where the model re-emits a completion
            //      summary with slightly different wording each time
            //      ("✅ ¡Orbital completada!" / "✅ Aplicación completada
            //      con éxito!" etc.)
            const fullSoFar = textChunks.join("");
            const repeated =
              detectRepetitionLoop(fullSoFar) ||
              detectLargeBlockRepetition(fullSoFar) ||
              detectCompletionMarkerLoop(fullSoFar);
            if (repeated) {
              const tokensSoFar = Math.round(fullSoFar.length / 4);
              log.warn(
                "llm",
                `Repetition loop detected after ~${tokensSoFar} tokens: "${repeated}" — aborting generation`,
              );
              repetitionAborted = true;
              stopReason = "end_turn";
              // Phase 23: actionable abort message so the user knows
              // exactly what to do (not just "sorry loop detected").
              const msg =
                `\n\n[Generation stopped: repetition loop detected after ~${tokensSoFar} tokens.\n` +
                `The model was repeating the same block — usually means context window\n` +
                `saturation or provider instability. Try: /compact (reduce history),\n` +
                `/clear (start fresh), or /toggle (switch model).]`;
              yield { type: "text_delta", text: msg };
              textChunks.push(msg);
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
          cacheCreationInputTokens: chunk.cacheCreationInputTokens ?? 0,
          cacheReadInputTokens: chunk.cacheReadInputTokens ?? 0,
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
    // Notify streaming tool executor that a complete tool call is ready
    if (cfg.onToolReady) cfg.onToolReady(toolBlock);
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
