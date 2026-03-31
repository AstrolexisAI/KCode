// KCode - Enhanced Memory Store
// SQLite-backed structured memory with categories, confidence, expiry, and FTS search

import type { Database } from "bun:sqlite";
import { getDb } from "./db";

// ─── Types ──────────────────────────────────────────────────────

export type MemoryCategory = "preference" | "convention" | "fact" | "decision" | "learned";
export type MemorySource = "auto" | "user" | "promoted" | "auto-extract";

// Internal row types for typed SQLite queries
interface DbCountRow { cnt: number }
interface DbCategoryRow { category: string; cnt: number }
interface DbSourceRow { source: string; cnt: number }

export interface MemoryEntry {
  id: number;
  category: MemoryCategory;
  key: string;
  content: string;
  project?: string;
  confidence: number;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  approved: boolean;
}

export interface MemoryStats {
  total: number;
  byCategory: Record<string, number>;
  bySource: Record<string, number>;
  expiringSoon: number;
}

// ─── Schema ─────────────────────────────────────────────────────

export function initMemoryStoreSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_store (
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

  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_store_project ON memory_store(project)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_store_category ON memory_store(category)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_store_approved ON memory_store(approved)`);

  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_store_fts USING fts5(
    key, content, category, content='memory_store', content_rowid='id'
  )`);

  db.exec(`CREATE TRIGGER IF NOT EXISTS memory_store_ai AFTER INSERT ON memory_store BEGIN
    INSERT INTO memory_store_fts(rowid, key, content, category) VALUES (new.id, new.key, new.content, new.category);
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS memory_store_ad AFTER DELETE ON memory_store BEGIN
    INSERT INTO memory_store_fts(memory_store_fts, rowid, key, content, category) VALUES ('delete', old.id, old.key, old.content, old.category);
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS memory_store_au AFTER UPDATE ON memory_store BEGIN
    INSERT INTO memory_store_fts(memory_store_fts, rowid, key, content, category) VALUES ('delete', old.id, old.key, old.content, old.category);
    INSERT INTO memory_store_fts(rowid, key, content, category) VALUES (new.id, new.key, new.content, new.category);
  END`);
}

// ─── Helper ─────────────────────────────────────────────────────

function rowToEntry(row: any): MemoryEntry {
  return {
    id: row.id,
    category: row.category as MemoryCategory,
    key: row.key,
    content: row.content,
    project: row.project || undefined,
    confidence: row.confidence,
    source: row.source as MemorySource,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at || undefined,
    approved: row.approved === 1,
  };
}

function resolveDb(injected?: Database): Database {
  return injected ?? getDb();
}

// ─── CRUD ───────────────────────────────────────────────────────

export function addMemory(
  entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">,
  db?: Database,
): number {
  const d = resolveDb(db);
  const stmt = d.prepare(`INSERT INTO memory_store (category, key, content, project, confidence, source, expires_at, approved)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const result = stmt.run(
    entry.category,
    entry.key,
    entry.content,
    entry.project ?? "",
    entry.confidence,
    entry.source,
    entry.expiresAt ?? null,
    entry.approved ? 1 : 0,
  );
  return Number(result.lastInsertRowid);
}

export function updateMemory(
  id: number,
  updates: Partial<Pick<MemoryEntry, "category" | "key" | "content" | "confidence" | "source" | "expiresAt" | "approved" | "project">>,
  db?: Database,
): boolean {
  const d = resolveDb(db);
  const sets: string[] = [];
  const values: any[] = [];

  if (updates.category !== undefined) { sets.push("category = ?"); values.push(updates.category); }
  if (updates.key !== undefined) { sets.push("key = ?"); values.push(updates.key); }
  if (updates.content !== undefined) { sets.push("content = ?"); values.push(updates.content); }
  if (updates.confidence !== undefined) { sets.push("confidence = ?"); values.push(updates.confidence); }
  if (updates.source !== undefined) { sets.push("source = ?"); values.push(updates.source); }
  if (updates.expiresAt !== undefined) { sets.push("expires_at = ?"); values.push(updates.expiresAt); }
  if (updates.approved !== undefined) { sets.push("approved = ?"); values.push(updates.approved ? 1 : 0); }
  if (updates.project !== undefined) { sets.push("project = ?"); values.push(updates.project); }

  if (sets.length === 0) return false;

  sets.push("updated_at = datetime('now')");
  values.push(id);

  const exists = d.prepare("SELECT 1 FROM memory_store WHERE id = ?").get(id);
  if (!exists) return false;
  d.prepare(`UPDATE memory_store SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return true;
}

export function deleteMemory(id: number, db?: Database): boolean {
  const d = resolveDb(db);
  const exists = d.prepare("SELECT 1 FROM memory_store WHERE id = ?").get(id);
  if (!exists) return false;
  d.prepare("DELETE FROM memory_store WHERE id = ?").run(id);
  return true;
}

// ─── Queries ────────────────────────────────────────────────────

export function getMemories(
  opts?: { project?: string; category?: string; approved?: boolean; limit?: number },
  db?: Database,
): MemoryEntry[] {
  const d = resolveDb(db);
  const wheres: string[] = [];
  const values: any[] = [];

  if (opts?.project !== undefined) {
    wheres.push("project = ?");
    values.push(opts.project);
  }
  if (opts?.category !== undefined) {
    wheres.push("category = ?");
    values.push(opts.category);
  }
  if (opts?.approved !== undefined) {
    wheres.push("approved = ?");
    values.push(opts.approved ? 1 : 0);
  }

  let sql = "SELECT * FROM memory_store";
  if (wheres.length > 0) sql += " WHERE " + wheres.join(" AND ");
  sql += " ORDER BY updated_at DESC";
  if (opts?.limit) {
    sql += " LIMIT ?";
    values.push(opts.limit);
  }

  const rows = d.prepare(sql).all(...values);
  return rows.map(rowToEntry);
}

export function searchMemories(query: string, db?: Database): MemoryEntry[] {
  const d = resolveDb(db);
  // Use FTS5 match with a join back to get full row data
  const rows = d.prepare(`
    SELECT m.* FROM memory_store m
    JOIN memory_store_fts f ON m.id = f.rowid
    WHERE memory_store_fts MATCH ?
    ORDER BY rank
    LIMIT 50
  `).all(query);
  return rows.map(rowToEntry);
}

// ─── Promote / Expire ───────────────────────────────────────────

export function promoteMemory(id: number, db?: Database): boolean {
  return updateMemory(id, { approved: true, source: "promoted" }, db);
}

export function expireStaleMemories(db?: Database): number {
  const d = resolveDb(db);
  // Count first since DELETE triggers (FTS sync) inflate result.changes
  const count = (d.prepare(
    "SELECT COUNT(*) as cnt FROM memory_store WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
  ).get() as DbCountRow | undefined)?.cnt ?? 0;
  if (count > 0) {
    d.prepare(
      "DELETE FROM memory_store WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
    ).run();
  }
  return count;
}

// ─── Stats ──────────────────────────────────────────────────────

export function getMemoryStats(db?: Database): MemoryStats {
  const d = resolveDb(db);

  const total = (d.prepare("SELECT COUNT(*) as cnt FROM memory_store").get() as DbCountRow | undefined)?.cnt ?? 0;

  const catRows = d.prepare("SELECT category, COUNT(*) as cnt FROM memory_store GROUP BY category").all() as DbCategoryRow[];
  const byCategory: Record<string, number> = {};
  for (const r of catRows) byCategory[r.category] = r.cnt;

  const srcRows = d.prepare("SELECT source, COUNT(*) as cnt FROM memory_store GROUP BY source").all() as DbSourceRow[];
  const bySource: Record<string, number> = {};
  for (const r of srcRows) bySource[r.source] = r.cnt;

  const expiring = (d.prepare(
    "SELECT COUNT(*) as cnt FROM memory_store WHERE expires_at IS NOT NULL AND expires_at < datetime('now', '+7 days')"
  ).get() as DbCountRow | undefined)?.cnt ?? 0;

  return { total, byCategory, bySource, expiringSoon: expiring };
}
