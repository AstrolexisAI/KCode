// KCode - Multi-Strategy Compaction Orchestrator
// Coordinates 4 compaction strategies in progressive order based on context usage.

import { log } from "../logger.js";
import type { Message } from "../types.js";
import { CompactionCircuitBreaker } from "./circuit-breaker.js";
import { restoreRecentFiles } from "./strategies/file-restorer.js";
import { fullCompact } from "./strategies/full-compact.js";
import { hasImages, stripImages } from "./strategies/image-stripper.js";
import { microCompact } from "./strategies/micro-compact.js";
import type {
  CompactionConfig,
  CompactionResult,
  CompactionStrategy,
  LlmSummarizer,
} from "./types.js";
import { getDefaultCompactionConfig } from "./types.js";

// Re-export everything for convenience
export { CompactionCircuitBreaker } from "./circuit-breaker.js";
export { restoreRecentFiles } from "./strategies/file-restorer.js";
export { extractFilePaths, fullCompact } from "./strategies/full-compact.js";
export { hasImages, stripImages } from "./strategies/image-stripper.js";
export { microCompact } from "./strategies/micro-compact.js";
export {
  buildSessionResumptionMessage,
  sessionMemoryCompact,
} from "./strategies/session-memory-compact.js";
export type {
  CircuitBreakerConfig,
  CircuitBreakerState,
  CompactionConfig,
  CompactionResult,
  CompactionStrategy,
  FullCompactConfig,
  FullCompactResult,
  ImageStripConfig,
  ImageStripResult,
  LlmSummarizer,
  MicroCompactConfig,
  MicroCompactResult,
  SessionMemoryCompactConfig,
  SessionMemoryCompactResult,
} from "./types.js";
export { getDefaultCompactionConfig } from "./types.js";

// ─── Orchestrator ───────────────────────────────────────────────

/**
 * Run multi-strategy compaction on a message array.
 *
 * Strategies are applied progressively based on context usage:
 *   - Phase 0: Image stripping (always, if images present)
 *   - Phase 1: Micro-compact (>= 60%)
 *   - Phase 2: Full compact with LLM (>= 75%, if circuit breaker allows)
 *   - Phase 3: Emergency pruning (>= 90%)
 *
 * @param messages - Current conversation messages
 * @param contextUsage - Current context usage as fraction (0.0 - 1.0)
 * @param summarizer - LLM call function for full compact
 * @param config - Compaction configuration (uses defaults if not provided)
 * @param circuitBreaker - Circuit breaker instance (creates new one if not provided)
 */
export async function compact(
  messages: Message[],
  contextUsage: number,
  summarizer: LlmSummarizer | null,
  config?: Partial<CompactionConfig>,
  circuitBreaker?: CompactionCircuitBreaker,
): Promise<CompactionResult> {
  const cfg = {
    ...getDefaultCompactionConfig(),
    ...config,
  } as CompactionConfig;
  const cb = circuitBreaker ?? new CompactionCircuitBreaker(cfg.circuitBreaker);
  const strategiesApplied: CompactionStrategy[] = [];
  let totalTokensRecovered = 0;
  let current = messages;

  // Phase 0: Image stripping (always, if enabled and images present)
  if (cfg.imageStripping.enabled && hasImages(current)) {
    const result = stripImages(current, cfg.imageStripping);
    if (result.strippedCount > 0) {
      current = result.messages;
      totalTokensRecovered += result.tokensRecovered;
      strategiesApplied.push("image-strip");
      log.info(
        "compaction",
        `Image strip: removed ${result.strippedCount} images, ~${result.tokensRecovered} tokens recovered`,
      );
    }
  }

  // Phase 1: Micro-compact (>= 60%)
  if (contextUsage >= 0.6 && cfg.micro.enabled) {
    const result = microCompact(current, cfg.micro);
    if (result.compressedCount > 0) {
      current = result.messages;
      totalTokensRecovered += result.tokensRecovered;
      strategiesApplied.push("micro-compact");
      log.info(
        "compaction",
        `Micro-compact: compressed ${result.compressedCount} items, ~${result.tokensRecovered} tokens recovered`,
      );
    }
  }

  // Phase 2: Full compact with LLM (>= 75%)
  if (contextUsage >= 0.75 && summarizer && cb.canAttempt()) {
    try {
      const result = await fullCompact(
        current,
        1, // keepFirst
        Math.min(10, Math.floor(current.length / 2)), // keepLast
        summarizer,
        cfg.full,
      );

      current = result.messages;
      totalTokensRecovered += result.summaryTokens; // approximate
      strategiesApplied.push("full-compact");
      cb.recordSuccess();

      log.info(
        "compaction",
        `Full compact: summarized ${result.compactedMessages.length} messages`,
      );

      // Post-compact: restore recent files
      if (cfg.full.fileRestoreBudget > 0 && result.compactedMessages.length > 0) {
        current = await restoreRecentFiles(current, result.compactedMessages, cfg.full);
      }
    } catch (error) {
      cb.recordFailure(error instanceof Error ? error : new Error(String(error)));
      log.warn("compaction", `Full compact failed, falling back: ${error}`);
    }
  }

  // Phase 3: Emergency pruning (>= 90%)
  if (contextUsage >= 0.9) {
    const result = emergencyPruneMessages(current, {
      preserveRecent: 10,
      dropRatio: 0.3,
      keepFirstUserMessage: true,
    });
    if (result.dropped > 0) {
      current = result.messages;
      strategiesApplied.push("emergency-prune");
      log.warn("compaction", `Emergency prune: dropped ${result.dropped} messages`);
    }
  }

  if (strategiesApplied.length === 0) {
    strategiesApplied.push("none");
  }

  return {
    messages: current,
    strategiesApplied,
    tokensRecovered: totalTokensRecovered,
  };
}

// ─── Emergency Prune ────────────────────────────────────────────

interface EmergencyPruneConfig {
  preserveRecent: number;
  dropRatio: number;
  keepFirstUserMessage: boolean;
}

function emergencyPruneMessages(
  messages: Message[],
  config: EmergencyPruneConfig,
): { messages: Message[]; dropped: number } {
  const { preserveRecent, dropRatio, keepFirstUserMessage } = config;
  const keepFirst = keepFirstUserMessage ? 1 : 0;

  if (messages.length <= keepFirst + preserveRecent) {
    return { messages, dropped: 0 };
  }

  const middleStart = keepFirst;
  const middleEnd = messages.length - preserveRecent;
  const middleCount = middleEnd - middleStart;
  const dropCount = Math.max(2, Math.floor(middleCount * dropRatio));

  if (dropCount <= 0) return { messages, dropped: 0 };

  const result = [
    ...messages.slice(0, keepFirst),
    {
      role: "user" as const,
      content: `[SYSTEM] Context was compacted. ${dropCount} older messages were removed to free space.`,
    },
    ...messages.slice(middleStart + dropCount),
  ];

  return { messages: result, dropped: dropCount };
}
