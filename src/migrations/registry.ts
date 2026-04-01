// KCode - Migration Registry
// Central list of all migrations, imported in order.

import { migration as m001 } from "./migrations/001_add_schema_version";
import { migration as m002 } from "./migrations/002_migrate_model_names";
import { migration as m003 } from "./migrations/003_add_compaction_config";
import { migration as m004 } from "./migrations/004_migrate_legacy_memory";
import type { Migration } from "./types";

/**
 * All registered migrations in version order.
 * To add a new migration:
 * 1. Create src/migrations/migrations/NNN_description.ts
 * 2. Import and add it to this array
 */
export const ALL_MIGRATIONS: Migration[] = [m001, m002, m003, m004];
