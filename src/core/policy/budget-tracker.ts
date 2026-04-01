// Budget Tracker — Persistent daily usage tracking via SQLite.
// Records per-day cost/token summaries for budget enforcement and /stats.

import type { Database } from "bun:sqlite";
import type { DailyUsageRecord } from "./types";

export class BudgetTracker {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.initTable();
  }

  private initTable(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS daily_usage (
      date TEXT PRIMARY KEY,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      sessions INTEGER NOT NULL DEFAULT 0
    )`);
  }

  /** Record usage for today */
  recordUsage(tokens: number, costUsd: number): void {
    const today = new Date().toISOString().slice(0, 10);
    this.db.run(
      `INSERT INTO daily_usage (date, tokens_used, cost_usd, sessions)
       VALUES (?, ?, ?, 0)
       ON CONFLICT(date) DO UPDATE SET
         tokens_used = tokens_used + excluded.tokens_used,
         cost_usd = cost_usd + excluded.cost_usd`,
      [today, tokens, costUsd],
    );
  }

  /** Increment session count for today */
  recordSession(): void {
    const today = new Date().toISOString().slice(0, 10);
    this.db.run(
      `INSERT INTO daily_usage (date, tokens_used, cost_usd, sessions)
       VALUES (?, 0, 0, 1)
       ON CONFLICT(date) DO UPDATE SET
         sessions = sessions + 1`,
      [today],
    );
  }

  /** Get usage for a specific date */
  getUsage(date: string): DailyUsageRecord | null {
    const row = this.db
      .query(
        `SELECT date, tokens_used as tokensUsed, cost_usd as costUsd, sessions
         FROM daily_usage WHERE date = ?`,
      )
      .get(date) as DailyUsageRecord | null;
    return row;
  }

  /** Get today's usage */
  getTodayUsage(): DailyUsageRecord {
    const today = new Date().toISOString().slice(0, 10);
    return (
      this.getUsage(today) ?? {
        date: today,
        tokensUsed: 0,
        costUsd: 0,
        sessions: 0,
      }
    );
  }

  /** Get usage for the last N days */
  getRecentUsage(days: number): DailyUsageRecord[] {
    const rows = this.db
      .query(
        `SELECT date, tokens_used as tokensUsed, cost_usd as costUsd, sessions
         FROM daily_usage
         ORDER BY date DESC LIMIT ?`,
      )
      .all(days) as DailyUsageRecord[];
    return rows;
  }

  /** Get total usage for a date range */
  getRangeTotal(
    startDate: string,
    endDate: string,
  ): { tokensUsed: number; costUsd: number; sessions: number } {
    const row = this.db
      .query(
        `SELECT
           COALESCE(SUM(tokens_used), 0) as tokensUsed,
           COALESCE(SUM(cost_usd), 0) as costUsd,
           COALESCE(SUM(sessions), 0) as sessions
         FROM daily_usage
         WHERE date BETWEEN ? AND ?`,
      )
      .get(startDate, endDate) as {
      tokensUsed: number;
      costUsd: number;
      sessions: number;
    };
    return row;
  }

  /** Prune records older than N days */
  prune(keepDays: number): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - keepDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const result = this.db.run(
      `DELETE FROM daily_usage WHERE date < ?`,
      [cutoffStr],
    );
    return result.changes;
  }
}
