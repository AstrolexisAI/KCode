// KCode - Response Cache
// Caches LLM responses by prompt hash to reduce latency and inference cost.
// Uses SQLite for persistence across sessions.

import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { log } from "./logger";

const CACHE_DB_PATH = join(homedir(), ".kcode", "cache.db");
const MAX_CACHE_SIZE = 500; // Max cached entries
const MAX_ENTRY_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let db: ReturnType<typeof import("bun:sqlite").Database.prototype.constructor> | null = null;

function getDb() {
  if (db) return db;
  try {
    const { Database } = require("bun:sqlite");
    db = new Database(CACHE_DB_PATH);
    db.run("PRAGMA journal_mode=WAL");
    db.run(`CREATE TABLE IF NOT EXISTS response_cache (
      hash TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      prompt_preview TEXT,
      response TEXT NOT NULL,
      tokens_used INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      hits INTEGER DEFAULT 0
    )`);
    return db;
  } catch {
    return null;
  }
}

/**
 * Generate a cache key from model + messages.
 * Uses SHA-256 of the model name + last user message + system prompt hash.
 */
export function generateCacheKey(model: string, messages: Array<{ role: string; content: string }>): string {
  const hash = createHash("sha256");
  hash.update(model);

  // Include the last 3 messages for context-sensitivity
  const relevant = messages.slice(-3);
  for (const msg of relevant) {
    hash.update(msg.role);
    hash.update(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
  }

  return hash.digest("hex").slice(0, 32);
}

/**
 * Look up a cached response.
 */
export function getCachedResponse(key: string): string | null {
  const database = getDb();
  if (!database) return null;

  try {
    const row = database.prepare(
      "SELECT response, created_at FROM response_cache WHERE hash = ?"
    ).get(key) as { response: string; created_at: number } | null;

    if (!row) return null;

    // Check age
    if (Date.now() - row.created_at > MAX_ENTRY_AGE_MS) {
      database.prepare("DELETE FROM response_cache WHERE hash = ?").run(key);
      return null;
    }

    // Increment hit count
    database.prepare("UPDATE response_cache SET hits = hits + 1 WHERE hash = ?").run(key);
    log.debug("cache", `Cache hit for ${key.slice(0, 8)}`);
    return row.response;
  } catch {
    return null;
  }
}

/**
 * Store a response in the cache.
 */
export function setCachedResponse(
  key: string,
  model: string,
  promptPreview: string,
  response: string,
  tokensUsed: number,
): void {
  const database = getDb();
  if (!database) return;

  try {
    // Don't cache very short or very long responses
    if (response.length < 10 || response.length > 100_000) return;

    database.prepare(`
      INSERT OR REPLACE INTO response_cache (hash, model, prompt_preview, response, tokens_used, created_at, hits)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(key, model, promptPreview.slice(0, 200), response, tokensUsed, Date.now());

    // Evict old entries if over limit
    const count = (database.prepare("SELECT COUNT(*) as n FROM response_cache").get() as { n: number }).n;
    if (count > MAX_CACHE_SIZE) {
      database.prepare(`
        DELETE FROM response_cache WHERE hash IN (
          SELECT hash FROM response_cache ORDER BY created_at ASC LIMIT ?
        )
      `).run(count - MAX_CACHE_SIZE);
    }

    log.debug("cache", `Cached response for ${key.slice(0, 8)} (${response.length} chars)`);
  } catch {
    // Best effort
  }
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): { entries: number; totalHits: number; oldestDays: number } {
  const database = getDb();
  if (!database) return { entries: 0, totalHits: 0, oldestDays: 0 };

  try {
    const stats = database.prepare(`
      SELECT COUNT(*) as entries, COALESCE(SUM(hits), 0) as totalHits, MIN(created_at) as oldest
      FROM response_cache
    `).get() as { entries: number; totalHits: number; oldest: number | null };

    const oldestDays = stats.oldest
      ? Math.round((Date.now() - stats.oldest) / (24 * 60 * 60 * 1000))
      : 0;

    return { entries: stats.entries, totalHits: stats.totalHits, oldestDays };
  } catch {
    return { entries: 0, totalHits: 0, oldestDays: 0 };
  }
}

/**
 * Clear the entire cache.
 */
export function clearCache(): number {
  const database = getDb();
  if (!database) return 0;

  try {
    const count = (database.prepare("SELECT COUNT(*) as n FROM response_cache").get() as { n: number }).n;
    database.prepare("DELETE FROM response_cache").run();
    return count;
  } catch {
    return 0;
  }
}
