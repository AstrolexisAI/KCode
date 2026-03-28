import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initMemoryStoreSchema,
  addMemory,
  updateMemory,
  deleteMemory,
  getMemories,
  searchMemories,
  promoteMemory,
  expireStaleMemories,
  getMemoryStats,
  type MemoryEntry,
} from "./memory-store";

let db: Database;

describe("memory-store", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode=WAL");
    initMemoryStoreSchema(db);
  });
  // ── Schema ──

  test("initMemoryStoreSchema creates tables without error", () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_store'").get();
    expect(tables).toBeTruthy();
  });

  test("initMemoryStoreSchema creates FTS virtual table", () => {
    const fts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_store_fts'").get();
    expect(fts).toBeTruthy();
  });

  test("initMemoryStoreSchema is idempotent", () => {
    // Calling twice should not throw
    initMemoryStoreSchema(db);
    initMemoryStoreSchema(db);
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM memory_store").get() as any).cnt;
    expect(count).toBe(0);
  });

  // ── Add ──

  test("addMemory inserts and returns an ID", () => {
    const id = addMemory({
      category: "fact",
      key: "test-key",
      content: "This is a test fact.",
      confidence: 0.9,
      source: "user",
      approved: false,
    }, db);
    expect(id).toBeGreaterThan(0);
  });

  test("addMemory stores all fields correctly", () => {
    const id = addMemory({
      category: "preference",
      key: "editor-theme",
      content: "User prefers dark mode",
      project: "/home/user/proj",
      confidence: 0.95,
      source: "auto",
      expiresAt: "2030-01-01T00:00:00",
      approved: true,
    }, db);

    const row = db.prepare("SELECT * FROM memory_store WHERE id = ?").get(id) as any;
    expect(row.category).toBe("preference");
    expect(row.key).toBe("editor-theme");
    expect(row.content).toBe("User prefers dark mode");
    expect(row.project).toBe("/home/user/proj");
    expect(row.confidence).toBe(0.95);
    expect(row.source).toBe("auto");
    expect(row.expires_at).toBe("2030-01-01T00:00:00");
    expect(row.approved).toBe(1);
  });

  // ── Update ──

  test("updateMemory modifies content and returns true", () => {
    const id = addMemory({ category: "fact", key: "k", content: "old", confidence: 0.5, source: "user", approved: false }, db);
    const ok = updateMemory(id, { content: "new content", confidence: 0.8 }, db);
    expect(ok).toBe(true);

    const row = db.prepare("SELECT content, confidence FROM memory_store WHERE id = ?").get(id) as any;
    expect(row.content).toBe("new content");
    expect(row.confidence).toBe(0.8);
  });

  test("updateMemory returns false for non-existent ID", () => {
    const ok = updateMemory(9999, { content: "nope" }, db);
    expect(ok).toBe(false);
  });

  test("updateMemory with empty updates returns false", () => {
    const id = addMemory({ category: "fact", key: "k", content: "c", confidence: 0.5, source: "user", approved: false }, db);
    const ok = updateMemory(id, {}, db);
    expect(ok).toBe(false);
  });

  // ── Delete ──

  test("deleteMemory removes entry and returns true", () => {
    const id = addMemory({ category: "fact", key: "k", content: "c", confidence: 0.5, source: "user", approved: false }, db);
    expect(deleteMemory(id, db)).toBe(true);
    expect(deleteMemory(id, db)).toBe(false); // already gone
  });

  // ── Query / Filter ──

  test("getMemories returns all entries", () => {
    addMemory({ category: "fact", key: "a", content: "A", confidence: 0.5, source: "user", approved: false }, db);
    addMemory({ category: "preference", key: "b", content: "B", confidence: 0.8, source: "auto", approved: true }, db);

    const all = getMemories(undefined, db);
    expect(all.length).toBe(2);
  });

  test("getMemories filters by category", () => {
    addMemory({ category: "fact", key: "a", content: "A", confidence: 0.5, source: "user", approved: false }, db);
    addMemory({ category: "preference", key: "b", content: "B", confidence: 0.8, source: "auto", approved: true }, db);
    addMemory({ category: "fact", key: "c", content: "C", confidence: 0.6, source: "user", approved: false }, db);

    const facts = getMemories({ category: "fact" }, db);
    expect(facts.length).toBe(2);
    expect(facts.every((m) => m.category === "fact")).toBe(true);
  });

  test("getMemories filters by project", () => {
    addMemory({ category: "fact", key: "a", content: "A", project: "/proj1", confidence: 0.5, source: "user", approved: false }, db);
    addMemory({ category: "fact", key: "b", content: "B", project: "/proj2", confidence: 0.5, source: "user", approved: false }, db);

    const proj1 = getMemories({ project: "/proj1" }, db);
    expect(proj1.length).toBe(1);
    expect(proj1[0]!.key).toBe("a");
  });

  test("getMemories filters by approved", () => {
    addMemory({ category: "fact", key: "a", content: "A", confidence: 0.5, source: "user", approved: false }, db);
    addMemory({ category: "fact", key: "b", content: "B", confidence: 0.5, source: "user", approved: true }, db);

    const approved = getMemories({ approved: true }, db);
    expect(approved.length).toBe(1);
    expect(approved[0]!.key).toBe("b");
  });

  test("getMemories respects limit", () => {
    for (let i = 0; i < 10; i++) {
      addMemory({ category: "fact", key: `k${i}`, content: `c${i}`, confidence: 0.5, source: "user", approved: false }, db);
    }
    const limited = getMemories({ limit: 3 }, db);
    expect(limited.length).toBe(3);
  });

  // ── FTS Search ──

  test("searchMemories finds by content keyword", () => {
    addMemory({ category: "fact", key: "ts-config", content: "Always use strict TypeScript mode", confidence: 0.9, source: "user", approved: true }, db);
    addMemory({ category: "preference", key: "editor", content: "Prefer vim keybindings", confidence: 0.8, source: "user", approved: true }, db);

    const results = searchMemories("TypeScript", db);
    expect(results.length).toBe(1);
    expect(results[0]!.key).toBe("ts-config");
  });

  test("searchMemories finds by key", () => {
    addMemory({ category: "convention", key: "bun-over-node", content: "Use Bun APIs instead of Node fs", confidence: 1.0, source: "user", approved: true }, db);

    const results = searchMemories("bun", db);
    expect(results.length).toBe(1);
  });

  // ── Promote ──

  test("promoteMemory sets approved and source to promoted", () => {
    const id = addMemory({ category: "learned", key: "k", content: "c", confidence: 0.5, source: "auto", approved: false }, db);
    const ok = promoteMemory(id, db);
    expect(ok).toBe(true);

    const entry = getMemories(undefined, db).find((m) => m.id === id)!;
    expect(entry.approved).toBe(true);
    expect(entry.source).toBe("promoted");
  });

  // ── Expiry ──

  test("expireStaleMemories removes expired entries", () => {
    addMemory({ category: "fact", key: "old", content: "expired", confidence: 0.5, source: "auto", approved: false, expiresAt: "2020-01-01T00:00:00" }, db);
    addMemory({ category: "fact", key: "fresh", content: "still good", confidence: 0.5, source: "user", approved: true }, db);

    const removed = expireStaleMemories(db);
    expect(removed).toBe(1);

    const remaining = getMemories(undefined, db);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.key).toBe("fresh");
  });

  // ── Stats ──

  test("getMemoryStats returns correct counts", () => {
    addMemory({ category: "fact", key: "a", content: "A", confidence: 0.5, source: "user", approved: false }, db);
    addMemory({ category: "fact", key: "b", content: "B", confidence: 0.5, source: "auto", approved: true }, db);
    addMemory({ category: "preference", key: "c", content: "C", confidence: 0.5, source: "user", approved: false }, db);

    const stats = getMemoryStats(db);
    expect(stats.total).toBe(3);
    expect(stats.byCategory["fact"]).toBe(2);
    expect(stats.byCategory["preference"]).toBe(1);
    expect(stats.bySource["user"]).toBe(2);
    expect(stats.bySource["auto"]).toBe(1);
    expect(stats.expiringSoon).toBe(0);
  });
});
