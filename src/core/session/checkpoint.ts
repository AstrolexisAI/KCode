// Checkpoint Manager — Periodic session snapshots to SQLite.
// Enables crash recovery and session resume from any point.

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { SessionCheckpoint } from "./types";

export class CheckpointManager {
  private db: Database;
  private intervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private maxPerSession: number;

  constructor(db: Database, intervalMs = 30_000, maxPerSession = 10) {
    this.db = db;
    this.intervalMs = intervalMs;
    this.maxPerSession = maxPerSession;
    this.initTable();
  }

  private initTable(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS session_checkpoints (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      data TEXT NOT NULL
    )`);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_checkpoints_conv_ts
       ON session_checkpoints (conversation_id, timestamp DESC)`,
    );
  }

  /** Start automatic periodic checkpointing */
  startAutoCheckpoint(getState: () => SessionCheckpoint): void {
    this.stopAutoCheckpoint();
    this.timer = setInterval(() => {
      try {
        const state = getState();
        this.save(state);
      } catch {
        // Silently ignore — checkpoint failure should not crash the app
      }
    }, this.intervalMs);
    // Allow process to exit even if timer is running
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  /** Stop automatic checkpointing */
  stopAutoCheckpoint(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Save a checkpoint */
  save(checkpoint: SessionCheckpoint): void {
    const id = checkpoint.id || randomUUID();
    this.db.run(
      `INSERT OR REPLACE INTO session_checkpoints (id, conversation_id, timestamp, data)
       VALUES (?, ?, ?, ?)`,
      [id, checkpoint.conversationId, checkpoint.timestamp, JSON.stringify(checkpoint)],
    );
    this.pruneOld(checkpoint.conversationId);
  }

  /** Get the most recent checkpoint for a conversation */
  getLatest(conversationId: string): SessionCheckpoint | null {
    const row = this.db
      .query(
        `SELECT data FROM session_checkpoints
         WHERE conversation_id = ?
         ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(conversationId) as { data: string } | null;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as SessionCheckpoint;
    } catch {
      return null;
    }
  }

  /** Get checkpoint by ID */
  getById(id: string): SessionCheckpoint | null {
    const row = this.db
      .query(`SELECT data FROM session_checkpoints WHERE id = ?`)
      .get(id) as { data: string } | null;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as SessionCheckpoint;
    } catch {
      return null;
    }
  }

  /** List all checkpoints for a conversation */
  listForConversation(
    conversationId: string,
  ): Array<{ id: string; timestamp: number; tokensUsed: number }> {
    const rows = this.db
      .query(
        `SELECT id, timestamp, data FROM session_checkpoints
         WHERE conversation_id = ?
         ORDER BY timestamp DESC`,
      )
      .all(conversationId) as Array<{
      id: string;
      timestamp: number;
      data: string;
    }>;

    return rows.map((r) => {
      try {
        const parsed = JSON.parse(r.data) as SessionCheckpoint;
        return {
          id: r.id,
          timestamp: r.timestamp,
          tokensUsed: parsed.tokensUsed ?? 0,
        };
      } catch {
        return { id: r.id, timestamp: r.timestamp, tokensUsed: 0 };
      }
    });
  }

  /** List conversations that have recoverable checkpoints */
  listRecoverable(): Array<{
    conversationId: string;
    timestamp: number;
    tokensUsed: number;
    modelId: string;
  }> {
    const rows = this.db
      .query(
        `SELECT conversation_id, MAX(timestamp) as timestamp, data
         FROM session_checkpoints
         GROUP BY conversation_id
         ORDER BY timestamp DESC
         LIMIT 20`,
      )
      .all() as Array<{
      conversation_id: string;
      timestamp: number;
      data: string;
    }>;

    return rows.map((r) => {
      try {
        const parsed = JSON.parse(r.data) as SessionCheckpoint;
        return {
          conversationId: r.conversation_id,
          timestamp: r.timestamp,
          tokensUsed: parsed.tokensUsed ?? 0,
          modelId: parsed.modelId ?? "unknown",
        };
      } catch {
        return {
          conversationId: r.conversation_id,
          timestamp: r.timestamp,
          tokensUsed: 0,
          modelId: "unknown",
        };
      }
    });
  }

  /** Remove old checkpoints beyond maxPerSession */
  private pruneOld(conversationId: string): void {
    this.db.run(
      `DELETE FROM session_checkpoints
       WHERE conversation_id = ?
       AND id NOT IN (
         SELECT id FROM session_checkpoints
         WHERE conversation_id = ?
         ORDER BY timestamp DESC
         LIMIT ?
       )`,
      [conversationId, conversationId, this.maxPerSession],
    );
  }

  /** Remove all checkpoints for a conversation */
  clearConversation(conversationId: string): number {
    const result = this.db.run(
      `DELETE FROM session_checkpoints WHERE conversation_id = ?`,
      [conversationId],
    );
    return result.changes;
  }

  /** Remove all checkpoints older than N days */
  pruneOlderThan(days: number): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = this.db.run(
      `DELETE FROM session_checkpoints WHERE timestamp < ?`,
      [cutoff],
    );
    return result.changes;
  }
}
