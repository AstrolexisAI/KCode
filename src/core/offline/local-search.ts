// KCode - Local Search
// Offline replacement for WebSearch. Searches across multiple local sources:
// 1. Cached search results from previous web searches
// 2. Cached documentation files
// 3. Learnings stored in the SQLite database (FTS5)
// 4. Codebase index (symbols and definitions)
// 5. System man pages

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger";
import { kcodePath } from "../paths";
import type { LocalSearchResult, LocalSearchSource } from "./types";

// ─── Cache Paths ───────────────────────────────────────────────

function searchCacheDir(): string {
  return kcodePath("cache", "search");
}

function docsCacheDir(): string {
  return kcodePath("cache", "docs");
}

// ─── Main Search Function ──────────────────────────────────────

/**
 * Search local sources for information. Used as offline fallback for WebSearch.
 * Results are ranked by relevance and deduplicated.
 */
export async function localSearch(
  query: string,
  limit: number = 10,
  sources?: LocalSearchSource[],
): Promise<LocalSearchResult[]> {
  const enabledSources = sources ?? ["cache", "docs", "learnings", "codebase", "manpages"];
  const results: LocalSearchResult[] = [];

  const tasks: Array<Promise<LocalSearchResult[]>> = [];

  if (enabledSources.includes("cache")) {
    tasks.push(searchCachedResults(query));
  }
  if (enabledSources.includes("docs")) {
    tasks.push(searchCachedDocs(query));
  }
  if (enabledSources.includes("learnings")) {
    tasks.push(searchLearnings(query));
  }
  if (enabledSources.includes("codebase")) {
    tasks.push(searchCodebaseIndex(query));
  }
  if (enabledSources.includes("manpages")) {
    tasks.push(searchManPages(query));
  }

  const taskResults = await Promise.allSettled(tasks);
  for (const tr of taskResults) {
    if (tr.status === "fulfilled") {
      results.push(...tr.value);
    } else {
      log.debug("local-search", `Source failed: ${tr.reason}`);
    }
  }

  // Sort by relevance descending, deduplicate by title, take top N
  const seen = new Set<string>();
  return results
    .sort((a, b) => b.relevance - a.relevance)
    .filter((r) => {
      const key = r.title.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

// ─── Source: Cached Search Results ─────────────────────────────

async function searchCachedResults(query: string): Promise<LocalSearchResult[]> {
  const dir = searchCacheDir();
  if (!existsSync(dir)) return [];

  const results: LocalSearchResult[] = [];
  const q = query.toLowerCase();

  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const file of files.slice(0, 100)) {
      try {
        const raw = readFileSync(join(dir, file), "utf-8");
        const data = JSON.parse(raw) as {
          query?: string;
          results?: Array<{ title: string; url: string; snippet: string }>;
          timestamp?: number;
        };

        // Skip entries older than 7 days
        if (data.timestamp && Date.now() - data.timestamp > 7 * 24 * 60 * 60 * 1000) continue;

        if (!data.results) continue;

        for (const r of data.results) {
          const titleMatch = r.title.toLowerCase().includes(q) ? 0.3 : 0;
          const snippetMatch = r.snippet.toLowerCase().includes(q) ? 0.2 : 0;
          const queryMatch = data.query?.toLowerCase().includes(q) ? 0.2 : 0;
          const relevance = titleMatch + snippetMatch + queryMatch;

          if (relevance > 0) {
            results.push({
              source: "cache",
              title: r.title,
              content: `${r.snippet}\nURL: ${r.url}`,
              relevance: Math.min(relevance, 1),
            });
          }
        }
      } catch {
        /* skip malformed files */
      }
    }
  } catch {
    /* dir read error */
  }

  return results;
}

// ─── Source: Cached Documentation ──────────────────────────────

async function searchCachedDocs(query: string): Promise<LocalSearchResult[]> {
  const dir = docsCacheDir();
  if (!existsSync(dir)) return [];

  const results: LocalSearchResult[] = [];
  const q = query.toLowerCase();

  try {
    const walk = (d: string) => {
      const entries = readdirSync(d, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".md") || entry.name.endsWith(".txt")) {
          try {
            const content = readFileSync(full, "utf-8");
            const lower = content.toLowerCase();
            if (lower.includes(q)) {
              // Find the paragraph containing the match
              const idx = lower.indexOf(q);
              const start = Math.max(0, idx - 200);
              const end = Math.min(content.length, idx + 300);
              const snippet = content.slice(start, end).trim();

              results.push({
                source: "docs",
                title: entry.name.replace(/\.(md|txt)$/, ""),
                content: snippet,
                relevance: 0.5,
              });
            }
          } catch {
            /* skip unreadable */
          }
        }
      }
    };
    walk(dir);
  } catch {
    /* dir read error */
  }

  return results.slice(0, 10);
}

// ─── Source: Learnings (FTS5 in SQLite) ────────────────────────

async function searchLearnings(query: string): Promise<LocalSearchResult[]> {
  try {
    const { getDb } = await import("../db");
    const db = getDb();

    // Check if learnings table exists
    const tableCheck = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='learnings'")
      .get();
    if (!tableCheck) return [];

    // Use FTS5 if available, otherwise LIKE
    const ftsCheck = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='learnings_fts'")
      .get();

    let rows: Array<{ content: string; topic?: string }>;
    if (ftsCheck) {
      rows = db
        .query("SELECT content, topic FROM learnings_fts WHERE learnings_fts MATCH ? LIMIT 10")
        .all(query) as any;
    } else {
      rows = db
        .query("SELECT content, topic FROM learnings WHERE content LIKE ? LIMIT 10")
        .all(`%${query}%`) as any;
    }

    return rows.map((r) => ({
      source: "learnings" as const,
      title: r.topic ?? "Learning",
      content: r.content,
      relevance: 0.6,
    }));
  } catch (err) {
    log.debug("local-search", `Learnings search failed: ${err}`);
    return [];
  }
}

// ─── Source: Codebase Index ────────────────────────────────────

async function searchCodebaseIndex(query: string): Promise<LocalSearchResult[]> {
  try {
    const { getDb } = await import("../db");
    const db = getDb();

    // Check if codebase index tables exist
    const tableCheck = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='codebase_symbols'")
      .get();
    if (!tableCheck) return [];

    const rows = db
      .query("SELECT name, file_path, kind FROM codebase_symbols WHERE name LIKE ? LIMIT 10")
      .all(`%${query}%`) as Array<{ name: string; file_path: string; kind: string }>;

    return rows.map((r) => ({
      source: "codebase" as const,
      title: `${r.kind}: ${r.name}`,
      content: `Defined in ${r.file_path}`,
      relevance: 0.4,
    }));
  } catch (err) {
    log.debug("local-search", `Codebase index search failed: ${err}`);
    return [];
  }
}

// ─── Source: Man Pages ─────────────────────────────────────────

export async function searchManPages(query: string): Promise<LocalSearchResult[]> {
  try {
    const result = Bun.spawnSync(["apropos", query], {
      timeout: 5000,
      stderr: "pipe",
    });
    if (result.exitCode !== 0) return [];

    const output = result.stdout.toString().trim();
    if (!output || output.includes("nothing appropriate")) return [];

    const lines = output.split("\n").slice(0, 5);
    return lines.map((line) => {
      const parts = line.split(" - ");
      return {
        source: "manpages" as const,
        title: parts[0]?.trim() ?? line,
        content: line,
        relevance: 0.3,
      };
    });
  } catch {
    return [];
  }
}
