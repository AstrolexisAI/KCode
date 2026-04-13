// KCode - Context Manager
// Extracted from conversation.ts — context window management, pruning, and compaction

import { CompactionCircuitBreaker, compact as multiStrategyCompact } from "./compaction/index.js";
import type { LlmSummarizer } from "./compaction/types.js";
import { log } from "./logger";
import { CHARS_PER_TOKEN } from "./token-budget";
import type { ConversationState, KCodeConfig, Message, StreamEvent } from "./types";

// ─── Constants ──────────────────────────────────────────────────

/** Default char estimate for non-string tool_result blocks. */
const DEFAULT_BLOCK_CHARS = 100;
/** Minimum tool_result size (chars) before compression kicks in. */
const COMPRESS_THRESHOLD_CHARS = 500;
/** Number of recent messages to protect from compression/pruning. */
const KEEP_RECENT_MESSAGES = 10;
/** Number of initial messages to always preserve (first user message). */
const KEEP_FIRST_MESSAGES = 1;
/** Minimum messages required before pruning is attempted. */
const MIN_MESSAGES_FOR_PRUNING = 4;
/** Emergency prune: context usage fraction that triggers hard drop. */
const EMERGENCY_THRESHOLD = 0.95;
/** Emergency prune: minimum number of messages to keep before allowing emergency drop. */
const EMERGENCY_MIN_MESSAGES = 6;
/** Emergency prune: fraction of messages to drop. */
const EMERGENCY_DROP_RATIO = 0.3;
/** Emergency prune: absolute minimum messages to drop. */
const EMERGENCY_MIN_DROP = 2;

// ─── Context Token Estimation ────────────────────────────────────

/** Rough estimate of current context size in tokens from message content. */
export function estimateContextTokens(systemPrompt: string, messages: Message[]): number {
  let chars = systemPrompt.length;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "tool_result") {
          chars += typeof block.content === "string" ? block.content.length : DEFAULT_BLOCK_CHARS;
        } else if (block.type === "tool_use") {
          chars += JSON.stringify(block.input).length;
        }
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// ─── Microcompact (proactive tool result clearing) ──────────────

/** Number of recent tool results to keep intact during microcompact. */
const MICROCOMPACT_KEEP_RECENT = 3;
/** Minimum tool results before microcompact triggers. */
const MICROCOMPACT_MIN_RESULTS = 5;
/** Sentinel string for cleared tool results. */
const CLEARED_SENTINEL = "[Old tool result cleared to save context]";

/**
 * Proactively clear old tool_result content before hitting the context limit.
 * Unlike full compaction, this is zero-cost (no LLM call) — just replaces old
 * tool result strings with a sentinel. Keeps the N most recent tool results intact.
 * Returns number of results cleared.
 */
export function microcompactToolResults(messages: Message[]): number {
  // Collect indices of all tool_result blocks (message index, block index)
  const toolResults: Array<{ mi: number; bi: number; chars: number }> = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]!;
    if (!Array.isArray(msg.content)) continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi]!;
      if (
        block.type === "tool_result" &&
        typeof block.content === "string" &&
        block.content !== CLEARED_SENTINEL &&
        block.content.length > 100 // only clear substantial results
      ) {
        toolResults.push({ mi, bi, chars: block.content.length });
      }
    }
  }

  if (toolResults.length < MICROCOMPACT_MIN_RESULTS) return 0;

  // Clear all but the N most recent
  const toClear = toolResults.slice(0, -MICROCOMPACT_KEEP_RECENT);
  let cleared = 0;
  for (const { mi, bi } of toClear) {
    const block = (messages[mi]!.content as Array<Record<string, unknown>>)[bi]!;
    block.content = CLEARED_SENTINEL;
    cleared++;
  }

  if (cleared > 0) {
    log.info("session", `Microcompact: cleared ${cleared} old tool results (kept last ${MICROCOMPACT_KEEP_RECENT})`);
  }
  return cleared;
}

// ─── Context Pruning ─────────────────────────────────────────────

/**
 * Prune older messages when approaching the context window limit.
 * Keeps the system prompt, first user message, and recent messages.
 * Yields compaction events for the UI.
 */
export async function* pruneMessagesIfNeeded(
  state: ConversationState,
  systemPrompt: string,
  contextWindowSize: number,
  compactThreshold: number,
  config: KCodeConfig,
): AsyncGenerator<StreamEvent> {
  // Estimate current context window usage from actual message content
  const estimatedTokens = estimateContextTokens(systemPrompt, state.messages);
  const threshold = contextWindowSize * compactThreshold;
  if (estimatedTokens < threshold) {
    return;
  }

  const messages = state.messages;
  if (messages.length <= MIN_MESSAGES_FOR_PRUNING) {
    return;
  }

  log.info(
    "session",
    `Context pruning triggered: ~${estimatedTokens} tokens, threshold ${Math.floor(threshold)}`,
  );

  // Phase 1: Compress large tool results in older messages (keep recent messages intact)
  const compressibleEnd = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);
  let compressed = 0;
  for (let i = 0; i < compressibleEnd; i++) {
    const msg = messages[i]!;
    if (Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j]!;
        if (
          block.type === "tool_result" &&
          typeof block.content === "string" &&
          block.content.length > COMPRESS_THRESHOLD_CHARS
        ) {
          // Summarize tool results: keep first line + truncate
          const firstLine = block.content.split("\n")[0]!.slice(0, 200);
          const wasError = block.is_error ? " (error)" : "";
          msg.content[j] = {
            ...block,
            content: `[Compressed] ${firstLine}${wasError} (was ${block.content.length} chars)`,
          };
          compressed++;
        }
      }
    }
  }

  if (compressed > 0) {
    log.info("session", `Compressed ${compressed} tool results`);
    yield { type: "compaction_start", messageCount: compressed, tokensBefore: estimatedTokens };
    yield {
      type: "compaction_end",
      tokensAfter: estimateContextTokens(systemPrompt, state.messages),
      method: "compressed",
    };
  }

  // Re-check after compression
  let postCompressTokens = estimateContextTokens(systemPrompt, state.messages);
  if (postCompressTokens < threshold) {
    state.tokenCount = postCompressTokens;
    return;
  }

  // Phase 1.5: Aggressive tool_result clearing when above 85% — clear ALL old results
  // This is critical for long tool-heavy sessions (100+ tool calls) where microcompact
  // only keeps the last 3 but there are many tool_results > 100 chars remaining.
  const aggressiveThreshold = contextWindowSize * 0.85;
  if (postCompressTokens >= aggressiveThreshold) {
    let aggressiveCleared = 0;
    const protectLast = 2; // only keep 2 most recent messages intact
    const aggressiveEnd = Math.max(0, messages.length - protectLast);
    for (let i = 0; i < aggressiveEnd; i++) {
      const msg = messages[i]!;
      if (!Array.isArray(msg.content)) continue;
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j]!;
        if (
          block.type === "tool_result" &&
          typeof block.content === "string" &&
          block.content !== CLEARED_SENTINEL &&
          block.content.length > 50
        ) {
          msg.content[j] = { ...block, content: CLEARED_SENTINEL };
          aggressiveCleared++;
        }
      }
    }
    if (aggressiveCleared > 0) {
      log.info("session", `Aggressive tool_result clearing: ${aggressiveCleared} results cleared (context at ${Math.round(postCompressTokens / contextWindowSize * 100)}%)`);
      postCompressTokens = estimateContextTokens(systemPrompt, state.messages);
      yield { type: "compaction_start", messageCount: aggressiveCleared, tokensBefore: postCompressTokens };
      yield { type: "compaction_end", tokensAfter: postCompressTokens, method: "compressed" };
      if (postCompressTokens < threshold) {
        state.tokenCount = postCompressTokens;
        return;
      }
    }
  }

  // Phase 2: Auto-compact via LLM summary instead of blind pruning
  const keepFirst = KEEP_FIRST_MESSAGES;
  const keepLast = KEEP_RECENT_MESSAGES;

  if (messages.length <= keepFirst + keepLast) {
    return;
  }

  const pruneCount = Math.min(
    Math.floor((messages.length - keepFirst - keepLast) / 2) * 2,
    messages.length - keepFirst - keepLast,
  );

  if (pruneCount > 0) {
    // Notify UI that compaction is starting
    yield { type: "compaction_start", messageCount: pruneCount, tokensBefore: estimatedTokens };

    // Try LLM-based compaction first, fall back to simple pruning
    const toPrune = messages.slice(keepFirst, keepFirst + pruneCount);
    try {
      const { CompactionManager } = await import("./compaction.js");
      // Use tertiary/fallback model for compaction to avoid competing with the main model for GPU
      const compactModel = config.tertiaryModel ?? config.fallbackModel ?? config.model;
      if (compactModel === config.model) {
        log.warn(
          "session",
          "No tertiary/fallback model configured — compaction uses the primary model (may compete for GPU)",
        );
      }
      const compactor = new CompactionManager(config.apiKey, compactModel, config.apiBase, config.customFetch);
      const summary = await compactor.compact(toPrune);
      if (summary) {
        messages.splice(keepFirst, pruneCount, summary);
        state.tokenCount = estimateContextTokens(systemPrompt, state.messages);
        log.info(
          "session",
          `Auto-compacted ${pruneCount} messages into summary, ~${state.tokenCount} tokens remaining`,
        );
        yield { type: "compaction_end", tokensAfter: state.tokenCount, method: "llm" };
        return;
      }
    } catch (err) {
      log.error("session", `Auto-compaction failed, falling back to pruning: ${err}`);
    }

    // Fallback: simple pruning
    messages.splice(keepFirst, pruneCount);
    state.tokenCount = estimateContextTokens(systemPrompt, state.messages);
    log.info("session", `Pruned ${pruneCount} old messages, ~${state.tokenCount} tokens remaining`);
    yield { type: "compaction_end", tokensAfter: state.tokenCount, method: "pruned" };
  }
}

/**
 * Emergency prune: if still over 95% after compaction, drop oldest messages.
 * Returns compaction events if pruning occurred, or empty array.
 */
export function emergencyPrune(
  state: ConversationState,
  systemPrompt: string,
  contextWindowSize: number,
): StreamEvent[] {
  const postPruneTokens = estimateContextTokens(systemPrompt, state.messages);
  const hardLimit = contextWindowSize * EMERGENCY_THRESHOLD;
  if (postPruneTokens < hardLimit || state.messages.length <= EMERGENCY_MIN_MESSAGES) {
    return [];
  }

  const dropCount = Math.max(
    EMERGENCY_MIN_DROP,
    Math.floor(state.messages.length * EMERGENCY_DROP_RATIO),
  );
  log.warn(
    "session",
    `Emergency prune: ~${postPruneTokens} tokens >= 95% of ${contextWindowSize}. Dropping ${dropCount} oldest messages.`,
  );
  const kept = state.messages.slice(0, 1); // keep system/first message
  const rest = state.messages.slice(1);
  const remaining = rest.slice(dropCount);
  state.messages = [
    ...kept,
    {
      role: "user" as const,
      content: `[SYSTEM] Context was emergency-pruned to avoid exceeding the ${contextWindowSize}-token limit. ${dropCount} older messages were removed. Continue with the current task.`,
    },
    ...remaining,
  ];
  state.tokenCount = estimateContextTokens(systemPrompt, state.messages);

  return [
    { type: "compaction_start", messageCount: dropCount, tokensBefore: postPruneTokens },
    { type: "compaction_end", tokensAfter: state.tokenCount, method: "pruned" },
  ];
}

// ─── Multi-Strategy Compaction Circuit Breaker (shared) ────────

let _sharedCircuitBreaker: CompactionCircuitBreaker | null = null;

function getSharedCircuitBreaker(): CompactionCircuitBreaker {
  if (!_sharedCircuitBreaker) {
    _sharedCircuitBreaker = new CompactionCircuitBreaker();
  }
  return _sharedCircuitBreaker;
}

/** Reset the shared circuit breaker (e.g., on conversation reset). */
export function resetCompactionCircuitBreaker(): void {
  _sharedCircuitBreaker?.reset();
}

/**
 * Multi-strategy compaction: progressively applies image stripping, micro-compact,
 * full LLM-based compact, and emergency pruning based on context usage level.
 *
 * This is the preferred compaction entry point for new code. It replaces the
 * separate Phase 1/Phase 2 logic in pruneMessagesIfNeeded.
 */
export async function* compactMultiStrategy(
  state: ConversationState,
  systemPrompt: string,
  contextWindowSize: number,
  config: KCodeConfig,
  summarizer?: LlmSummarizer,
): AsyncGenerator<StreamEvent> {
  const estimatedTokens = estimateContextTokens(systemPrompt, state.messages);
  const contextUsage = estimatedTokens / contextWindowSize;

  if (contextUsage < 0.6) return;

  const tokensBefore = estimatedTokens;
  yield { type: "compaction_start", messageCount: state.messages.length, tokensBefore };

  // Build an LLM summarizer from config if none provided
  const llmSummarizer: LlmSummarizer | null = summarizer ?? (await buildLlmSummarizer(config));

  try {
    const result = await multiStrategyCompact(
      state.messages,
      contextUsage,
      llmSummarizer,
      undefined, // use default config
      getSharedCircuitBreaker(),
    );

    state.messages = result.messages;
    state.tokenCount = estimateContextTokens(systemPrompt, state.messages);

    const method = result.strategiesApplied.includes("full-compact")
      ? "llm"
      : result.strategiesApplied.includes("micro-compact")
        ? "compressed"
        : "pruned";

    log.info(
      "session",
      `Multi-strategy compaction: [${result.strategiesApplied.join(", ")}] ~${result.tokensRecovered} tokens recovered`,
    );

    yield { type: "compaction_end", tokensAfter: state.tokenCount, method };
  } catch (err) {
    log.error("session", `Multi-strategy compaction failed: ${err}`);
    // Fall through — the caller can still use emergencyPrune as a last resort
  }
}

/**
 * Build an LLM summarizer function from the current config,
 * using the CompactionManager from the legacy compaction module.
 */
async function buildLlmSummarizer(config: KCodeConfig): Promise<LlmSummarizer | null> {
  try {
    const { CompactionManager } = await import("./compaction.js");
    const compactModel = config.tertiaryModel ?? config.fallbackModel ?? config.model;
    const compactor = new CompactionManager(config.apiKey, compactModel, config.apiBase, config.customFetch);

    return async (
      prompt: string,
      systemPrompt: string,
      maxTokens: number,
    ): Promise<string | null> => {
      // Wrap the CompactionManager's compact call as a summarizer
      const fakeMessages: Message[] = [{ role: "user", content: prompt }];
      const result = await compactor.compact(fakeMessages);
      if (!result) return null;
      // Extract text from the result message
      if (Array.isArray(result.content)) {
        for (const block of result.content) {
          if (block.type === "text") return block.text;
        }
      }
      return typeof result.content === "string" ? result.content : null;
    };
  } catch {
    return null;
  }
}
