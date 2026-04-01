// KCode - Persistent Cost Tracker
// Records and queries cost history in SQLite.

import { getDb } from "../db";
import { log } from "../logger";
import type { CostEntry, CostPeriod, CostSummary } from "./types";

export class CostTracker {
  constructor() {
    this.ensureTable();
  }

  private ensureTable(): void {
    try {
      const db = getDb();
      db.run(`CREATE TABLE IF NOT EXISTS cost_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        tool_name TEXT
      )`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_cost_timestamp ON cost_history(timestamp)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_cost_session ON cost_history(session_id)`);
    } catch (err) {
      log.debug("cost/tracker", `Table init error: ${err}`);
    }
  }

  record(entry: CostEntry): void {
    try {
      const db = getDb();
      db.run(
        `INSERT INTO cost_history (timestamp, session_id, model, provider, input_tokens, output_tokens, cost_usd, tool_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.timestamp,
          entry.sessionId,
          entry.model,
          entry.provider,
          entry.inputTokens,
          entry.outputTokens,
          entry.costUsd,
          entry.toolName ?? null,
        ],
      );
    } catch (err) {
      log.debug("cost/tracker", `Record error: ${err}`);
    }
  }

  getSummary(period: CostPeriod): CostSummary {
    const db = getDb();
    const since = this.periodToTimestamp(period);

    const totals = db
      .query<
        { sessions: number; input_tokens: number; output_tokens: number; cost_usd: number },
        [number]
      >(
        `SELECT COUNT(DISTINCT session_id) as sessions,
              COALESCE(SUM(input_tokens), 0) as input_tokens,
              COALESCE(SUM(output_tokens), 0) as output_tokens,
              COALESCE(SUM(cost_usd), 0) as cost_usd
       FROM cost_history WHERE timestamp >= ?`,
      )
      .get(since);

    const byModel = db
      .query<{ model: string; cost_usd: number }, [number]>(
        `SELECT model, SUM(cost_usd) as cost_usd
       FROM cost_history WHERE timestamp >= ?
       GROUP BY model ORDER BY cost_usd DESC`,
      )
      .all(since);

    const byDay = db
      .query<{ date: string; cost_usd: number }, [number]>(
        `SELECT date(timestamp / 1000, 'unixepoch') as date, SUM(cost_usd) as cost_usd
       FROM cost_history WHERE timestamp >= ?
       GROUP BY date ORDER BY date`,
      )
      .all(since);

    const totalCost = totals?.cost_usd ?? 0;
    const sessions = totals?.sessions ?? 0;

    // Calculate trend vs previous period
    const { trend, trendPercentage } = this.calculateTrend(since, totalCost);

    return {
      period,
      totalCostUsd: totalCost,
      totalInputTokens: totals?.input_tokens ?? 0,
      totalOutputTokens: totals?.output_tokens ?? 0,
      sessions,
      avgCostPerSession: sessions > 0 ? totalCost / sessions : 0,
      byModel: byModel.map((m) => ({
        model: m.model,
        costUsd: m.cost_usd,
        percentage: totalCost > 0 ? (m.cost_usd / totalCost) * 100 : 0,
      })),
      byDay: byDay.map((d) => ({ date: d.date, costUsd: d.cost_usd })),
      trend,
      trendPercentage,
    };
  }

  private calculateTrend(
    since: number,
    currentCost: number,
  ): { trend: "up" | "down" | "stable"; trendPercentage: number } {
    const periodLength = Date.now() - since;
    if (periodLength <= 0 || since === 0) return { trend: "stable", trendPercentage: 0 };

    const previousSince = since - periodLength;
    try {
      const db = getDb();
      const prev = db
        .query<{ cost_usd: number }, [number, number]>(
          `SELECT COALESCE(SUM(cost_usd), 0) as cost_usd FROM cost_history WHERE timestamp >= ? AND timestamp < ?`,
        )
        .get(previousSince, since);

      const prevCost = prev?.cost_usd ?? 0;
      if (prevCost === 0 && currentCost === 0) return { trend: "stable", trendPercentage: 0 };
      if (prevCost === 0) return { trend: "up", trendPercentage: 100 };

      const change = ((currentCost - prevCost) / prevCost) * 100;
      if (Math.abs(change) < 5) return { trend: "stable", trendPercentage: Math.round(change) };
      return { trend: change > 0 ? "up" : "down", trendPercentage: Math.round(Math.abs(change)) };
    } catch {
      return { trend: "stable", trendPercentage: 0 };
    }
  }

  private periodToTimestamp(period: CostPeriod): number {
    const now = Date.now();
    switch (period) {
      case "today":
        return now - 24 * 60 * 60 * 1000;
      case "week":
        return now - 7 * 24 * 60 * 60 * 1000;
      case "month":
        return now - 30 * 24 * 60 * 60 * 1000;
      case "all":
        return 0;
    }
  }
}
