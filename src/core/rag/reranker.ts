// KCode - RAG Result Re-Ranker
// Re-ranks vector search results using contextual signals beyond embedding similarity:
// recency, session frequency, path proximity, and chunk type.

import { statSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { RerankerConfig, RerankerContext, SearchResult } from "./types";

// ─── Default Config ────────────────────────────────────────────

export const DEFAULT_RERANKER_CONFIG: RerankerConfig = {
  weights: {
    semantic: 0.5,
    recency: 0.15,
    frequency: 0.15,
    proximity: 0.1,
    typeBoost: 0.1,
  },
};

// ─── Helpers ───────────────────────────────────────────────────

/** Get file age in ms since last modification. Returns Infinity if file doesn't exist. */
export function getFileAge(filePath: string): number {
  try {
    const stat = statSync(filePath);
    return Date.now() - stat.mtimeMs;
  } catch {
    return Infinity;
  }
}

/**
 * Compute path proximity score between two file paths.
 * Same directory = 1.0, parent/child = 0.7, nearby = 0.3, far = 0.0
 */
export function pathProximity(fileA: string, fileB: string): number {
  const dirA = dirname(fileA);
  const dirB = dirname(fileB);

  if (dirA === dirB) return 1.0;

  // Check if one is a parent of the other
  const rel = relative(dirA, dirB);
  if (!rel.startsWith("..")) {
    const depth = rel.split("/").filter(Boolean).length;
    if (depth <= 1) return 0.7;
    if (depth <= 3) return 0.3;
  }

  // Check the reverse
  const relReverse = relative(dirB, dirA);
  if (!relReverse.startsWith("..")) {
    const depth = relReverse.split("/").filter(Boolean).length;
    if (depth <= 1) return 0.7;
    if (depth <= 3) return 0.3;
  }

  return 0.0;
}

// ─── Re-Ranker ─────────────────────────────────────────────────

/**
 * Re-rank search results using multiple contextual signals.
 * Returns a new sorted array (does not mutate input).
 */
export function rerank(
  results: SearchResult[],
  context: RerankerContext,
  config: RerankerConfig = DEFAULT_RERANKER_CONFIG,
): SearchResult[] {
  const w = config.weights;

  return results
    .map((r) => {
      let score = r.similarity * w.semantic;

      // Recency: boost recently modified files (exponential decay over 7 days)
      const fileAge = getFileAge(r.filePath);
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
      const recencyScore = fileAge === Infinity ? 0 : Math.exp(-fileAge / SEVEN_DAYS_MS);
      score += recencyScore * w.recency;

      // Frequency: boost files accessed in this session
      const freq = context.sessionFiles.filter((f) => f === r.filePath).length;
      const freqScore = Math.min(freq / 5, 1.0);
      score += freqScore * w.frequency;

      // Proximity: boost files near the current file
      if (context.currentFile) {
        const proximity = pathProximity(context.currentFile, r.filePath);
        score += proximity * w.proximity;
      }

      // Type boost: functions > methods > classes > modules > blocks > comments for code queries
      if (context.queryType === "code") {
        const typeScores: Record<string, number> = {
          function: 1.0,
          method: 0.9,
          class: 0.7,
          module: 0.5,
          block: 0.3,
          comment: 0.1,
        };
        score += (typeScores[r.type] ?? 0.3) * w.typeBoost;
      }

      return { ...r, similarity: score };
    })
    .sort((a, b) => b.similarity - a.similarity);
}
