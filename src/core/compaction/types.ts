// KCode - Multi-Strategy Compaction Types
// Shared interfaces for the compaction subsystem

import type { Message } from "../types.js";

// ─── Strategy Names ─────────────────────────────────────────────

export type CompactionStrategy =
  | "image-strip"
  | "micro-compact"
  | "full-compact"
  | "session-memory"
  | "emergency-prune"
  | "none";

// ─── Compaction Result ──────────────────────────────────────────

export interface CompactionResult {
  messages: Message[];
  strategiesApplied: CompactionStrategy[];
  tokensRecovered: number;
}

// ─── Image Stripper ─────────────────────────────────────────────

export interface ImageStripResult {
  messages: Message[];
  strippedCount: number;
  tokensRecovered: number;
}

export interface ImageStripConfig {
  enabled: boolean;
  /** Number of recent messages to preserve (don't strip images from these) */
  preserveRecent: number;
}

// ─── Micro-Compact ──────────────────────────────────────────────

export interface MicroCompactConfig {
  enabled: boolean;
  /** Messages to preserve intact at the end */
  preserveRecent: number;
  /** Threshold in chars for compressing a tool result */
  toolResultThreshold: number;
  /** Threshold in chars for compressing an assistant message */
  assistantThreshold: number;
  /** Tools whose results are compactable (heavy output). If empty/undefined, all tools are compactable. */
  compactableTools?: string[];
  /** Tools whose results should NEVER be compacted (needed for coherence). */
  preserveTools?: string[];
}

/** Default sets of compactable and preserved tools */
export const HEAVY_OUTPUT_TOOLS = new Set(["Read", "Bash", "Grep", "GrepReplace", "WebFetch", "LS", "GitLog", "DiffView"]);
export const COHERENCE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "Rename", "GitCommit"]);

export interface MicroCompactResult {
  messages: Message[];
  compressedCount: number;
  tokensRecovered: number;
}

// ─── Full Compact ───────────────────────────────────────────────

export interface FullCompactConfig {
  /** Model to use for summarization (default: tertiaryModel or fallback) */
  model: string | null;
  /** Max tokens for the summary */
  maxSummaryTokens: number;
  /** Group messages by API rounds */
  groupByRounds: boolean;
  /** Token budget for post-compact file restoration */
  fileRestoreBudget: number;
  /** Max number of files to restore after compaction */
  maxFilesToRestore: number;
  /** Max bytes per restored file */
  maxBytesPerFile: number;
}

export interface FullCompactResult {
  messages: Message[];
  compactedMessages: Message[];
  summaryTokens: number;
}

// ─── Session Memory Compact ─────────────────────────────────────

export interface SessionMemoryCompactConfig {
  enabled: boolean;
  /** Threshold: only compact if transcript exceeds this many messages */
  thresholdMessages: number;
}

export interface SessionMemoryCompactResult {
  summary: string;
  filesModified: string[];
  pendingTasks: string[];
  userPreferences: string[];
}

// ─── Circuit Breaker ────────────────────────────────────────────

export interface CircuitBreakerConfig {
  /** Max consecutive failures before opening the circuit */
  maxFailures: number;
  /** Auto-reset after this many milliseconds */
  resetAfterMs: number;
}

export interface CircuitBreakerState {
  consecutiveFailures: number;
  maxFailures: number;
  isOpen: boolean;
  lastFailure: Date | null;
  resetAfterMs: number;
}

// ─── Orchestrator Config ────────────────────────────────────────

export interface CompactionConfig {
  micro: MicroCompactConfig;
  full: FullCompactConfig;
  sessionMemory: SessionMemoryCompactConfig;
  circuitBreaker: CircuitBreakerConfig;
  imageStripping: ImageStripConfig;
}

// ─── LLM Summarizer Function Type ──────────────────────────────
// Injected to allow mocking in tests

export type LlmSummarizer = (
  prompt: string,
  systemPrompt: string,
  maxTokens: number,
) => Promise<string | null>;

// ─── Default Config ─────────────────────────────────────────────

export function getDefaultCompactionConfig(): CompactionConfig {
  return {
    micro: {
      enabled: true,
      preserveRecent: 10,
      toolResultThreshold: 300,
      assistantThreshold: 500,
    },
    full: {
      model: null,
      maxSummaryTokens: 2000,
      groupByRounds: true,
      fileRestoreBudget: 50000,
      maxFilesToRestore: 5,
      maxBytesPerFile: 5120,
    },
    sessionMemory: {
      enabled: true,
      thresholdMessages: 50,
    },
    circuitBreaker: {
      maxFailures: 3,
      resetAfterMs: 300_000,
    },
    imageStripping: {
      enabled: true,
      preserveRecent: 4,
    },
  };
}
