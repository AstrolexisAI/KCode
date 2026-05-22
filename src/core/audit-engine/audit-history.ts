// KCode - Audit History (per-pattern empirical precision tracking)
//
// Append-only SQLite log of every verifier verdict, separate from the
// awareness DB. Powers per-pattern precision computed from REAL audits
// instead of curated fixtures — feeds future auto-decomposition of
// noisy patterns and a "stop wasting LLM cycles on this" --exclude-noisy
// flag once enough data accumulates.
//
// Schema is intentionally minimal: pattern_id + verdict + timestamp +
// file_path. file_path is opt-in (kept short or hashed in callers that
// don't want full path stored). No personal data, no candidate text —
// just enough to compute per-pattern precision.
//
// All operations are best-effort: DB issues NEVER raise out of this
// module. The audit pipeline keeps working if the DB is missing,
// locked, or corrupted.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger";
import { kcodeHome } from "../paths";

let _db: Database | null = null;

function resolveDbPath(): string {
  return process.env.KCODE_AUDIT_HISTORY_PATH ?? join(kcodeHome(), "audit-history.db");
}

function getHistoryDb(): Database | null {
  if (_db) return _db;
  try {
    const path = resolveDbPath();
    if (path !== ":memory:") {
      mkdirSync(kcodeHome(), { recursive: true });
    }
    const db = new Database(path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS verdicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_id TEXT NOT NULL,
        verdict TEXT NOT NULL,
        file_path TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_verdicts_pattern ON verdicts(pattern_id);
      CREATE INDEX IF NOT EXISTS idx_verdicts_ts ON verdicts(timestamp);
    `);
    _db = db;
    return db;
  } catch (err) {
    log.debug("audit-history", `Failed to open history DB: ${err}`);
    return null;
  }
}

/**
 * Record a verdict for a pattern. Never throws — silently no-ops on
 * any DB failure (lock, disk full, corrupted file, …). The audit must
 * not break because the history log can't be written.
 */
export function recordVerdict(
  pattern_id: string,
  verdict: "confirmed" | "false_positive" | "needs_context",
  file_path?: string,
): void {
  const db = getHistoryDb();
  if (!db) return;
  try {
    db.run("INSERT INTO verdicts (pattern_id, verdict, file_path, timestamp) VALUES (?, ?, ?, ?)", [
      pattern_id,
      verdict,
      file_path ?? null,
      Date.now(),
    ]);
  } catch (err) {
    log.debug("audit-history", `Failed to record verdict for ${pattern_id}: ${err}`);
  }
}

export interface PatternPrecision {
  pattern_id: string;
  total: number;
  confirmed: number;
  false_positive: number;
  needs_context: number;
  /** confirmed / (confirmed + false_positive) — excludes needs_context. */
  precision: number;
  /** confirmed / total — includes needs_context in denominator. */
  confirm_rate: number;
  /** First and last verdict timestamps for this pattern. */
  first_seen: number;
  last_seen: number;
}

/**
 * Compute empirical precision for a single pattern. Returns null when
 * the pattern has fewer than `minSamples` recorded verdicts (precision
 * on a small sample is statistical noise — don't show it).
 */
export function getPatternPrecision(pattern_id: string, minSamples = 1): PatternPrecision | null {
  const db = getHistoryDb();
  if (!db) return null;
  try {
    const row = db
      .query(
        `SELECT
           SUM(verdict = 'confirmed') AS confirmed,
           SUM(verdict = 'false_positive') AS false_positive,
           SUM(verdict = 'needs_context') AS needs_context,
           COUNT(*) AS total,
           MIN(timestamp) AS first_seen,
           MAX(timestamp) AS last_seen
         FROM verdicts WHERE pattern_id = ?`,
      )
      .get(pattern_id) as
      | {
          confirmed: number | null;
          false_positive: number | null;
          needs_context: number | null;
          total: number;
          first_seen: number | null;
          last_seen: number | null;
        }
      | undefined;
    if (!row || row.total < minSamples) return null;
    const c = row.confirmed ?? 0;
    const fp = row.false_positive ?? 0;
    const nc = row.needs_context ?? 0;
    const decisive = c + fp;
    return {
      pattern_id,
      total: row.total,
      confirmed: c,
      false_positive: fp,
      needs_context: nc,
      precision: decisive > 0 ? c / decisive : 0,
      confirm_rate: row.total > 0 ? c / row.total : 0,
      first_seen: row.first_seen ?? 0,
      last_seen: row.last_seen ?? 0,
    };
  } catch (err) {
    log.debug("audit-history", `Failed to compute precision for ${pattern_id}: ${err}`);
    return null;
  }
}

/**
 * List all patterns with at least `minSamples` verdicts, sorted by
 * empirical confirm_rate ascending (noisiest first). Used by the
 * report-generator's "noisy patterns" section and by future
 * auto-decomposition tooling.
 */
export function getAllPatternPrecision(minSamples = 50): PatternPrecision[] {
  const db = getHistoryDb();
  if (!db) return [];
  try {
    const rows = db
      .query(
        `SELECT
           pattern_id,
           SUM(verdict = 'confirmed') AS confirmed,
           SUM(verdict = 'false_positive') AS false_positive,
           SUM(verdict = 'needs_context') AS needs_context,
           COUNT(*) AS total,
           MIN(timestamp) AS first_seen,
           MAX(timestamp) AS last_seen
         FROM verdicts
         GROUP BY pattern_id
         HAVING total >= ?
         ORDER BY (CAST(confirmed AS REAL) / total) ASC, total DESC`,
      )
      .all(minSamples) as Array<{
      pattern_id: string;
      confirmed: number | null;
      false_positive: number | null;
      needs_context: number | null;
      total: number;
      first_seen: number | null;
      last_seen: number | null;
    }>;
    return rows.map((r) => {
      const c = r.confirmed ?? 0;
      const fp = r.false_positive ?? 0;
      const nc = r.needs_context ?? 0;
      const decisive = c + fp;
      return {
        pattern_id: r.pattern_id,
        total: r.total,
        confirmed: c,
        false_positive: fp,
        needs_context: nc,
        precision: decisive > 0 ? c / decisive : 0,
        confirm_rate: r.total > 0 ? c / r.total : 0,
        first_seen: r.first_seen ?? 0,
        last_seen: r.last_seen ?? 0,
      };
    });
  } catch (err) {
    log.debug("audit-history", `Failed to list pattern precision: ${err}`);
    return [];
  }
}

/** Total verdicts recorded — gates "we have enough data" UI affordances. */
export function getTotalVerdictCount(): number {
  const db = getHistoryDb();
  if (!db) return 0;
  try {
    const row = db.query("SELECT COUNT(*) AS n FROM verdicts").get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/** Test-only: reset cached DB handle so tests can swap KCODE_AUDIT_HISTORY_PATH. */
export function _resetAuditHistoryForTest(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      /* ignore */
    }
  }
  _db = null;
}
