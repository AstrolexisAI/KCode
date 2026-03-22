// KCode - Transcript FTS Search
// SQLite FTS5 index over transcript entries for instant cross-session search

import { getDb } from "./db";
import { TranscriptManager } from "./transcript";
import { log } from "./logger";

export interface TranscriptSearchResult {
  sessionFile: string;
  role: string;
  content: string;
  timestamp: string;
  rank: number;
}

/**
 * Index a transcript session into the FTS table.
 * Skips sessions already indexed (idempotent).
 */
export function indexTranscriptSession(sessionFile: string): number {
  const db = getDb();
  const tm = new TranscriptManager();

  // Check if already indexed
  const existing = db.query<{ cnt: number }, [string]>(
    "SELECT COUNT(*) as cnt FROM transcript_entries WHERE session_file = ?"
  ).get(sessionFile);

  if (existing && existing.cnt > 0) return 0;

  const entries = tm.loadSession(sessionFile);
  if (entries.length === 0) return 0;

  const stmt = db.prepare(
    "INSERT INTO transcript_entries (session_file, role, entry_type, content, timestamp) VALUES (?, ?, ?, ?, ?)"
  );

  let count = 0;
  const runBatch = db.transaction(() => {
    for (const entry of entries) {
      // Skip very short entries and session markers
      if (entry.content.length < 3) continue;
      if (entry.content === "[session ended]") continue;

      stmt.run(sessionFile, entry.role, entry.type, entry.content, entry.timestamp);
      count++;
    }
  });
  runBatch();

  return count;
}

/**
 * Index all unindexed transcript sessions.
 * If reindex is true, clears all existing entries and re-indexes everything.
 */
export function indexAllTranscripts(reindex: boolean = false): { indexed: number; entries: number } {
  if (reindex) {
    const db = getDb();
    db.exec("DELETE FROM transcript_entries");
    // Rebuild the FTS index after clearing
    db.exec("INSERT INTO transcript_fts(transcript_fts) VALUES ('rebuild')");
  }

  const tm = new TranscriptManager();
  const sessions = tm.listSessions();
  let totalEntries = 0;
  let indexed = 0;

  for (const session of sessions) {
    const count = indexTranscriptSession(session.filename);
    if (count > 0) {
      indexed++;
      totalEntries += count;
    }
  }

  return { indexed, entries: totalEntries };
}

/**
 * Search transcripts using FTS5. Returns results ranked by relevance.
 */
export async function searchTranscripts(
  query: string,
  maxResults: number = 20,
): Promise<TranscriptSearchResult[]> {
  const { getTranscriptSearchHoursLimit } = await import("./pro.js");
  const hoursLimit = await getTranscriptSearchHoursLimit();

  if (!query.trim()) return [];

  const db = getDb();

  // Sanitize query for FTS5:
  // 1. Strip FTS5 operators and special syntax to prevent query injection
  // 2. Wrap each word in quotes so they're treated as literals
  const words = query
    .replace(/[*"():^{}~]/g, " ")  // Remove FTS5 special chars
    .split(/\s+/)
    .filter(w => w.length > 0)
    .filter(w => !/^(AND|OR|NOT|NEAR)$/i.test(w))  // Strip FTS operators
    .map(w => `"${w.replace(/"/g, '""')}"`)  // Quote each word
    .slice(0, 20);  // Limit terms to prevent DoS

  if (words.length === 0) return [];

  const ftsQuery = words.join(" ");

  try {
    const rows = db.query<
      { session_file: string; role: string; content: string; timestamp: string; rank: number },
      [string, number]
    >(
      `SELECT te.session_file, te.role, te.content, te.timestamp, rank
       FROM transcript_fts
       JOIN transcript_entries te ON transcript_fts.rowid = te.id
       WHERE transcript_fts MATCH ?${hoursLimit != null ? ` AND te.timestamp >= datetime('now', '-${hoursLimit} hours')` : ""}
       ORDER BY rank
       LIMIT ?`
    ).all(ftsQuery, maxResults);

    return rows.map(r => ({
      sessionFile: r.session_file,
      role: r.role,
      content: r.content,
      timestamp: r.timestamp,
      rank: r.rank,
    }));
  } catch (err) {
    log.debug("transcript-search", `FTS search failed: ${err}`);
    return [];
  }
}

/**
 * Get the total number of indexed entries.
 */
export function getIndexStats(): { sessions: number; entries: number } {
  const db = getDb();

  const stats = db.query<{ sessions: number; entries: number }, []>(
    `SELECT COUNT(DISTINCT session_file) as sessions, COUNT(*) as entries FROM transcript_entries`
  ).get();

  return {
    sessions: stats?.sessions ?? 0,
    entries: stats?.entries ?? 0,
  };
}
