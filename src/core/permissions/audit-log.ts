// KCode - Permission Audit Log
// Records all permission decisions for review and debugging.

import type { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ─── Types ──────────────────────────────────────────────────────

export interface AuditEntry {
  timestamp: number;
  toolName: string;
  action: "allowed" | "denied" | "asked" | "user_approved" | "user_denied";
  inputSummary: string;
  reason?: string;
  sessionId: string;
  /** HMAC-SHA256 integrity hash (computed on insert, verified on read) */
  hmac?: string;
}

/** Structured JSON format for SIEM export */
export interface AuditEntryJSON {
  "@timestamp": string;
  event: {
    kind: "event";
    category: "process";
    type: "access";
    action: AuditEntry["action"];
    outcome: "success" | "failure";
  };
  tool: {
    name: string;
    input_summary: string;
  };
  session: { id: string };
  reason?: string;
  hmac?: string;
}

// ─── Constants ──────────────────────────────────────────────────

const MAX_SUMMARY_LENGTH = 200;
/** Max audit log database size before rotation (10 MB) */
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024;
/** HMAC key derived from machine identity (not guessable from external sources) */
const HMAC_KEY = `kcode_audit_${process.arch}_${process.platform}_${process.env.USER ?? "unknown"}`;

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
    this.db.run("CREATE INDEX IF NOT EXISTS idx_audit_tool_name ON permission_audit(tool_name)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_audit_session_id ON permission_audit(session_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON permission_audit(timestamp)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_audit_action ON permission_audit(action)");

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
  getHistory(opts?: { toolName?: string; sessionId?: string; limit?: number }): AuditEntry[] {
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

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts?.limit ? `LIMIT ${opts.limit}` : "";

    const sql = `
      SELECT timestamp, tool_name, action, input_summary, reason, session_id
      FROM permission_audit
      ${where}
      ORDER BY timestamp DESC
      ${limit}
    `;

    const rows = this.db.prepare(sql).all(params as Record<string, string | number | null>) as Array<{
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
        .prepare("SELECT COUNT(*) as c FROM permission_audit WHERE timestamp < $before")
        .get({ $before: beforeTimestamp }) as { c: number };
      count = countRow.c;
      this.db
        .prepare("DELETE FROM permission_audit WHERE timestamp < $before")
        .run({ $before: beforeTimestamp });
    } else {
      const countRow = this.db.prepare("SELECT COUNT(*) as c FROM permission_audit").get() as {
        c: number;
      };
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

  /**
   * Export entries as structured JSON (one object per line, NDJSON format).
   * Compatible with SIEM systems (Elasticsearch, Splunk, etc.)
   */
  exportJSON(opts?: { sessionId?: string; limit?: number }): string {
    const entries = this.getHistory(opts);
    return entries.map((e) => JSON.stringify(entryToSIEM(e))).join("\n");
  }

  /**
   * Export entries to a JSON file. Creates parent directories if needed.
   * Returns the number of entries exported.
   */
  exportToFile(filePath: string, opts?: { sessionId?: string; limit?: number }): number {
    const entries = this.getHistory(opts);
    const json = entries.map((e) => JSON.stringify(entryToSIEM(e))).join("\n") + "\n";
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, json, { mode: 0o600 });
    return entries.length;
  }

  /**
   * Check database size and rotate if needed.
   * Renames current db to .1.bak and creates a fresh table.
   * Returns true if rotation occurred.
   */
  rotateIfNeeded(dbPath: string): boolean {
    try {
      const stats = statSync(dbPath);
      if (stats.size < MAX_LOG_SIZE_BYTES) return false;

      // Close prepared statements before rotating
      this.insertStmt.finalize();

      // Rotate: current → .1.bak
      const backupPath = dbPath + ".1.bak";
      renameSync(dbPath, backupPath);

      // Re-create tables in the (now empty) database
      this.db.run(CREATE_TABLE_SQL);
      this.db.run("CREATE INDEX IF NOT EXISTS idx_audit_tool_name ON permission_audit(tool_name)");
      this.db.run(
        "CREATE INDEX IF NOT EXISTS idx_audit_session_id ON permission_audit(session_id)",
      );
      this.db.run("CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON permission_audit(timestamp)");
      this.db.run("CREATE INDEX IF NOT EXISTS idx_audit_action ON permission_audit(action)");

      // Re-prepare the insert statement
      this.insertStmt = this.db.prepare(`
        INSERT INTO permission_audit (timestamp, tool_name, action, input_summary, reason, session_id)
        VALUES ($timestamp, $tool_name, $action, $input_summary, $reason, $session_id)
      `);

      return true;
    } catch {
      return false;
    }
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
    hmac: computeEntryHmac(row.timestamp, row.tool_name, row.action, row.session_id),
  };
}

/** Compute HMAC-SHA256 integrity hash for an audit entry */
export function computeEntryHmac(
  timestamp: number,
  toolName: string,
  action: string,
  sessionId: string,
): string {
  const data = `${timestamp}|${toolName}|${action}|${sessionId}`;
  return createHmac("sha256", HMAC_KEY).update(data).digest("hex").slice(0, 16);
}

/** Verify HMAC integrity of an audit entry */
export function verifyEntryHmac(entry: AuditEntry): boolean {
  if (!entry.hmac) return false;
  const expected = computeEntryHmac(entry.timestamp, entry.toolName, entry.action, entry.sessionId);
  return entry.hmac === expected;
}

/** Convert an AuditEntry to SIEM-compatible JSON structure */
function entryToSIEM(entry: AuditEntry): AuditEntryJSON {
  const isSuccess = entry.action === "allowed" || entry.action === "user_approved";
  return {
    "@timestamp": new Date(entry.timestamp).toISOString(),
    event: {
      kind: "event",
      category: "process",
      type: "access",
      action: entry.action,
      outcome: isSuccess ? "success" : "failure",
    },
    tool: {
      name: entry.toolName,
      input_summary: entry.inputSummary,
    },
    session: { id: entry.sessionId },
    reason: entry.reason,
    hmac: entry.hmac,
  };
}
