// KCode - Migration System Types
// Interfaces for the versioned migration system

import type { Database } from "bun:sqlite";

/** Logger interface for migration context */
export interface MigrationLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

/** Context provided to each migration's up/down function */
export interface MigrationContext {
  /** SQLite database connection */
  db: Database;
  /** Read/write user and project settings */
  settings: {
    getUserSettings(): Record<string, unknown>;
    setUserSettings(settings: Record<string, unknown>): void;
    getProjectSettings(dir: string): Record<string, unknown>;
    setProjectSettings(dir: string, settings: Record<string, unknown>): void;
  };
  /** Logger */
  log: MigrationLogger;
  /** Current KCode version */
  kcodeVersion: string;
  /** Operating system platform */
  platform: "linux" | "darwin" | "win32";
}

/** A single migration definition */
export interface Migration {
  /** Unique sortable version: "001", "002", etc. */
  version: string;
  /** Descriptive name */
  name: string;
  /** Type: 'sql' for schema changes, 'config' for settings, 'data' for data transforms */
  type: "sql" | "config" | "data";
  /** Function that applies the migration */
  up: (context: MigrationContext) => Promise<void>;
  /** Function that reverts (optional, best-effort) */
  down?: (context: MigrationContext) => Promise<void>;
}

/** Result of a single applied migration */
export interface MigrationApplied {
  version: string;
  name: string;
  durationMs: number;
}

/** Report returned after running migrations */
export interface MigrationReport {
  applied: MigrationApplied[];
  failed: { version: string; name: string; error: string } | null;
}

/** Row from the schema_migrations table */
export interface MigrationRow {
  id: number;
  version: string;
  name: string;
  applied_at: string;
  checksum: string;
  duration_ms: number | null;
  status: "applied" | "failed" | "rolled_back";
}
