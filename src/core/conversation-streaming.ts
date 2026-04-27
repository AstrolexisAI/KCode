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

// Phase 33 — reasoning-channel repetition guard.
//
// The output-channel detectors (phase 15 / 23) only run when content
// deltas arrive. Reasoning/thinking deltas pass through untouched,
// which let grok-code-fast-1 burn ~45,600 reasoning tokens on a loop
// of identical "Boosting user engagement" / "Fostering user satisfaction"
// meta-paragraphs before anything user-visible came back (kcode.log
// session, v2.10.79, line ~432: "Reasoned (45.6K tok, 2331 lines)").
//
// Phase 33 runs the same detectors on the accumulated thinking buffer
// at a coarser interval (thinking is naturally more verbose than
// output so we don't want to scan every 500 chars) and enforces a
// hard cap slightly below the output cap, since runaway reasoning
// with zero output is a stronger failure signal than a long but
// useful answer.
const THINKING_REPETITION_INTERVAL = 1500; // check every ~400 tokens
const MAX_THINKING_CHARS = 160_000; // hard cap: ~40K tokens of reasoning
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

  const rawFingerprint = text.slice(samplePoint, samplePoint + LARGE_BLOCK_FINGERPRINT_LEN);
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
      return fingerprint.length > 60 ? fingerprint.slice(0, 60) + "..." : fingerprint;
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
  /[✅✔✓🎉🚀]\s*[¡!]?[^\n]{0,80}\b(?:completad[ao]|complete[d]?|creada|creado|generad[ao]|finalizad[ao]|listo|lista|done|finished|ready|terminad[ao])\b/giu,
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

// ─── Phase 33: low-entropy thinking loop detector ───────────────
//
// The existing detectors all rely on byte-identical or near-byte-
// identical repetition. The grok-code-fast-1 reasoning loop from
// the v2.10.79 session fooled them because each paragraph had a
// different heading ("Boosting user engagement", "Fostering user
// satisfaction", "Strengthening user autonomy", ...) but all five
// bullet points in each paragraph said essentially the same thing
// using the same ~30 vocabulary words ("user", "engagement",
// "Info-level messaging", "check-ins", "prompts", "control",
// "maintain", "foster", etc.).
//
// Lexical-entropy detection catches this class: if ≥35% of the
// tokens in a 150+ word buffer are repeats of tokens already seen
// in the same buffer, the model is almost certainly stuck. A
// legitimate thinking trace on a hard problem has ~10-15% repeats
// at most, because each paragraph introduces new topic words.
//
// Runs alongside the other detectors on the thinking channel.

/** Minimum filtered-word count before the detector runs. */
const LOW_ENTROPY_MIN_WORDS = 150;
/** Ratio of repeated non-stopword tokens above which we flag a loop. */
const LOW_ENTROPY_REPEAT_THRESHOLD = 0.35;

// Common function words that legitimate text repeats freely. Keep
// this list short — aggressive stop-word removal hides signal.
const LOW_ENTROPY_STOP_WORDS = new Set([
  // English
  "the",
  "and",
  "that",
  "this",
  "for",
  "with",
  "are",
  "from",
  "have",
  "has",
  "will",
  "not",
  "can",
  "but",
  "out",
  "more",
  "some",
  "what",
  "you",
  "your",
  "they",
  "their",
  "them",
  "also",
  "into",
  "over",
  "than",
  "then",
  "when",
  "which",
  "who",
  "how",
  "why",
  "where",
  "while",
  "each",
  "both",
  "most",
  "such",
  "just",
  "like",
  "much",
  "very",
  "only",
  "other",
  "another",
  "first",
  "next",
  "many",
  "few",
  "own",
  "made",
  "make",
  "way",
  "our",
  "its",
  "been",
  "being",
  "were",
  "was",
  "there",
  "here",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "one",
  "two",
  "three",
  "all",
  "any",
  "new",
  "get",
  "use",
  // Spanish
  "para",
  "con",
  "los",
  "las",
  "que",
  "son",
  "por",
  "una",
  "pero",
  "como",
  "esta",
  "este",
  "tiene",
  "ser",
  "desde",
  "más",
  "mas",
  "hacer",
  "sobre",
  "entre",
  "hasta",
  "donde",
  "cuando",
  "porque",
  "muy",
  "ya",
  "también",
  "todo",
  "toda",
  "todos",
  "todas",
  "sin",
  "hay",
  "han",
  "fue",
  "son",
  "será",
  "sería",
  "podría",
  "debería",
]);

/**
 * Detect a low-entropy thinking loop — a block of text whose
 * non-stopword tokens are predominantly repeats of earlier tokens.
 *
 * Returns a short diagnostic string (most common word + count) if a
 * loop is detected, or null.
 */
export function detectLowEntropyLoop(text: string): string | null {
  // Extract words (Latin + Spanish-accented letters, 3+ chars)
  const words = text.toLowerCase().match(/[a-záéíóúñü]{3,}/g);
  if (!words) return null;

  const filtered = words.filter((w) => !LOW_ENTROPY_STOP_WORDS.has(w));
  if (filtered.length < LOW_ENTROPY_MIN_WORDS) return null;

  const counts = new Map<string, number>();
  for (const w of filtered) counts.set(w, (counts.get(w) ?? 0) + 1);

  let totalRepeats = 0;
  let topWord = "";
  let topCount = 0;
  for (const [w, count] of counts) {
    if (count > 1) totalRepeats += count - 1;
    if (count > topCount) {
      topCount = count;
      topWord = w;
    }
  }

  const ratio = totalRepeats / filtered.length;
  if (ratio >= LOW_ENTROPY_REPEAT_THRESHOLD) {
    return `low-entropy loop (${Math.round(ratio * 100)}% repeated non-stopword tokens; "${topWord}" ×${topCount} in ${filtered.length} words)`;
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
  // Phase 33: independent counter for the thinking channel so phase 15
  // on content doesn't compete with the reasoning-loop detector.
  let thinkingCharsSinceRepCheck = 0;
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
          thinkingCharsSinceRepCheck += chunk.thinking.length;
          yield { type: "thinking_delta", thinking: chunk.thinking };

          // Phase 33 — reasoning-channel runaway / repetition guard.
          // Mirrors the content-channel logic below but runs on the
          // thinking buffer, which was previously unguarded. Without
          // this, a model stuck in a reasoning loop emits nothing to
          // the content stream, so phase 15/23 never fires and the
          // user just watches 45K reasoning tokens tick by (see
          // kcode.log from v2.10.79 grok-code-fast-1 session).
          if (thinkingCharsSinceRepCheck >= THINKING_REPETITION_INTERVAL) {
            thinkingCharsSinceRepCheck = 0;
            const thinkingSoFar = thinkingChunks.join("");

            // Hard cap on reasoning length. 160K chars is well past
            // what legitimate extended-thinking needs (Claude extended
            // thinking rarely exceeds 80K chars for hard problems),
            // so anything longer is almost certainly a loop.
            if (thinkingSoFar.length >= MAX_THINKING_CHARS) {
              log.warn(
                "llm",
                `Reasoning exceeded ${MAX_THINKING_CHARS} chars with zero output — aborting generation`,
              );
              repetitionAborted = true;
              stopReason = "repetition_aborted";
              yield {
                type: "turn_end",
                stopReason: "repetition_aborted",
                emptyType: "thinking_only",
              } as import("./types").StreamEvent;
              break;
            }

            // Run the four detectors against the reasoning buffer:
            // - detectRepetitionLoop: short consecutive blocks
            // - detectLargeBlockRepetition: byte-identical long blocks
            // - detectCompletionMarkerLoop: semantic completion markers
            // - detectLowEntropyLoop: near-duplicate paragraphs with
            //   different headings but the same vocabulary (THE
            //   grok-code-fast-1 failure mode — the other three
            //   didn't catch this because headings differed).
            const repeated =
              detectRepetitionLoop(thinkingSoFar) ||
              detectLargeBlockRepetition(thinkingSoFar) ||
              detectCompletionMarkerLoop(thinkingSoFar) ||
              detectLowEntropyLoop(thinkingSoFar);
            if (repeated) {
              const tokensSoFar = Math.round(thinkingSoFar.length / CHARS_PER_TOKEN);
              log.warn(
                "llm",
                `Reasoning-channel loop detected after ~${tokensSoFar} tokens: "${repeated}" — aborting generation`,
              );
              repetitionAborted = true;
              // Use a dedicated stopReason so handlePostTurn and stream-handler
              // don't mistake this for a truncated response and trigger retries.
              stopReason = "repetition_aborted";
              // Emit as a warning event (not text_delta) so it doesn't land in
              // textChunks and won't trigger looksIncomplete / truncation retry.
              yield {
                type: "turn_end",
                stopReason: "repetition_aborted",
                emptyType: "thinking_only",
              } as import("./types").StreamEvent;
              break;
            }
          }
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

            // Repetition loop detection. Four complementary detectors:
            //   1. detectRepetitionLoop — short consecutive blocks (≤500 chars)
            //   2. detectLargeBlockRepetition — long byte-identical blocks
            //      (catches "✅ Refactor Final" 20x loop)
            //   3. detectCompletionMarkerLoop — semantic variant of (2)
            //      catches the case where the model re-emits a completion
            //      summary with slightly different wording each time
            //   4. detectLowEntropyLoop — near-duplicate paragraphs with
            //      different headings but the same vocabulary (catches
            //      the grok-code-fast-1 "Fostering user empowerment /
            //      Promoting user autonomy / ..." failure mode in ≤1KB
            //      instead of waiting ~7K tokens for (2) to trip).
            const fullSoFar = textChunks.join("");
            const repeated =
              detectRepetitionLoop(fullSoFar) ||
              detectLargeBlockRepetition(fullSoFar) ||
              detectCompletionMarkerLoop(fullSoFar) ||
              detectLowEntropyLoop(fullSoFar);
            if (repeated) {
              const tokensSoFar = Math.round(fullSoFar.length / 4);
              log.warn(
                "llm",
                `Repetition loop detected after ~${tokensSoFar} tokens: "${repeated}" — aborting generation`,
              );
              repetitionAborted = true;
              stopReason = "repetition_aborted";
              yield {
                type: "turn_end",
                stopReason: "repetition_aborted",
                emptyType: undefined,
              } as import("./types").StreamEvent;
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
      // Track this as a hallucination: the model emitted tool calls as text
      // rather than via the native tool_calls API. Useful for session-level
      // blacklisting of models that do this repeatedly and waste tokens.
      try {
        const { recordToolHallucination } = await import("./model-reliability.js");
        recordToolHallucination();
      } catch {
        /* module absent — tracking optional */
      }

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
