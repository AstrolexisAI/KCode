import { Database } from "bun:sqlite";

export interface SessionSummary {
  sessionId: string;
  startedAt: number;
  lastActivity: number;
  turnCount: number;
  model?: string;
  project?: string;
  summary?: string;
}

export interface SessionDetail extends SessionSummary {
  turns: {
    turnIndex: number;
    role: string;
    content: string;
    timestamp: number;
  }[];
  tokensUsed?: number;
  costUsd?: number;
}

export class SessionBrowser {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.initTables();
  }

  private initTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        last_activity INTEGER NOT NULL,
        turn_count INTEGER DEFAULT 0,
        model TEXT,
        project TEXT,
        summary TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS session_turns (
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        PRIMARY KEY (session_id, turn_index),
        FOREIGN KEY (session_id) REFERENCES session_meta(session_id) ON DELETE CASCADE
      )
    `);
  }

  addSession(meta: {
    sessionId: string;
    startedAt: number;
    model?: string;
    project?: string;
  }): void {
    this.db.run(
      `INSERT OR REPLACE INTO session_meta (session_id, started_at, last_activity, turn_count, model, project, summary)
       VALUES (?, ?, ?, 0, ?, ?, NULL)`,
      [
        meta.sessionId,
        meta.startedAt,
        meta.startedAt,
        meta.model ?? null,
        meta.project ?? null,
      ],
    );
  }

  addTurn(
    sessionId: string,
    turnIndex: number,
    role: string,
    content: string,
    timestamp: number,
  ): void {
    this.db.run(
      `INSERT OR REPLACE INTO session_turns (session_id, turn_index, role, content, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
      [sessionId, turnIndex, role, content, timestamp],
    );

    const summary =
      role === "user" && turnIndex === 0
        ? content.slice(0, 80)
        : undefined;

    if (summary !== undefined) {
      this.db.run(
        `UPDATE session_meta SET last_activity = ?, turn_count = turn_count + 1, summary = ?
         WHERE session_id = ?`,
        [timestamp, summary, sessionId],
      );
    } else {
      this.db.run(
        `UPDATE session_meta SET last_activity = ?, turn_count = turn_count + 1
         WHERE session_id = ?`,
        [timestamp, sessionId],
      );
    }
  }

  listSessions(opts?: {
    limit?: number;
    offset?: number;
    sortBy?: "date" | "turns";
  }): SessionSummary[] {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const sortBy = opts?.sortBy ?? "date";

    const orderClause =
      sortBy === "turns"
        ? "ORDER BY turn_count DESC"
        : "ORDER BY last_activity DESC";

    const stmt = this.db.prepare(`
      SELECT session_id, started_at, last_activity, turn_count, model, project, summary
      FROM session_meta
      ${orderClause}
      LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(limit, offset) as Array<{
      session_id: string;
      started_at: number;
      last_activity: number;
      turn_count: number;
      model: string | null;
      project: string | null;
      summary: string | null;
    }>;

    return rows.map((row) => ({
      sessionId: row.session_id,
      startedAt: row.started_at,
      lastActivity: row.last_activity,
      turnCount: row.turn_count,
      model: row.model ?? undefined,
      project: row.project ?? undefined,
      summary: row.summary ?? undefined,
    }));
  }

  getSession(sessionId: string): SessionDetail | null {
    const metaStmt = this.db.prepare(`
      SELECT session_id, started_at, last_activity, turn_count, model, project, summary
      FROM session_meta
      WHERE session_id = ?
    `);

    const meta = metaStmt.get(sessionId) as {
      session_id: string;
      started_at: number;
      last_activity: number;
      turn_count: number;
      model: string | null;
      project: string | null;
      summary: string | null;
    } | null;

    if (!meta) return null;

    const turnsStmt = this.db.prepare(`
      SELECT turn_index, role, content, timestamp
      FROM session_turns
      WHERE session_id = ?
      ORDER BY turn_index
    `);

    const turns = turnsStmt.all(sessionId) as Array<{
      turn_index: number;
      role: string;
      content: string;
      timestamp: number;
    }>;

    return {
      sessionId: meta.session_id,
      startedAt: meta.started_at,
      lastActivity: meta.last_activity,
      turnCount: meta.turn_count,
      model: meta.model ?? undefined,
      project: meta.project ?? undefined,
      summary: meta.summary ?? undefined,
      turns: turns.map((t) => ({
        turnIndex: t.turn_index,
        role: t.role,
        content: t.content,
        timestamp: t.timestamp,
      })),
    };
  }

  deleteSession(sessionId: string): void {
    this.db.run(`DELETE FROM session_turns WHERE session_id = ?`, [sessionId]);
    this.db.run(`DELETE FROM session_meta WHERE session_id = ?`, [sessionId]);
  }

  getStats(): {
    totalSessions: number;
    totalTurns: number;
    oldestSession: string;
    newestSession: string;
  } {
    const countStmt = this.db.prepare(`
      SELECT
        COUNT(*) AS total_sessions,
        COALESCE(SUM(turn_count), 0) AS total_turns
      FROM session_meta
    `);
    const counts = countStmt.get() as {
      total_sessions: number;
      total_turns: number;
    };

    let oldestSession = "";
    let newestSession = "";

    if (counts.total_sessions > 0) {
      const oldestStmt = this.db.prepare(`
        SELECT session_id FROM session_meta ORDER BY started_at ASC LIMIT 1
      `);
      const oldest = oldestStmt.get() as { session_id: string };
      oldestSession = oldest.session_id;

      const newestStmt = this.db.prepare(`
        SELECT session_id FROM session_meta ORDER BY started_at DESC LIMIT 1
      `);
      const newest = newestStmt.get() as { session_id: string };
      newestSession = newest.session_id;
    }

    return {
      totalSessions: counts.total_sessions,
      totalTurns: counts.total_turns,
      oldestSession,
      newestSession,
    };
  }
}
