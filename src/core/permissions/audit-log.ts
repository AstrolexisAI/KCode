// KCode - Permission Audit Log
// Records all permission decisions for review and debugging.

import { Database } from "bun:sqlite";

// ─── Types ──────────────────────────────────────────────────────

export interface AuditEntry {
  timestamp: number;
  toolName: string;
  action: "allowed" | "denied" | "asked" | "user_approved" | "user_denied";
  inputSummary: string;
  reason?: string;
  sessionId: string;
}

// ─── Constants ──────────────────────────────────────────────────

const MAX_SUMMARY_LENGTH = 200;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS permission_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    action TEXT NOT NULL,
    input_summary TEXT,
    reason TEXT,
    session_id TEXT
  )
`;

const CREATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_audit_tool_name ON permission_audit(tool_name);
  CREATE INDEX IF NOT EXISTS idx_audit_session_id ON permission_audit(session_id);
  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON permission_audit(timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON permission_audit(action);
`;

// ─── AuditLog Class ─────────────────────────────────────────────

export class AuditLog {
  private db: Database;
  private insertStmt: ReturnType<Database["prepare"]>;

  constructor(db: Database) {
    this.db = db;
    this.db.run(CREATE_TABLE_SQL);
    // Run index creation statements individually
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_audit_tool_name ON permission_audit(tool_name)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_audit_session_id ON permission_audit(session_id)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON permission_audit(timestamp)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_audit_action ON permission_audit(action)",
    );

    this.insertStmt = this.db.prepare(`
      INSERT INTO permission_audit (timestamp, tool_name, action, input_summary, reason, session_id)
      VALUES ($timestamp, $tool_name, $action, $input_summary, $reason, $session_id)
    `);
  }

  /**
   * Records a permission decision in the audit log.
   * Truncates inputSummary to MAX_SUMMARY_LENGTH for privacy.
   */
  log(entry: AuditEntry): void {
    const summary = truncateSummary(entry.inputSummary);
    this.insertStmt.run({
      $timestamp: entry.timestamp,
      $tool_name: entry.toolName,
      $action: entry.action,
      $input_summary: summary,
      $reason: entry.reason ?? null,
      $session_id: entry.sessionId,
    });
  }

  /**
   * Retrieves audit history with optional filters.
   */
  getHistory(opts?: {
    toolName?: string;
    sessionId?: string;
    limit?: number;
  }): AuditEntry[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts?.toolName) {
      conditions.push("tool_name = $tool_name");
      params.$tool_name = opts.toolName;
    }
    if (opts?.sessionId) {
      conditions.push("session_id = $session_id");
      params.$session_id = opts.sessionId;
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts?.limit ? `LIMIT ${opts.limit}` : "";

    const sql = `
      SELECT timestamp, tool_name, action, input_summary, reason, session_id
      FROM permission_audit
      ${where}
      ORDER BY timestamp DESC
      ${limit}
    `;

    const rows = this.db.prepare(sql).all(params) as Array<{
      timestamp: number;
      tool_name: string;
      action: string;
      input_summary: string;
      reason: string | null;
      session_id: string;
    }>;

    return rows.map(rowToEntry);
  }

  /**
   * Returns aggregate counts per tool, broken down by action type.
   */
  getSummary(): {
    toolName: string;
    allowed: number;
    denied: number;
    asked: number;
  }[] {
    const sql = `
      SELECT
        tool_name,
        SUM(CASE WHEN action IN ('allowed', 'user_approved') THEN 1 ELSE 0 END) as allowed,
        SUM(CASE WHEN action IN ('denied', 'user_denied') THEN 1 ELSE 0 END) as denied,
        SUM(CASE WHEN action = 'asked' THEN 1 ELSE 0 END) as asked
      FROM permission_audit
      GROUP BY tool_name
      ORDER BY tool_name
    `;

    const rows = this.db.prepare(sql).all() as Array<{
      tool_name: string;
      allowed: number;
      denied: number;
      asked: number;
    }>;

    return rows.map((row) => ({
      toolName: row.tool_name,
      allowed: row.allowed,
      denied: row.denied,
      asked: row.asked,
    }));
  }

  /**
   * Returns recent denied or user_denied entries.
   */
  getRecentDenials(limit: number = 10): AuditEntry[] {
    const sql = `
      SELECT timestamp, tool_name, action, input_summary, reason, session_id
      FROM permission_audit
      WHERE action IN ('denied', 'user_denied')
      ORDER BY timestamp DESC
      LIMIT $limit
    `;

    const rows = this.db.prepare(sql).all({ $limit: limit }) as Array<{
      timestamp: number;
      tool_name: string;
      action: string;
      input_summary: string;
      reason: string | null;
      session_id: string;
    }>;

    return rows.map(rowToEntry);
  }

  /**
   * Deletes entries older than the given timestamp.
   * If no timestamp is provided, deletes all entries.
   * Returns the number of deleted rows.
   */
  clear(beforeTimestamp?: number): number {
    // Count rows to be deleted first
    let count: number;
    if (beforeTimestamp !== undefined) {
      const countRow = this.db
        .prepare(
          "SELECT COUNT(*) as c FROM permission_audit WHERE timestamp < $before",
        )
        .get({ $before: beforeTimestamp }) as { c: number };
      count = countRow.c;
      this.db
        .prepare("DELETE FROM permission_audit WHERE timestamp < $before")
        .run({ $before: beforeTimestamp });
    } else {
      const countRow = this.db
        .prepare("SELECT COUNT(*) as c FROM permission_audit")
        .get() as { c: number };
      count = countRow.c;
      this.db.run("DELETE FROM permission_audit");
    }
    return count;
  }

  /**
   * Formats the summary data as a human-readable table.
   */
  formatSummary(
    summary: { toolName: string; allowed: number; denied: number; asked: number }[],
  ): string {
    if (summary.length === 0) {
      return "No permission audit data recorded.";
    }

    // Calculate column widths
    const toolWidth = Math.max(
      4, // "Tool"
      ...summary.map((s) => s.toolName.length),
    );
    const allowedWidth = 7; // "Allowed"
    const deniedWidth = 6; // "Denied"
    const askedWidth = 5; // "Asked"

    const header = [
      "Tool".padEnd(toolWidth),
      "Allowed".padStart(allowedWidth),
      "Denied".padStart(deniedWidth),
      "Asked".padStart(askedWidth),
    ].join("  ");

    const separator = [
      "-".repeat(toolWidth),
      "-".repeat(allowedWidth),
      "-".repeat(deniedWidth),
      "-".repeat(askedWidth),
    ].join("  ");

    const rows = summary.map((s) =>
      [
        s.toolName.padEnd(toolWidth),
        String(s.allowed).padStart(allowedWidth),
        String(s.denied).padStart(deniedWidth),
        String(s.asked).padStart(askedWidth),
      ].join("  "),
    );

    return [header, separator, ...rows].join("\n");
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function truncateSummary(summary: string): string {
  if (summary.length <= MAX_SUMMARY_LENGTH) return summary;
  return summary.slice(0, MAX_SUMMARY_LENGTH - 3) + "...";
}

function rowToEntry(row: {
  timestamp: number;
  tool_name: string;
  action: string;
  input_summary: string;
  reason: string | null;
  session_id: string;
}): AuditEntry {
  return {
    timestamp: row.timestamp,
    toolName: row.tool_name,
    action: row.action as AuditEntry["action"],
    inputSummary: row.input_summary,
    reason: row.reason ?? undefined,
    sessionId: row.session_id,
  };
}
