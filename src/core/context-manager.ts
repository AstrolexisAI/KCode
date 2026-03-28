// KCode - Context Manager
// Extracted from conversation.ts — context window management, pruning, and compaction

import type { Message, StreamEvent, ConversationState, KCodeConfig } from "./types";
import { log } from "./logger";

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
          chars += typeof block.content === "string" ? block.content.length : 100;
        } else if (block.type === "tool_use") {
          chars += JSON.stringify(block.input).length;
        }
      }
    }
  }
  return Math.ceil(chars / 4); // ~4 chars per token
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
  if (messages.length <= 4) {
    return;
  }

  log.info("session", `Context pruning triggered: ~${estimatedTokens} tokens, threshold ${Math.floor(threshold)}`);

  // Phase 1: Compress large tool results in older messages (keep last 10 messages intact)
  const compressibleEnd = Math.max(0, messages.length - 10);
  let compressed = 0;
  for (let i = 0; i < compressibleEnd; i++) {
    const msg = messages[i];
    if (Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > 500) {
          // Summarize tool results: keep first line + truncate
          const firstLine = block.content.split("\n")[0].slice(0, 200);
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
    yield { type: "compaction_end", tokensAfter: estimateContextTokens(systemPrompt, state.messages), method: "compressed" };
  }

  // Re-check after compression
  const postCompressTokens = estimateContextTokens(systemPrompt, state.messages);
  if (postCompressTokens < threshold) {
    state.tokenCount = postCompressTokens;
    return;
  }

  // Phase 2: Auto-compact via LLM summary instead of blind pruning
  const keepFirst = 1;
  const keepLast = 10; // Keep enough recent messages to preserve tool call/result pairs

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
        log.warn("session", "No tertiary/fallback model configured — compaction uses the primary model (may compete for GPU)");
      }
      const compactor = new CompactionManager(config.apiKey, compactModel, config.apiBase);
      const summary = await compactor.compact(toPrune);
      if (summary) {
        messages.splice(keepFirst, pruneCount, summary);
        state.tokenCount = estimateContextTokens(systemPrompt, state.messages);
        log.info("session", `Auto-compacted ${pruneCount} messages into summary, ~${state.tokenCount} tokens remaining`);
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
  const hardLimit = contextWindowSize * 0.95;
  if (postPruneTokens < hardLimit || state.messages.length <= 6) {
    return [];
  }

  const dropCount = Math.max(2, Math.floor(state.messages.length * 0.3));
  log.warn("session", `Emergency prune: ~${postPruneTokens} tokens >= 95% of ${contextWindowSize}. Dropping ${dropCount} oldest messages.`);
  const kept = state.messages.slice(0, 1); // keep system/first message
  const rest = state.messages.slice(1);
  const remaining = rest.slice(dropCount);
  state.messages = [...kept, { role: "user" as const, content: `[SYSTEM] Context was emergency-pruned to avoid exceeding the ${contextWindowSize}-token limit. ${dropCount} older messages were removed. Continue with the current task.` }, ...remaining];
  state.tokenCount = estimateContextTokens(systemPrompt, state.messages);

  return [
    { type: "compaction_start", messageCount: dropCount, tokensBefore: postPruneTokens },
    { type: "compaction_end", tokensAfter: state.tokenCount, method: "pruned" },
  ];
}
