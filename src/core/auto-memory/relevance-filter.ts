// KCode - Auto-Memory Relevance Filter
// Filters extracted memories against existing ones to prevent duplicates.
// Uses fuzzy title matching and content comparison.

import type { MemoryType } from "../memory";
import type { AutoMemoryConfig, ExtractedMemory } from "./types";

// ─── Fuzzy String Similarity ────────────────────────────────────

/**
 * Compute normalized Levenshtein similarity between two strings (0-1).
 * 1.0 = identical, 0.0 = completely different.
 */
export function stringSimilarity(a: string, b: string): number {
  const la = a.toLowerCase().trim();
  const lb = b.toLowerCase().trim();

  if (la === lb) return 1.0;
  if (la.length === 0 || lb.length === 0) return 0.0;

  const maxLen = Math.max(la.length, lb.length);
  const distance = levenshteinDistance(la, lb);
  return 1 - distance / maxLen;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Use single-row optimization for memory efficiency
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

// ─── Title Extraction from MEMORY.md ────────────────────────────

/**
 * Extract memory titles from a MEMORY.md index string.
 * Parses lines like: "- [Title](filename.md) -- description"
 * or: "- [Title](filename.md) — description"
 */
export function extractTitlesFromIndex(indexContent: string | null): string[] {
  if (!indexContent) return [];

  const titles: string[] = [];
  const linkPattern = /^\s*-\s*\[([^\]]+)\]\([^)]+\)/;

  for (const line of indexContent.split("\n")) {
    const match = line.match(linkPattern);
    if (match?.[1]) {
      titles.push(match[1].trim());
    }
  }

  return titles;
}

// ─── Duplicate Detection ────────────────────────────────────────

const DUPLICATE_THRESHOLD = 0.85;

export interface FilterResult {
  /** Memories that passed the filter (new or updated) */
  accepted: ExtractedMemory[];
  /** Memories that were filtered out as duplicates */
  rejected: Array<{ memory: ExtractedMemory; reason: string; matchedTitle?: string }>;
}

/**
 * Filter extracted memories against existing titles and config constraints.
 *
 * Removes:
 * 1. Memories below minConfidence
 * 2. Memories with excluded types
 * 3. Duplicate titles (fuzzy match >= DUPLICATE_THRESHOLD)
 * 4. Excess memories beyond maxPerTurn
 */
export function filterMemories(
  memories: ExtractedMemory[],
  existingTitles: string[],
  config: AutoMemoryConfig,
): FilterResult {
  const accepted: ExtractedMemory[] = [];
  const rejected: FilterResult["rejected"] = [];

  for (const memory of memories) {
    // Check confidence threshold
    if (memory.confidence < config.minConfidence) {
      rejected.push({
        memory,
        reason: `confidence ${memory.confidence} < ${config.minConfidence}`,
      });
      continue;
    }

    // Check excluded types
    if (config.excludeTypes.includes(memory.type)) {
      rejected.push({ memory, reason: `type "${memory.type}" excluded` });
      continue;
    }

    // Check for duplicates via fuzzy title matching
    const duplicate = findDuplicateTitle(memory.title, existingTitles);
    if (duplicate) {
      rejected.push({
        memory,
        reason: `duplicate of "${duplicate.title}" (similarity: ${duplicate.similarity.toFixed(2)})`,
        matchedTitle: duplicate.title,
      });
      continue;
    }

    // Passed all filters
    accepted.push(memory);
  }

  // Enforce maxPerTurn — keep highest confidence first
  if (accepted.length > config.maxPerTurn) {
    const sorted = [...accepted].sort((a, b) => b.confidence - a.confidence);
    const kept = sorted.slice(0, config.maxPerTurn);
    const dropped = sorted.slice(config.maxPerTurn);
    for (const m of dropped) {
      rejected.push({ memory: m, reason: `exceeded maxPerTurn (${config.maxPerTurn})` });
    }
    return { accepted: kept, rejected };
  }

  return { accepted, rejected };
}

/**
 * Find a duplicate title in existing titles using fuzzy matching.
 */
function findDuplicateTitle(
  title: string,
  existingTitles: string[],
): { title: string; similarity: number } | null {
  for (const existing of existingTitles) {
    const similarity = stringSimilarity(title, existing);
    if (similarity >= DUPLICATE_THRESHOLD) {
      return { title: existing, similarity };
    }
  }
  return null;
}
