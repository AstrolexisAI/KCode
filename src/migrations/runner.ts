// KCode - Migration Runner
// Executes versioned migrations in order, tracks state in schema_migrations table

import type { Database } from "bun:sqlite";
import type {
  Migration,
  MigrationContext,
  MigrationLogger,
  MigrationReport,
  MigrationRow,
} from "./types";

// ─── Default Logger ────────────────────────────────────────────

function makeDefaultLogger(): MigrationLogger {
  try {
    const { log } = require("../core/logger") as typeof import("../core/logger");
    return {
      info: (msg: string) => log.info("migrations", msg),
      warn: (msg: string) => log.warn("migrations", msg),
      error: (msg: string) => log.error("migrations", msg),
      debug: (msg: string) => log.debug("migrations", msg),
    };
  } catch {
    // Fallback for tests or when logger is not available
    return {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
  }
}

// ─── Settings Adapter ──────────────────────────────────────────

function makeSettingsAdapter(): MigrationContext["settings"] {
  // Lazy-load to avoid circular dependencies and allow testing with mocks
  return {
    getUserSettings(): Record<string, unknown> {
      try {
        const { readFileSync } = require("node:fs") as typeof import("node:fs");
        const { join } = require("node:path") as typeof import("node:path");
        const { kcodeHome } = require("../core/paths") as typeof import("../core/paths");
        const path = join(kcodeHome(), "settings.json");
        const data = readFileSync(path, "utf-8");
        return JSON.parse(data);
      } catch {
        return {};
      }
    },
    setUserSettings(settings: Record<string, unknown>): void {
      try {
        const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
        const { join, dirname } = require("node:path") as typeof import("node:path");
        const { kcodeHome } = require("../core/paths") as typeof import("../core/paths");
        const path = join(kcodeHome(), "settings.json");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
      } catch {
        // Silently fail — caller should handle
      }
    },
    getProjectSettings(dir: string): Record<string, unknown> {
      try {
        const { readFileSync } = require("node:fs") as typeof import("node:fs");
        const { join } = require("node:path") as typeof import("node:path");
        const path = join(dir, ".kcode", "settings.json");
        const data = readFileSync(path, "utf-8");
        return JSON.parse(data);
      } catch {
        return {};
      }
    },
    setProjectSettings(dir: string, settings: Record<string, unknown>): void {
      try {
        const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
        const { join } = require("node:path") as typeof import("node:path");
        const settingsDir = join(dir, ".kcode");
        mkdirSync(settingsDir, { recursive: true });
        writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
      } catch {
        // Silently fail
      }
    },
  };
}

// ─── MigrationRunner ───────────────────────────────────────────

export class MigrationRunner {
  private logger: MigrationLogger;
  private settingsAdapter: MigrationContext["settings"];

  constructor(
    private db: Database,
    private migrations: Migration[],
    options?: {
      logger?: MigrationLogger;
      settings?: MigrationContext["settings"];
    },
  ) {
    this.logger = options?.logger ?? makeDefaultLogger();
    this.settingsAdapter = options?.settings ?? makeSettingsAdapter();
  }

  /** Execute all pending migrations in version order */
  async run(): Promise<MigrationReport> {
    // Ensure schema_migrations table exists (bootstrap)
    this.ensureMigrationsTable();

    const applied = this.getAppliedVersions();
    const pending = this.migrations
      .filter((m) => !applied.has(m.version))
      .sort((a, b) => a.version.localeCompare(b.version));

    const report: MigrationReport = { applied: [], failed: null };

    for (const migration of pending) {
      const start = Date.now();
      try {
        // SQL migrations run inside a transaction
        if (migration.type === "sql") {
          this.db.exec("BEGIN");
        }

        await migration.up(this.buildContext());

        if (migration.type === "sql") {
          this.db.exec("COMMIT");
        }

        const durationMs = Date.now() - start;
        this.recordApplied(migration, durationMs);
        report.applied.push({
          version: migration.version,
          name: migration.name,
          durationMs,
        });
        this.logger.info(
          `Applied migration ${migration.version}_${migration.name} (${durationMs}ms)`,
        );
      } catch (error: unknown) {
        if (migration.type === "sql") {
          try {
            this.db.exec("ROLLBACK");
          } catch {
            // ROLLBACK can fail if no transaction is active
          }
        }

        const durationMs = Date.now() - start;
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.recordFailed(migration, durationMs);
        report.failed = {
          version: migration.version,
          name: migration.name,
          error: errorMsg,
        };
        this.logger.error(`Migration ${migration.version}_${migration.name} failed: ${errorMsg}`);
        // Stop — do not execute subsequent migrations
        break;
      }
    }

    return report;
  }

  /** Rollback a specific migration version */
  async rollback(version: string): Promise<boolean> {
    const migration = this.migrations.find((m) => m.version === version);
    if (!migration) {
      this.logger.error(`Migration ${version} not found in registry`);
      return false;
    }
    if (!migration.down) {
      this.logger.error(`Migration ${version} has no down() function`);
      return false;
    }

    const applied = this.getAppliedVersions();
    if (!applied.has(version)) {
      this.logger.warn(`Migration ${version} is not applied — nothing to rollback`);
      return false;
    }

    try {
      if (migration.type === "sql") {
        this.db.exec("BEGIN");
      }

      await migration.down(this.buildContext());

      if (migration.type === "sql") {
        this.db.exec("COMMIT");
      }

      // Mark as rolled back
      this.db
        .prepare("UPDATE schema_migrations SET status = 'rolled_back' WHERE version = ?")
        .run(version);

      this.logger.info(`Rolled back migration ${version}_${migration.name}`);
      return true;
    } catch (error: unknown) {
      if (migration.type === "sql") {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Ignore
        }
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Rollback of ${version} failed: ${errorMsg}`);
      return false;
    }
  }

  /** Get all applied migration versions */
  getAppliedVersions(): Set<string> {
    try {
      const rows = this.db
        .prepare("SELECT version FROM schema_migrations WHERE status = 'applied'")
        .all() as Array<{ version: string }>;
      return new Set(rows.map((r) => r.version));
    } catch {
      // Table does not exist yet (first run)
      return new Set();
    }
  }

  /** Get full migration status for doctor/diagnostics */
  getStatus(): {
    total: number;
    applied: number;
    pending: number;
    failed: MigrationRow[];
    lastApplied: MigrationRow | null;
  } {
    const appliedVersions = this.getAppliedVersions();
    const pending = this.migrations.filter((m) => !appliedVersions.has(m.version));

    let failedRows: MigrationRow[] = [];
    let lastApplied: MigrationRow | null = null;

    try {
      failedRows = this.db
        .prepare("SELECT * FROM schema_migrations WHERE status = 'failed' ORDER BY version")
        .all() as MigrationRow[];

      const lastRow = this.db
        .prepare(
          "SELECT * FROM schema_migrations WHERE status = 'applied' ORDER BY version DESC LIMIT 1",
        )
        .get() as MigrationRow | null;
      lastApplied = lastRow ?? null;
    } catch {
      // Table may not exist
    }

    return {
      total: this.migrations.length,
      applied: appliedVersions.size,
      pending: pending.length,
      failed: failedRows,
      lastApplied,
    };
  }

  /** Compute SHA-256 checksum of a migration's up function */
  checksum(migration: Migration): string {
    const hash = new Bun.CryptoHasher("sha256");
    hash.update(migration.up.toString());
    return hash.digest("hex") as string;
  }

  /** Detect if any applied migration has a checksum mismatch */
  detectChecksumMismatches(): Array<{
    version: string;
    expected: string;
    actual: string;
  }> {
    const mismatches: Array<{
      version: string;
      expected: string;
      actual: string;
    }> = [];

    try {
      const rows = this.db
        .prepare("SELECT version, checksum FROM schema_migrations WHERE status = 'applied'")
        .all() as Array<{ version: string; checksum: string }>;

      for (const row of rows) {
        const migration = this.migrations.find((m) => m.version === row.version);
        if (migration) {
          const currentChecksum = this.checksum(migration);
          if (currentChecksum !== row.checksum) {
            mismatches.push({
              version: row.version,
              expected: row.checksum,
              actual: currentChecksum,
            });
          }
        }
      }
    } catch {
      // Table may not exist
    }

    return mismatches;
  }

  // ─── Private Helpers ───────────────────────────────────────────

  private ensureMigrationsTable(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      checksum TEXT NOT NULL,
      duration_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'applied'
    )`);
  }

  private buildContext(): MigrationContext {
    return {
      db: this.db,
      settings: this.settingsAdapter,
      log: this.logger,
      kcodeVersion: process.env.KCODE_VERSION ?? "0.0.0",
      platform: process.platform as "linux" | "darwin" | "win32",
    };
  }

  private recordApplied(migration: Migration, durationMs: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO schema_migrations (version, name, checksum, duration_ms, status) VALUES (?, ?, ?, ?, 'applied')",
      )
      .run(migration.version, migration.name, this.checksum(migration), durationMs);
  }

  private recordFailed(migration: Migration, durationMs: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO schema_migrations (version, name, checksum, duration_ms, status) VALUES (?, ?, ?, ?, 'failed')",
      )
      .run(migration.version, migration.name, this.checksum(migration), durationMs);
  }
}
