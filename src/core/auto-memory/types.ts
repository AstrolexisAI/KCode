// KCode - Auto-Memory Types
// Interfaces for the automatic memory extraction system

import type { MemoryType } from "../memory";

/**
 * A single memory extracted by the auto-memory extractor.
 */
export interface ExtractedMemory {
  /** Type of memory: user | feedback | project | reference */
  type: MemoryType;
  /** Short title (max 80 chars) */
  title: string;
  /** One-line description for MEMORY.md index */
  description: string;
  /** Full content of the memory */
  content: string;
  /** Confidence 0-1 (only save if >= minConfidence) */
  confidence: number;
}

/**
 * Result returned by the extractor LLM call.
 */
export interface ExtractionResult {
  /** List of extracted memories (can be empty) */
  memories: ExtractedMemory[];
  /** Brief reasoning from the extractor */
  reasoning: string;
}

/**
 * Configuration for the auto-memory feature.
 */
export interface AutoMemoryConfig {
  /** Enable/disable auto-memory (default: true) */
  enabled: boolean;
  /** Specific model for extraction (default: null = use tertiaryModel) */
  model?: string | null;
  /** Minimum confidence threshold (default: 0.7) */
  minConfidence: number;
  /** Maximum memories per turn (default: 3) */
  maxPerTurn: number;
  /** Skip N turns between extractions to avoid saturation (default: 3) */
  cooldownTurns: number;
  /** Memory types to exclude (e.g., ["project"]) */
  excludeTypes: MemoryType[];
}

/** Default configuration for auto-memory */
export const DEFAULT_AUTO_MEMORY_CONFIG: AutoMemoryConfig = {
  enabled: true,
  model: null,
  minConfidence: 0.7,
  maxPerTurn: 3,
  cooldownTurns: 3,
  excludeTypes: [],
};

/**
 * Parse a raw settings object into AutoMemoryConfig, using defaults for missing/invalid fields.
 */
export function parseAutoMemoryConfig(raw: unknown): AutoMemoryConfig {
  if (raw === false) {
    return { ...DEFAULT_AUTO_MEMORY_CONFIG, enabled: false };
  }
  if (raw === true) {
    return { ...DEFAULT_AUTO_MEMORY_CONFIG, enabled: true };
  }
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_AUTO_MEMORY_CONFIG };
  }

  const obj = raw as Record<string, unknown>;
  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_AUTO_MEMORY_CONFIG.enabled,
    model: typeof obj.model === "string" ? obj.model : DEFAULT_AUTO_MEMORY_CONFIG.model,
    minConfidence:
      typeof obj.minConfidence === "number" && obj.minConfidence >= 0 && obj.minConfidence <= 1
        ? obj.minConfidence
        : DEFAULT_AUTO_MEMORY_CONFIG.minConfidence,
    maxPerTurn:
      typeof obj.maxPerTurn === "number" && obj.maxPerTurn >= 1 && obj.maxPerTurn <= 10
        ? Math.floor(obj.maxPerTurn)
        : DEFAULT_AUTO_MEMORY_CONFIG.maxPerTurn,
    cooldownTurns:
      typeof obj.cooldownTurns === "number" && obj.cooldownTurns >= 0 && obj.cooldownTurns <= 20
        ? Math.floor(obj.cooldownTurns)
        : DEFAULT_AUTO_MEMORY_CONFIG.cooldownTurns,
    excludeTypes: Array.isArray(obj.excludeTypes)
      ? (obj.excludeTypes.filter(
          (t) => typeof t === "string" && ["user", "feedback", "project", "reference"].includes(t),
        ) as MemoryType[])
      : DEFAULT_AUTO_MEMORY_CONFIG.excludeTypes,
  };
}
