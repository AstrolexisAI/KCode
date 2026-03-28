// KCode - MCP Tool Aliases
// Short names for MCP tools, stored in awareness.db for persistence.

import { getDb } from "./db";
import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export interface ToolAlias {
  alias: string;
  target: string;       // full MCP tool name (e.g. mcp__server__toolname)
  description?: string;
}

// ─── Schema ─────────────────────────────────────────────────────

let schemaInitialized = false;

function ensureSchema(): void {
  if (schemaInitialized) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_tool_aliases (
      alias TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      description TEXT
    )
  `);
  schemaInitialized = true;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Add or update a tool alias.
 */
export function addAlias(alias: string, target: string, description?: string): void {
  ensureSchema();
  const db = getDb();
  db.run(
    `INSERT OR REPLACE INTO mcp_tool_aliases (alias, target, description) VALUES (?, ?, ?)`,
    [alias, target, description ?? null],
  );
  log.info("mcp-aliases", `Added alias "${alias}" -> "${target}"`);
}

/**
 * Remove a tool alias.
 */
export function removeAlias(alias: string): boolean {
  ensureSchema();
  const db = getDb();
  const result = db.run(`DELETE FROM mcp_tool_aliases WHERE alias = ?`, [alias]);
  const removed = result.changes > 0;
  if (removed) {
    log.info("mcp-aliases", `Removed alias "${alias}"`);
  }
  return removed;
}

/**
 * Resolve an alias to its target tool name.
 * If the name is not an alias, returns the original name unchanged.
 */
export function resolveAlias(name: string): string {
  ensureSchema();
  const db = getDb();
  const row = db.query(`SELECT target FROM mcp_tool_aliases WHERE alias = ?`).get(name) as { target: string } | null;
  return row ? row.target : name;
}

/**
 * List all registered tool aliases.
 */
export function listAliases(): ToolAlias[] {
  ensureSchema();
  const db = getDb();
  return db.query(`SELECT alias, target, description FROM mcp_tool_aliases ORDER BY alias`).all() as ToolAlias[];
}
