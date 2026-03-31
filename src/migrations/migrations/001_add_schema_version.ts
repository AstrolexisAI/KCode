// Migration 001: Bootstrap — Create schema_migrations table
// This is the foundational migration that creates the tracking table itself.
// Note: The runner already creates this table via ensureMigrationsTable(),
// but this migration exists so the version is recorded in the tracking table.

import type { Migration } from "../types";

export const migration: Migration = {
  version: "001",
  name: "add_schema_version",
  type: "sql",
  up: async ({ db }) => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      checksum TEXT NOT NULL,
      duration_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'applied'
    )`);
  },
  down: async ({ db }) => {
    db.exec("DROP TABLE IF EXISTS schema_migrations");
  },
};
