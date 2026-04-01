// KCode - Audit Logger
// Structured audit trail for enterprise compliance.
// Logs tool executions, permission decisions, and security events to SQLite.

import { log } from "./logger";

interface AuditEntry {
  eventType:
    | "tool_execute"
    | "tool_blocked"
    | "permission_denied"
    | "permission_granted"
    | "model_switch"
    | "session_start"
    | "session_end"
    | "policy_violation"
    | "security_event";
  toolName?: string;
  action: string;
  status: "success" | "blocked" | "error" | "denied";
  reason?: string;
  model?: string;
  sessionId?: string;
  orgId?: string;
  inputSummary?: string; // Truncated, never full input for security
  costUsd?: number;
  tokenCount?: number;
  durationMs?: number;
}

let _auditEnabled = false;
let _orgId: string | undefined;
let _db: any = null;
let _insertStmt: any = null;

/**
 * Initialize audit logging. Must be called once before logging events.
 */
export function initAuditLogger(options: { enabled: boolean; orgId?: string }): void {
  _auditEnabled = options.enabled;
  _orgId = options.orgId;

  if (!_auditEnabled) return;

  try {
    const { getDb } = require("./db.js");
    _db = getDb();

    // Create audit table
    _db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      event_type TEXT NOT NULL,
      tool_name TEXT,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      model TEXT,
      session_id TEXT,
      org_id TEXT,
      input_summary TEXT,
      cost_usd REAL,
      token_count INTEGER,
      duration_ms INTEGER
    )`);

    // Index for common queries
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_log(event_type)`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id)`);

    _insertStmt = _db.prepare(`INSERT INTO audit_log
      (event_type, tool_name, action, status, reason, model, session_id, org_id, input_summary, cost_usd, token_count, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    log.info("audit", `Audit logging initialized${_orgId ? ` (org: ${_orgId})` : ""}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[audit] CRITICAL: Failed to initialize audit logger: ${msg}`);
    console.error(
      `[audit] Audit logging required by policy but could not start. Continuing without audit.`,
    );
    _auditEnabled = false;
  }
}

/**
 * Log an audit event. No-op if audit logging is not enabled.
 */
export function auditLog(entry: AuditEntry): void {
  if (!_auditEnabled || !_insertStmt) return;

  try {
    const orgId = entry.orgId ?? _orgId ?? null;
    // Truncate input summary to prevent sensitive data leakage
    const inputSummary = entry.inputSummary ? entry.inputSummary.slice(0, 200) : null;

    _insertStmt.run(
      entry.eventType,
      entry.toolName ?? null,
      entry.action,
      entry.status,
      entry.reason ?? null,
      entry.model ?? null,
      entry.sessionId ?? null,
      orgId,
      inputSummary,
      entry.costUsd ?? null,
      entry.tokenCount ?? null,
      entry.durationMs ?? null,
    );
  } catch (err) {
    // Don't let audit logging failures break the application
    log.warn("audit", `Failed to write audit entry: ${err}`);
  }
}

/**
 * Log a tool execution event.
 */
export function auditToolExecution(opts: {
  toolName: string;
  status: "success" | "error";
  inputSummary?: string;
  sessionId?: string;
  model?: string;
  durationMs?: number;
}): void {
  auditLog({
    eventType: "tool_execute",
    toolName: opts.toolName,
    action: `Execute tool: ${opts.toolName}`,
    status: opts.status,
    inputSummary: opts.inputSummary,
    sessionId: opts.sessionId,
    model: opts.model,
    durationMs: opts.durationMs,
  });
}

/**
 * Log a permission decision.
 */
export function auditPermissionDecision(opts: {
  toolName: string;
  granted: boolean;
  reason?: string;
  sessionId?: string;
}): void {
  auditLog({
    eventType: opts.granted ? "permission_granted" : "permission_denied",
    toolName: opts.toolName,
    action: `Permission ${opts.granted ? "granted" : "denied"}: ${opts.toolName}`,
    status: opts.granted ? "success" : "denied",
    reason: opts.reason,
    sessionId: opts.sessionId,
  });
}

/**
 * Log a managed policy violation.
 */
export function auditPolicyViolation(opts: {
  action: string;
  reason: string;
  sessionId?: string;
}): void {
  auditLog({
    eventType: "policy_violation",
    action: opts.action,
    status: "blocked",
    reason: opts.reason,
    sessionId: opts.sessionId,
  });
}

/**
 * Log a security-relevant event.
 */
export function auditSecurityEvent(opts: {
  action: string;
  status: "success" | "blocked" | "error";
  reason?: string;
  sessionId?: string;
}): void {
  auditLog({
    eventType: "security_event",
    action: opts.action,
    status: opts.status,
    reason: opts.reason,
    sessionId: opts.sessionId,
  });
}

/**
 * Query recent audit entries (for /audit slash command or API).
 */
export function getAuditEntries(opts?: {
  limit?: number;
  eventType?: string;
  sessionId?: string;
}): Array<Record<string, unknown>> {
  if (!_auditEnabled || !_db) return [];

  try {
    const limit = Math.min(opts?.limit ?? 50, 500);
    let query = "SELECT * FROM audit_log";
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.eventType) {
      conditions.push("event_type = ?");
      params.push(opts.eventType);
    }
    if (opts?.sessionId) {
      conditions.push("session_id = ?");
      params.push(opts.sessionId);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }
    query += " ORDER BY id DESC LIMIT ?";
    params.push(limit);

    return _db.prepare(query).all(...params);
  } catch {
    return [];
  }
}

/**
 * Check if audit logging is enabled.
 */
export function isAuditEnabled(): boolean {
  return _auditEnabled;
}
