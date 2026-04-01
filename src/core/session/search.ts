import type { Database } from "bun:sqlite";

export interface SessionSearchResult {
  sessionId: string;
  timestamp: number;
  matchSnippet: string;
  turnIndex: number;
  role: string;
  score: number;
}

export class SessionSearch {
  private db: Database;
  private initialized = false;

  constructor(db: Database) {
    this.db = db;
    this.initFTS();
  }

  private initFTS(): void {
    if (this.initialized) return;
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_transcripts USING fts5(
        session_id,
        turn_index,
        role,
        content,
        timestamp UNINDEXED,
        tokenize='porter unicode61'
      )
    `);
    this.initialized = true;
  }

  indexTurn(sessionId: string, turnIndex: number, role: string, content: string): void {
    const timestamp = Date.now();
    this.db.run(
      `INSERT INTO session_transcripts (session_id, turn_index, role, content, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
      [sessionId, turnIndex.toString(), role, content, timestamp.toString()],
    );
  }

  search(query: string, limit: number = 20): SessionSearchResult[] {
    const stmt = this.db.prepare(`
      SELECT
        session_id,
        turn_index,
        role,
        timestamp,
        snippet(session_transcripts, 3, '<mark>', '</mark>', '...', 64) AS match_snippet,
        rank
      FROM session_transcripts
      WHERE session_transcripts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    const rows = stmt.all(query, limit) as Array<{
      session_id: string;
      turn_index: string;
      role: string;
      timestamp: string;
      match_snippet: string;
      rank: number;
    }>;

    return rows.map((row) => ({
      sessionId: row.session_id,
      turnIndex: parseInt(row.turn_index, 10),
      role: row.role,
      timestamp: parseInt(row.timestamp, 10),
      matchSnippet: row.match_snippet,
      score: -row.rank, // FTS5 rank is negative, lower is better
    }));
  }

  getSessionTurns(sessionId: string): { turnIndex: number; role: string; content: string }[] {
    const stmt = this.db.prepare(`
      SELECT turn_index, role, content
      FROM session_transcripts
      WHERE session_id = ?
      ORDER BY CAST(turn_index AS INTEGER)
    `);

    const rows = stmt.all(sessionId) as Array<{
      turn_index: string;
      role: string;
      content: string;
    }>;

    return rows.map((row) => ({
      turnIndex: parseInt(row.turn_index, 10),
      role: row.role,
      content: row.content,
    }));
  }

  deleteSession(sessionId: string): void {
    this.db.run(`DELETE FROM session_transcripts WHERE session_id = ?`, [sessionId]);
  }

  getSessionCount(): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(DISTINCT session_id) AS cnt
      FROM session_transcripts
    `);
    const row = stmt.get() as { cnt: number };
    return row.cnt;
  }
}
