// Migration 004: Migrate legacy memory_store entries
// Sets source='user' on memory_store rows that have source='' or NULL.

import type { Migration } from "../types";

export const migration: Migration = {
  version: "004",
  name: "migrate_legacy_memory",
  type: "data",
  up: async ({ db, log }) => {
    // Check if memory_store table exists
    const tableExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_store'",
      )
      .get();

    if (!tableExists) {
      log.debug("memory_store table does not exist yet — skipping");
      return;
    }

    // Find memory entries with empty or NULL source
    const rows = db
      .prepare(
        "SELECT id FROM memory_store WHERE source IS NULL OR source = ''",
      )
      .all() as Array<{ id: number }>;

    if (rows.length > 0) {
      const stmt = db.prepare(
        "UPDATE memory_store SET source = 'user' WHERE id = ?",
      );
      for (const row of rows) {
        stmt.run(row.id);
      }
      log.info(
        `Migrated ${rows.length} legacy memory entries with source='user'`,
      );
    }
  },
};
