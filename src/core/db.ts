// KCode - Shared SQLite Database Module
// Single connection to awareness.db shared across narrative, user-model, world-model, and learn

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "./logger";

const KCODE_HOME = join(homedir(), ".kcode");
const DB_PATH = join(KCODE_HOME, "awareness.db");

let _db: Database | null = null;

/**
 * Get the shared Database instance for awareness.db.
 * Creates and initializes the connection on first call.
 */
export function getDb(): Database {
  if (_db) return _db;

  mkdirSync(KCODE_HOME, { recursive: true });
  _db = new Database(DB_PATH);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA busy_timeout=5000");

  initSchema(_db);

  log.info("db", "Opened shared awareness.db connection");
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
}
