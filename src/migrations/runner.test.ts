// KCode - Migration Runner Tests

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { MigrationRunner } from "./runner";
import type { Migration, MigrationContext, MigrationLogger } from "./types";
import { migration as m001 } from "./migrations/001_add_schema_version";
import { migration as m002, MODEL_RENAMES } from "./migrations/002_migrate_model_names";
import { migration as m003 } from "./migrations/003_add_compaction_config";
import { migration as m004 } from "./migrations/004_migrate_legacy_memory";
import { ALL_MIGRATIONS } from "./registry";

// ─── Test Helpers ──────────────────────────────────────────────

function makeTestLogger(): MigrationLogger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    info: (msg: string) => messages.push(`INFO: ${msg}`),
    warn: (msg: string) => messages.push(`WARN: ${msg}`),
    error: (msg: string) => messages.push(`ERROR: ${msg}`),
    debug: (msg: string) => messages.push(`DEBUG: ${msg}`),
  };
}

function makeTestSettings(
  data: Record<string, unknown> = {},
): MigrationContext["settings"] & { data: Record<string, unknown> } {
  return {
    data,
    getUserSettings: () => ({ ...data }),
    setUserSettings: (s: Record<string, unknown>) => {
      Object.keys(data).forEach((k) => delete data[k]);
      Object.assign(data, s);
    },
    getProjectSettings: () => ({}),
    setProjectSettings: () => {},
  };
}

function createRunner(
  db: Database,
  migrations: Migration[],
  settingsData?: Record<string, unknown>,
) {
  const logger = makeTestLogger();
  const settings = makeTestSettings(settingsData);
  const runner = new MigrationRunner(db, migrations, { logger, settings });
  return { runner, logger, settings };
}

// ─── Runner Core ───────────────────────────────────────────────

describe("MigrationRunner", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode=WAL");
  });

  // ── Execution Order ──

  test("executes pending migrations in version order", async () => {
    const order: string[] = [];
    const migrations: Migration[] = [
      {
        version: "002",
        name: "second",
        type: "data",
        up: async () => {
          order.push("002");
        },
      },
      {
        version: "001",
        name: "first",
        type: "data",
        up: async () => {
          order.push("001");
        },
      },
      {
        version: "003",
        name: "third",
        type: "data",
        up: async () => {
          order.push("003");
        },
      },
    ];

    const { runner } = createRunner(db, migrations);
    const report = await runner.run();

    expect(order).toEqual(["001", "002", "003"]);
    expect(report.applied).toHaveLength(3);
    expect(report.applied[0]!.version).toBe("001");
    expect(report.applied[1]!.version).toBe("002");
    expect(report.applied[2]!.version).toBe("003");
    expect(report.failed).toBeNull();
  });

  // ── Skip Applied ──

  test("skips already applied migrations", async () => {
    const calls: string[] = [];
    const migrations: Migration[] = [
      {
        version: "001",
        name: "first",
        type: "data",
        up: async () => {
          calls.push("001");
        },
      },
      {
        version: "002",
        name: "second",
        type: "data",
        up: async () => {
          calls.push("002");
        },
      },
    ];

    const { runner } = createRunner(db, migrations);

    // Run once
    await runner.run();
    expect(calls).toEqual(["001", "002"]);

    // Run again — should skip both
    calls.length = 0;
    const report = await runner.run();
    expect(calls).toEqual([]);
    expect(report.applied).toHaveLength(0);
    expect(report.failed).toBeNull();
  });

  // ── Stop on Failure ──

  test("stops at first failed migration", async () => {
    const calls: string[] = [];
    const migrations: Migration[] = [
      {
        version: "001",
        name: "ok",
        type: "data",
        up: async () => {
          calls.push("001");
        },
      },
      {
        version: "002",
        name: "fail",
        type: "data",
        up: async () => {
          throw new Error("boom");
        },
      },
      {
        version: "003",
        name: "skipped",
        type: "data",
        up: async () => {
          calls.push("003");
        },
      },
    ];

    const { runner } = createRunner(db, migrations);
    const report = await runner.run();

    expect(calls).toEqual(["001"]);
    expect(report.applied).toHaveLength(1);
    expect(report.failed).not.toBeNull();
    expect(report.failed!.version).toBe("002");
    expect(report.failed!.error).toBe("boom");
  });

  // ── SQL Rollback on Error ──

  test("rolls back SQL migration on error", async () => {
    const migrations: Migration[] = [
      {
        version: "001",
        name: "create_test",
        type: "sql",
        up: async ({ db: d }) => {
          d.exec("CREATE TABLE test_rollback (id INTEGER PRIMARY KEY)");
          throw new Error("intentional failure");
        },
      },
    ];

    const { runner } = createRunner(db, migrations);
    const report = await runner.run();

    expect(report.failed).not.toBeNull();
    // Table should not exist because transaction was rolled back
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='test_rollback'",
      )
      .get();
    expect(table).toBeFalsy();
  });

  // ── Checksum ──

  test("checksum detects changes in migration code", () => {
    const m1: Migration = {
      version: "001",
      name: "test",
      type: "data",
      up: async (ctx) => {
        ctx.log.info("version-one");
      },
    };
    const m2: Migration = {
      version: "001",
      name: "test",
      type: "data",
      up: async (ctx) => {
        ctx.log.info("version-two");
      },
    };

    const { runner } = createRunner(db, [m1]);
    const c1 = runner.checksum(m1);
    const c2 = runner.checksum(m2);

    expect(c1).toBeString();
    expect(c1.length).toBe(64); // SHA-256 hex length
    expect(c1).not.toBe(c2);
  });

  // ── Checksum Mismatch Detection ──

  test("detectChecksumMismatches finds modified migrations", async () => {
    const originalUp = async (ctx: MigrationContext) => {
      ctx.log.info("original-code-path");
    };
    const migrations: Migration[] = [
      { version: "001", name: "test", type: "data", up: originalUp },
    ];

    const { runner } = createRunner(db, migrations);
    await runner.run();

    // Now create runner with modified migration
    const modifiedUp = async (ctx: MigrationContext) => {
      ctx.log.info("modified-code-path");
    };
    const modifiedMigrations: Migration[] = [
      { version: "001", name: "test", type: "data", up: modifiedUp },
    ];

    const { runner: runner2 } = createRunner(db, modifiedMigrations);
    const mismatches = runner2.detectChecksumMismatches();

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.version).toBe("001");
  });

  // ── Rollback ──

  test("rollback reverts an applied migration", async () => {
    const migrations: Migration[] = [
      {
        version: "001",
        name: "create_table",
        type: "sql",
        up: async ({ db: d }) => {
          d.exec(
            "CREATE TABLE IF NOT EXISTS rollback_test (id INTEGER PRIMARY KEY)",
          );
        },
        down: async ({ db: d }) => {
          d.exec("DROP TABLE IF EXISTS rollback_test");
        },
      },
    ];

    const { runner } = createRunner(db, migrations);
    await runner.run();

    // Table should exist
    let table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='rollback_test'",
      )
      .get();
    expect(table).toBeTruthy();

    // Rollback
    const success = await runner.rollback("001");
    expect(success).toBe(true);

    // Table should be gone
    table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='rollback_test'",
      )
      .get();
    expect(table).toBeFalsy();

    // Migration should be marked as rolled_back
    const applied = runner.getAppliedVersions();
    expect(applied.has("001")).toBe(false);
  });

  test("rollback returns false for migration without down()", async () => {
    const migrations: Migration[] = [
      {
        version: "001",
        name: "no_down",
        type: "data",
        up: async () => {},
      },
    ];

    const { runner } = createRunner(db, migrations);
    await runner.run();

    const success = await runner.rollback("001");
    expect(success).toBe(false);
  });

  test("rollback returns false for unapplied migration", async () => {
    const migrations: Migration[] = [
      {
        version: "001",
        name: "not_run",
        type: "data",
        up: async () => {},
        down: async () => {},
      },
    ];

    const { runner } = createRunner(db, migrations);
    const success = await runner.rollback("001");
    expect(success).toBe(false);
  });

  // ── Status ──

  test("getStatus returns correct counts", async () => {
    const migrations: Migration[] = [
      {
        version: "001",
        name: "first",
        type: "data",
        up: async () => {},
      },
      {
        version: "002",
        name: "second",
        type: "data",
        up: async () => {},
      },
      {
        version: "003",
        name: "third",
        type: "data",
        up: async () => {},
      },
    ];

    const { runner } = createRunner(db, migrations);

    // Before running
    let status = runner.getStatus();
    expect(status.total).toBe(3);
    expect(status.applied).toBe(0);
    expect(status.pending).toBe(3);

    // Run first two (by running all with third failing)
    await runner.run();
    status = runner.getStatus();
    expect(status.total).toBe(3);
    expect(status.applied).toBe(3);
    expect(status.pending).toBe(0);
    expect(status.lastApplied).not.toBeNull();
    expect(status.lastApplied!.version).toBe("003");
  });

  // ── Report includes duration ──

  test("report includes duration for each applied migration", async () => {
    const migrations: Migration[] = [
      {
        version: "001",
        name: "quick",
        type: "data",
        up: async () => {},
      },
    ];

    const { runner } = createRunner(db, migrations);
    const report = await runner.run();

    expect(report.applied).toHaveLength(1);
    expect(report.applied[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.applied[0]!.name).toBe("quick");
  });
});

// ─── Migration 001: add_schema_version ─────────────────────────

describe("Migration 001: add_schema_version", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode=WAL");
  });

  test("creates schema_migrations table", async () => {
    const { runner } = createRunner(db, [m001]);
    await runner.run();

    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
      )
      .get();
    expect(table).toBeTruthy();
  });

  test("schema_migrations has correct columns", async () => {
    const { runner } = createRunner(db, [m001]);
    await runner.run();

    const cols = db.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{
      name: string;
    }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("version");
    expect(colNames).toContain("name");
    expect(colNames).toContain("applied_at");
    expect(colNames).toContain("checksum");
    expect(colNames).toContain("duration_ms");
    expect(colNames).toContain("status");
  });
});

// ─── Migration 002: migrate_model_names ────────────────────────

describe("Migration 002: migrate_model_names", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode=WAL");
  });

  test("renames legacy model names in settings", async () => {
    const settingsData: Record<string, unknown> = {
      defaultModel: "claude-3-opus",
      compactionModel: "gpt-4-turbo",
    };

    const { runner, settings } = createRunner(db, [m001, m002], settingsData);
    await runner.run();

    expect(settings.data.defaultModel).toBe("claude-opus-4");
    expect(settings.data.compactionModel).toBe("gpt-4o");
  });

  test("renames models in modelRouter", async () => {
    const settingsData: Record<string, unknown> = {
      modelRouter: {
        code: "claude-3-sonnet",
        chat: "claude-3-haiku",
        analysis: "some-other-model",
      },
    };

    const { runner, settings } = createRunner(db, [m001, m002], settingsData);
    await runner.run();

    const router = settings.data.modelRouter as Record<string, string>;
    expect(router.code).toBe("claude-sonnet-4");
    expect(router.chat).toBe("claude-haiku-4");
    expect(router.analysis).toBe("some-other-model"); // untouched
  });

  test("does not touch models not in rename list", async () => {
    const settingsData: Record<string, unknown> = {
      defaultModel: "my-local-model",
    };

    const { runner, settings } = createRunner(db, [m001, m002], settingsData);
    await runner.run();

    expect(settings.data.defaultModel).toBe("my-local-model");
  });

  test("handles empty settings gracefully", async () => {
    const { runner, settings } = createRunner(db, [m001, m002], {});
    const report = await runner.run();

    expect(report.failed).toBeNull();
    // Settings should remain empty (no unnecessary writes)
    expect(Object.keys(settings.data)).toHaveLength(0);
  });
});

// ─── Migration 003: add_compaction_config ──────────────────────

describe("Migration 003: add_compaction_config", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode=WAL");
  });

  test("adds compaction config when not present", async () => {
    const settingsData: Record<string, unknown> = {};

    const { runner, settings } = createRunner(
      db,
      [m001, m002, m003],
      settingsData,
    );
    await runner.run();

    const compaction = settings.data.compaction as Record<string, unknown>;
    expect(compaction).toBeTruthy();
    expect(compaction.microCompact).toEqual({ enabled: true });
    expect(compaction.fullCompact).toEqual({
      groupByRounds: true,
      fileRestoreBudget: 50000,
    });
    expect(compaction.circuitBreaker).toEqual({ maxFailures: 3 });
    expect(compaction.imageStripping).toEqual({ enabled: true });
  });

  test("does not overwrite existing compaction config", async () => {
    const customCompaction = {
      microCompact: { enabled: false },
      fullCompact: { groupByRounds: false, fileRestoreBudget: 100000 },
    };
    const settingsData: Record<string, unknown> = {
      compaction: customCompaction,
    };

    const { runner, settings } = createRunner(
      db,
      [m001, m002, m003],
      settingsData,
    );
    await runner.run();

    // Should keep the custom config
    expect(settings.data.compaction).toEqual(customCompaction);
  });
});

// ─── Migration 004: migrate_legacy_memory ──────────────────────

describe("Migration 004: migrate_legacy_memory", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode=WAL");
    // Create the memory_store table as it would exist in production
    db.exec(`CREATE TABLE memory_store (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL DEFAULT 'fact',
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      project TEXT DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0.8,
      source TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT DEFAULT NULL,
      approved INTEGER NOT NULL DEFAULT 0
    )`);
  });

  test("sets source='user' on memory entries with empty source", async () => {
    // Insert entries with empty source
    db.prepare(
      "INSERT INTO memory_store (key, content, source) VALUES (?, ?, ?)",
    ).run("test-key", "test content", "");
    db.prepare(
      "INSERT INTO memory_store (key, content, source) VALUES (?, ?, ?)",
    ).run("test-key-2", "test content 2", "");

    const { runner } = createRunner(db, [m001, m004]);
    await runner.run();

    const rows = db
      .prepare("SELECT source FROM memory_store")
      .all() as Array<{ source: string }>;
    for (const row of rows) {
      expect(row.source).toBe("user");
    }
  });

  test("does not touch memory entries that already have source set", async () => {
    db.prepare(
      "INSERT INTO memory_store (key, content, source) VALUES (?, ?, ?)",
    ).run("auto-key", "auto content", "auto");
    db.prepare(
      "INSERT INTO memory_store (key, content, source) VALUES (?, ?, ?)",
    ).run("promoted-key", "promoted content", "promoted");

    const { runner } = createRunner(db, [m001, m004]);
    await runner.run();

    const autoRow = db
      .prepare("SELECT source FROM memory_store WHERE key = ?")
      .get("auto-key") as { source: string };
    const promotedRow = db
      .prepare("SELECT source FROM memory_store WHERE key = ?")
      .get("promoted-key") as { source: string };

    expect(autoRow.source).toBe("auto");
    expect(promotedRow.source).toBe("promoted");
  });

  test("handles missing memory_store table gracefully", async () => {
    // Use a fresh DB without the memory_store table
    const freshDb = new Database(":memory:");
    freshDb.exec("PRAGMA journal_mode=WAL");

    const { runner } = createRunner(freshDb, [m001, m004]);
    const report = await runner.run();

    // Should not fail
    expect(report.failed).toBeNull();
    expect(report.applied).toHaveLength(2);
  });
});

// ─── Registry ──────────────────────────────────────────────────

describe("Migration Registry", () => {
  test("ALL_MIGRATIONS contains 4 migrations in order", () => {
    expect(ALL_MIGRATIONS).toHaveLength(4);
    expect(ALL_MIGRATIONS[0]!.version).toBe("001");
    expect(ALL_MIGRATIONS[1]!.version).toBe("002");
    expect(ALL_MIGRATIONS[2]!.version).toBe("003");
    expect(ALL_MIGRATIONS[3]!.version).toBe("004");
  });

  test("all migrations have unique versions", () => {
    const versions = ALL_MIGRATIONS.map((m) => m.version);
    const unique = new Set(versions);
    expect(unique.size).toBe(versions.length);
  });

  test("all migrations have required fields", () => {
    for (const m of ALL_MIGRATIONS) {
      expect(m.version).toBeString();
      expect(m.name).toBeString();
      expect(["sql", "config", "data"]).toContain(m.type);
      expect(typeof m.up).toBe("function");
    }
  });

  test("full run with all migrations on fresh DB succeeds", async () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA journal_mode=WAL");
    // Create memory_store so m004 has something to check
    db.exec(`CREATE TABLE memory_store (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL DEFAULT 'fact',
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      project TEXT DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0.8,
      source TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT DEFAULT NULL,
      approved INTEGER NOT NULL DEFAULT 0
    )`);

    const { runner } = createRunner(db, ALL_MIGRATIONS);
    const report = await runner.run();

    expect(report.failed).toBeNull();
    expect(report.applied).toHaveLength(4);

    // Subsequent run should be a no-op
    const report2 = await runner.run();
    expect(report2.applied).toHaveLength(0);
    expect(report2.failed).toBeNull();
  });
});
