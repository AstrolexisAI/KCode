// KCode - Shared SQLite Database Module
// Single connection to awareness.db shared across narrative, user-model, world-model, and learn

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger";
import { kcodeHome } from "./paths";

let _db: Database | null = null;

/**
 * Resolve the DB path at call time so env var overrides work in tests.
 */
function resolveDbPath(): string {
  return process.env.KCODE_DB_PATH ?? join(kcodeHome(), "awareness.db");
}

/**
 * Get the shared Database instance for awareness.db.
 * Creates and initializes the connection on first call.
 *
 * Override the DB location via:
 * - KCODE_DB_PATH env var (full path to .db file)
 * - KCODE_HOME env var (uses <KCODE_HOME>/awareness.db)
 * - Pass ":memory:" as KCODE_DB_PATH for in-memory testing
 */
export function getDb(): Database {
  if (_db) return _db;

  const dbPath = resolveDbPath();
  const isMemory = dbPath === ":memory:";
  if (!isMemory) {
    const { dirname } = require("node:path") as typeof import("node:path");
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  _db = new Database(dbPath);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA busy_timeout=5000");

  initSchema(_db);
  runPendingMigrations(_db);

  log.info("db", `Opened shared DB connection: ${isMemory ? ":memory:" : dbPath}`);
  return _db;
}

/**
 * Close the shared database connection.
 */
export function closeDb(): void {
  if (_db) {
    try {
      _db.close();
      log.info("db", "Closed awareness.db connection");
    } catch (err) {
      log.error("db", `Error closing awareness.db: ${err}`);
    }
    _db = null;
  }
}

/**
 * Consolidated schema initialization — creates all tables used by
 * narrative, user-model, world-model, and learn modules.
 */
function initSchema(db: Database): void {
  // narrative.ts tables
  db.exec(`CREATE TABLE IF NOT EXISTS narrative (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    summary TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    tools_used TEXT DEFAULT '',
    actions_taken INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // user-model.ts tables
  db.exec(`CREATE TABLE IF NOT EXISTS user_model (
    key TEXT PRIMARY KEY, value REAL NOT NULL, samples INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS user_interests (
    topic TEXT PRIMARY KEY, frequency INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS user_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  // world-model.ts tables
  db.exec(`CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    expected TEXT NOT NULL,
    actual TEXT,
    confidence REAL NOT NULL DEFAULT 0.5,
    correct INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // learn.ts tables
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`CREATE TABLE IF NOT EXISTS learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    content TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    project TEXT,
    tags TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    access_count INTEGER DEFAULT 0
  )`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(
    topic, content, tags, content='learnings', content_rowid='id'
  )`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS learnings_ai AFTER INSERT ON learnings BEGIN
    INSERT INTO learnings_fts(rowid, topic, content, tags) VALUES (new.id, new.topic, new.content, new.tags);
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS learnings_ad AFTER DELETE ON learnings BEGIN
    INSERT INTO learnings_fts(learnings_fts, rowid, topic, content, tags) VALUES ('delete', old.id, old.topic, old.content, old.tags);
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS learnings_au AFTER UPDATE ON learnings BEGIN
    INSERT INTO learnings_fts(learnings_fts, rowid, topic, content, tags) VALUES ('delete', old.id, old.topic, old.content, old.tags);
    INSERT INTO learnings_fts(rowid, topic, content, tags) VALUES (new.id, new.topic, new.content, new.tags);
  END`);

  // distillation.ts tables — knowledge distillation (RAG-based few-shot learning)
  db.exec(`CREATE TABLE IF NOT EXISTS distilled_examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_query TEXT NOT NULL,
    assistant_response TEXT NOT NULL,
    tool_chain TEXT DEFAULT '[]',
    tool_count INTEGER DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 1,
    project TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    quality REAL NOT NULL DEFAULT 1.0,
    use_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS distilled_fts USING fts5(
    user_query, assistant_response, tags, content='distilled_examples', content_rowid='id'
  )`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS distilled_ai AFTER INSERT ON distilled_examples BEGIN
    INSERT INTO distilled_fts(rowid, user_query, assistant_response, tags)
    VALUES (new.id, new.user_query, new.assistant_response, new.tags);
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS distilled_ad AFTER DELETE ON distilled_examples BEGIN
    INSERT INTO distilled_fts(distilled_fts, rowid, user_query, assistant_response, tags)
    VALUES ('delete', old.id, old.user_query, old.assistant_response, old.tags);
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS distilled_au AFTER UPDATE ON distilled_examples BEGIN
    INSERT INTO distilled_fts(distilled_fts, rowid, user_query, assistant_response, tags)
    VALUES ('delete', old.id, old.user_query, old.assistant_response, old.tags);
    INSERT INTO distilled_fts(rowid, user_query, assistant_response, tags)
    VALUES (new.id, new.user_query, new.assistant_response, new.tags);
  END`);

  // benchmarks.ts tables — model quality tracking
  db.exec(`CREATE TABLE IF NOT EXISTS benchmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    task_type TEXT NOT NULL DEFAULT 'general',
    score REAL NOT NULL,
    tokens_used INTEGER DEFAULT 0,
    latency_ms INTEGER DEFAULT 0,
    details TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bench_model ON benchmarks(model)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bench_date ON benchmarks(created_at)`);

  // plan.ts tables — structured plan persistence
  db.exec(`CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    steps TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // analytics.ts tables — persistent tool usage analytics
  db.exec(`CREATE TABLE IF NOT EXISTS tool_analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL DEFAULT '',
    tool_name TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER DEFAULT 0,
    is_error INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_analytics_tool ON tool_analytics(tool_name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_analytics_date ON tool_analytics(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_analytics_session ON tool_analytics(session_id)`);

  // tasks.ts tables — persistent task management
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    owner TEXT DEFAULT '',
    blocks TEXT DEFAULT '[]',
    blocked_by TEXT DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    session_id TEXT DEFAULT '',
    completed_at TEXT DEFAULT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id)`);

  // transcript-search.ts tables — FTS5 over transcripts for instant search
  db.exec(`CREATE TABLE IF NOT EXISTS transcript_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_file TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    entry_type TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
    content, session_file, role, content='transcript_entries', content_rowid='id'
  )`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS transcript_ai AFTER INSERT ON transcript_entries BEGIN
    INSERT INTO transcript_fts(rowid, content, session_file, role) VALUES (new.id, new.content, new.session_file, new.role);
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS transcript_ad AFTER DELETE ON transcript_entries BEGIN
    INSERT INTO transcript_fts(transcript_fts, rowid, content, session_file, role) VALUES ('delete', old.id, old.content, old.session_file, old.role);
  END`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript_entries(session_file)`);

  // branch-manager.ts tables — persistent conversation branch tracking
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_branches (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    label TEXT DEFAULT '',
    session_file TEXT NOT NULL,
    created_at TEXT NOT NULL,
    message_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active'
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_branches_parent ON conversation_branches(parent_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_branches_status ON conversation_branches(status)`);

  // memory-store.ts tables — enhanced structured memory with categories, confidence, expiry
  const { initMemoryStoreSchema } = require("./memory-store") as typeof import("./memory-store");
  initMemoryStoreSchema(db);
}

/**
 * Run any pending database/config/data migrations.
 * Called synchronously during DB init — migrations run via .run() which is async,
 * but we fire-and-forget since migrations must not block startup fatally.
 */
function runPendingMigrations(db: Database): void {
  try {
    const { MigrationRunner } = require("../migrations/runner") as typeof import("../migrations/runner");
    const { ALL_MIGRATIONS } = require("../migrations/registry") as typeof import("../migrations/registry");
    const runner = new MigrationRunner(db, ALL_MIGRATIONS);
    // Fire and forget — migrations are fast and synchronous in practice
    runner.run().then((report) => {
      if (report.applied.length > 0) {
        log.info("db", `Applied ${report.applied.length} migration(s): ${report.applied.map((m) => m.version).join(", ")}`);
      }
      if (report.failed) {
        log.error("db", `Migration ${report.failed.version} failed: ${report.failed.error}`);
      }
    }).catch((err) => {
      log.error("db", `Migration runner failed: ${err}`);
    });
  } catch (err) {
    log.error("db", `Failed to load migration system: ${err}`);
  }
}
