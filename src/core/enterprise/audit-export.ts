// KCode - Enterprise Audit Export
// Export tool usage audit logs to JSON or CSV format with sensitive data redaction.
// Works entirely offline using the local analytics SQLite database.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getDb } from "../db";
import { log } from "../logger";

// ─── Types ──────────────────────────────────────────────────────

export interface AuditExportOptions {
  from: Date;
  to: Date;
  format: "json" | "csv";
  outputPath: string;
}

export interface AuditEntry {
  timestamp: string;
  user: string;
  tool: string;
  parameters_summary: string;
  result_status: string;
  duration_ms: number;
}

// ─── Sensitive Data Redaction ──────────────────────────────────

const SENSITIVE_PATTERNS = [
  /(?:api[_-]?key|apikey|secret|token|password|credential|auth)["\s:=]+["']?[A-Za-z0-9\-_.]{8,}["']?/gi,
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{36,}/g,
  /Bearer\s+[A-Za-z0-9\-_.]+/gi,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END/gi,
];

export function redactSensitiveData(text: string): string {
  let redacted = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

// ─── Export Logic ──────────────────────────────────────────────

/**
 * Query audit entries from the analytics database within a date range.
 */
export function queryAuditEntries(from: Date, to: Date): AuditEntry[] {
  const db = getDb();

  const fromStr = from.toISOString();
  const toStr = to.toISOString();

  let rows: Array<Record<string, unknown>>;
  try {
    rows = db
      .query(
        `SELECT session_id, tool_name, model, duration_ms, is_error, created_at
         FROM tool_analytics
         WHERE created_at >= ? AND created_at <= ?
         ORDER BY created_at ASC`,
      )
      .all(fromStr, toStr) as Array<Record<string, unknown>>;
  } catch {
    // Table may not exist if analytics was never enabled
    rows = [];
  }

  return rows.map((r) => ({
    timestamp: String(r.created_at ?? ""),
    user: redactSensitiveData(String(r.session_id ?? "unknown")),
    tool: String(r.tool_name ?? ""),
    parameters_summary: redactSensitiveData(String(r.model ?? "")),
    result_status: r.is_error ? "error" : "success",
    duration_ms: Number(r.duration_ms ?? 0),
  }));
}

/**
 * Format audit entries as CSV.
 */
export function formatCsv(entries: AuditEntry[]): string {
  const header = "timestamp,user,tool,parameters_summary,result_status,duration_ms";
  const lines = entries.map((e) => {
    const escaped = (s: string) => `"${s.replace(/"/g, '""')}"`;
    return [
      escaped(e.timestamp),
      escaped(e.user),
      escaped(e.tool),
      escaped(e.parameters_summary),
      escaped(e.result_status),
      String(e.duration_ms),
    ].join(",");
  });
  return [header, ...lines].join("\n");
}

/**
 * Format audit entries as JSON.
 */
export function formatJson(entries: AuditEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

/**
 * Export audit log to a file in the specified format.
 * Returns the path of the output file.
 */
export async function exportAuditLog(options: AuditExportOptions): Promise<string> {
  const { from, to, format, outputPath } = options;

  if (from > to) {
    throw new Error("'from' date must be before 'to' date");
  }

  const entries = queryAuditEntries(from, to);

  const content = format === "csv" ? formatCsv(entries) : formatJson(entries);

  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, content, "utf-8");

  log.info("audit-export", `Exported ${entries.length} entries to ${outputPath} (${format})`);
  return outputPath;
}
