// KCode - Tool Output Cache
// Session-scoped cache for Read/Glob results to avoid redundant I/O

import { statSync } from "node:fs";

interface CacheEntry {
  result: string;
  mtime: number;
  cachedAt: number;
  accessedAt: number;
}

const MAX_ENTRIES = 200;
const TTL_MS = 60_000; // 60 seconds

export class ToolCache {
  private cache = new Map<string, CacheEntry>();
  private _hits = 0;
  private _misses = 0;

  /**
   * Build a cache key from tool name and file path.
   */
  makeKey(toolName: string, filePath: string, extra?: string): string {
    return `${toolName}:${filePath}${extra ? `:${extra}` : ""}`;
  }

  /**
   * Get a cached result if still valid (same mtime, not expired).
   */
  get(key: string, filePath: string): string | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this._misses++;
      return null;
    }

    // Check TTL
    if (Date.now() - entry.cachedAt > TTL_MS) {
      this.cache.delete(key);
      this._misses++;
      return null;
    }

    // Check mtime hasn't changed
    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs !== entry.mtime) {
        this.cache.delete(key);
        this._misses++;
        return null;
      }
    } catch {
      this.cache.delete(key);
      this._misses++;
      return null;
    }

    entry.accessedAt = Date.now();
    this._hits++;
    return entry.result;
  }

  /**
   * Store a result in the cache.
   */
  set(key: string, filePath: string, result: string): void {
    // Evict LRU if at capacity
    if (this.cache.size >= MAX_ENTRIES) {
      let oldestKey = "";
      let oldestAccess = Infinity;
      for (const [k, v] of this.cache) {
        if (v.accessedAt < oldestAccess) {
          oldestAccess = v.accessedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }

    let mtime = 0;
    try {
      mtime = statSync(filePath).mtimeMs;
    } catch {
      /* file may not exist for Glob results */
    }

    const now = Date.now();
    this.cache.set(key, {
      result,
      mtime,
      cachedAt: now,
      accessedAt: now,
    });
  }

  /**
   * Invalidate all cache entries for a given file path.
   * Called after Write/Edit modifies a file.
   */
  invalidate(filePath: string): void {
    // Keys are structured as "ToolName:filePath:extra", so match the path segment exactly
    // by checking that the character after filePath is either ':' or end-of-string
    for (const [key] of this.cache) {
      const pathStart = key.indexOf(":") + 1;
      const pathEnd = key.indexOf(":", pathStart);
      const keyPath = pathEnd === -1 ? key.slice(pathStart) : key.slice(pathStart, pathEnd);
      if (keyPath === filePath) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
    this._hits = 0;
    this._misses = 0;
  }

  get hits(): number {
    return this._hits;
  }
  get misses(): number {
    return this._misses;
  }
  get size(): number {
    return this.cache.size;
  }

  /**
   * Format cache stats for display.
   */
  formatStats(): string {
    const total = this._hits + this._misses;
    const hitRate = total > 0 ? Math.round((this._hits / total) * 100) : 0;
    return `Cache: ${this.size} entries, ${this._hits} hits / ${this._misses} misses (${hitRate}% hit rate)`;
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let _cache: ToolCache | null = null;

export function getToolCache(): ToolCache {
  if (!_cache) {
    _cache = new ToolCache();
  }
  return _cache;
}
