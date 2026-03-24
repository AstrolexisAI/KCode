// KCode - Persistent Tool Analytics
// Records tool usage events to SQLite and provides cross-session analytics.

import { getDb } from "./db";
import { log } from "./logger";

// ─── Telemetry Gate ─────────────────────────────────────────────
// undefined = not yet decided (first run) — recording is disabled until explicit opt-in.

let _telemetryEnabled: boolean | undefined;

/**
 * Set whether telemetry (local analytics recording) is enabled.
 * Called once at startup based on config.telemetry, and again if the user toggles via /telemetry.
 */
export function setTelemetryEnabled(enabled: boolean): void {
  _telemetryEnabled = enabled;
}

/**
 * Returns current telemetry state: true (opted in), false (opted out), or undefined (not yet decided).
 */
export function isTelemetryEnabled(): boolean | undefined {
  return _telemetryEnabled;
}

export interface ToolEvent {
  sessionId: string;
  toolName: string;
  model: string;
  durationMs: number;
  isError: boolean;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/**
 * Record a tool usage event to the analytics table.
 */
export function recordToolEvent(event: ToolEvent): void {
  // Skip recording if telemetry is disabled or not yet decided (undefined)
  if (_telemetryEnabled !== true) return;

  try {
    const db = getDb();
    db.run(
      `INSERT INTO tool_analytics (session_id, tool_name, model, duration_ms, is_error, input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.sessionId,
        event.toolName,
        event.model,
        event.durationMs,
        event.isError ? 1 : 0,
        event.inputTokens ?? 0,
        event.outputTokens ?? 0,
        event.costUsd ?? 0,
      ],
    );
  } catch (err) {
    log.debug("analytics", `Failed to record tool event: ${err}`);
  }
}

export interface AnalyticsSummary {
  totalSessions: number;
  totalToolCalls: number;
  totalErrors: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  toolBreakdown: Array<{ tool: string; count: number; errors: number; avgMs: number }>;
  dailyActivity: Array<{ date: string; calls: number }>;
  modelBreakdown: Array<{ model: string; calls: number; costUsd: number }>;
}

/**
 * Get analytics summary for the last N days.
 */
export function getAnalyticsSummary(days: number = 7): AnalyticsSummary {
  const db = getDb();

  // Clamp days to valid range
  if (!Number.isFinite(days) || days < 1) days = 1;
  if (days > 3650) days = 3650;

  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const totals = db.query<{ sessions: number; calls: number; errors: number; cost: number; inp: number; out: number }, [string]>(
    `SELECT
       COUNT(DISTINCT session_id) as sessions,
       COUNT(*) as calls,
       SUM(is_error) as errors,
       SUM(cost_usd) as cost,
       SUM(input_tokens) as inp,
       SUM(output_tokens) as out
     FROM tool_analytics WHERE created_at >= ?`
  ).get(cutoff);

  const toolRows = db.query<{ tool: string; count: number; errors: number; avg_ms: number }, [string]>(
    `SELECT tool_name as tool, COUNT(*) as count, SUM(is_error) as errors, AVG(duration_ms) as avg_ms
     FROM tool_analytics WHERE created_at >= ?
     GROUP BY tool_name ORDER BY count DESC`
  ).all(cutoff);

  const dailyRows = db.query<{ date: string; calls: number }, [string]>(
    `SELECT DATE(created_at) as date, COUNT(*) as calls
     FROM tool_analytics WHERE created_at >= ?
     GROUP BY DATE(created_at) ORDER BY date DESC LIMIT 30`
  ).all(cutoff);

  const modelRows = db.query<{ model: string; calls: number; cost: number }, [string]>(
    `SELECT model, COUNT(*) as calls, SUM(cost_usd) as cost
     FROM tool_analytics WHERE created_at >= ? AND model != ''
     GROUP BY model ORDER BY calls DESC`
  ).all(cutoff);

  return {
    totalSessions: totals?.sessions ?? 0,
    totalToolCalls: totals?.calls ?? 0,
    totalErrors: totals?.errors ?? 0,
    totalCostUsd: totals?.cost ?? 0,
    totalInputTokens: totals?.inp ?? 0,
    totalOutputTokens: totals?.out ?? 0,
    toolBreakdown: toolRows.map(r => ({ tool: r.tool, count: r.count, errors: r.errors, avgMs: Math.round(r.avg_ms) })),
    dailyActivity: dailyRows.map(r => ({ date: r.date, calls: r.calls })),
    modelBreakdown: modelRows.map(r => ({ model: r.model, calls: r.calls, costUsd: r.cost })),
  };
}

/**
 * Format analytics summary for display.
 */
export function formatAnalyticsSummary(summary: AnalyticsSummary, days: number): string {
  const lines: string[] = [
    `  Analytics (last ${days} days)\n`,
    `  Sessions:    ${summary.totalSessions}`,
    `  Tool calls:  ${summary.totalToolCalls}`,
    `  Errors:      ${summary.totalErrors} (${summary.totalToolCalls > 0 ? Math.round((summary.totalErrors / summary.totalToolCalls) * 100) : 0}%)`,
    `  Tokens:      ${(summary.totalInputTokens + summary.totalOutputTokens).toLocaleString()}`,
    `  Cost:        $${summary.totalCostUsd.toFixed(4)}`,
  ];

  if (summary.toolBreakdown.length > 0) {
    lines.push("", "  Tool Usage:");
    const maxName = Math.max(...summary.toolBreakdown.map(t => t.tool.length), 8);
    const maxCount = summary.toolBreakdown[0]?.count ?? 1;
    const barW = 15;

    for (const t of summary.toolBreakdown.slice(0, 15)) {
      const filled = Math.round((t.count / maxCount) * barW);
      const bar = "\u2588".repeat(filled) + "\u2591".repeat(barW - filled);
      const errStr = t.errors > 0 ? ` (${t.errors} err)` : "";
      lines.push(`  ${t.tool.padEnd(maxName)} ${bar} ${t.count} ~${t.avgMs}ms${errStr}`);
    }
  }

  if (summary.modelBreakdown.length > 0) {
    lines.push("", "  By Model:");
    for (const m of summary.modelBreakdown) {
      const cost = m.costUsd > 0 ? ` ($${m.costUsd.toFixed(4)})` : "";
      lines.push(`    ${m.model}: ${m.calls} calls${cost}`);
    }
  }

  if (summary.dailyActivity.length > 0) {
    lines.push("", "  Daily Activity:");
    for (const d of summary.dailyActivity.slice(0, 7)) {
      const bar = "\u2588".repeat(Math.min(30, Math.round(d.calls / 5)));
      lines.push(`    ${d.date} ${bar} ${d.calls}`);
    }
  }

  return lines.join("\n");
}

/**
 * Export analytics as JSON or CSV (Pro only).
 */
export async function exportAnalytics(
  days: number = 30,
  format: "json" | "csv" = "json",
): Promise<string> {
  const { requirePro } = await import("./pro.js");
  await requirePro("analytics-export");

  const db = getDb();
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db.query(
    `SELECT session_id, tool_name, model, duration_ms, is_error,
            input_tokens, output_tokens, cost_usd, created_at
     FROM tool_analytics
     WHERE created_at >= ?
     ORDER BY created_at DESC`
  ).all(cutoff) as Array<Record<string, unknown>>;

  if (format === "csv") {
    const header = "session_id,tool_name,model,duration_ms,is_error,input_tokens,output_tokens,cost_usd,created_at";
    const lines = rows.map(r =>
      `${r.session_id},${r.tool_name},${r.model ?? ""},${r.duration_ms},${r.is_error ? 1 : 0},${r.input_tokens ?? 0},${r.output_tokens ?? 0},${r.cost_usd ?? 0},${r.created_at}`
    );
    return [header, ...lines].join("\n");
  }

  return JSON.stringify(rows, null, 2);
}
