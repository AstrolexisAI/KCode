// KCode - RagVectorStore Tests (JSON-based vector store for the code-chunker pipeline)

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CodeChunk } from "./code-chunker";
import { cosineDistance, RagVectorStore } from "./vector-store";

let db: Database;
let store: RagVectorStore;

function makeChunk(overrides: Partial<CodeChunk> = {}): CodeChunk {
  return {
    filepath: overrides.filepath ?? "/project/src/test.ts",
    lineStart: overrides.lineStart ?? 1,
    lineEnd: overrides.lineEnd ?? 10,
    type: overrides.type ?? "function",
    name: overrides.name ?? "testFunc",
    content: overrides.content ?? "function testFunc() { return 1; }",
    language: overrides.language ?? "typescript",
  };
}

describe("RagVectorStore", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode=WAL");
    store = new RagVectorStore(db);
  });

  afterEach(() => {
    db.close();
  });

  // ─── Insert & Count ─────────────────────────────────────────

  test("insert stores a chunk and count increases", () => {
    expect(store.count).toBe(0);
    store.insert(makeChunk(), [1, 0, 0, 0], "abc123");
    expect(store.count).toBe(1);
  });

  test("insert multiple chunks", () => {
    store.insert(makeChunk({ name: "a" }), [1, 0, 0, 0], "abc");
    store.insert(makeChunk({ name: "b" }), [0, 1, 0, 0], "abc");
    store.insert(makeChunk({ name: "c" }), [0, 0, 1, 0], "abc");
    expect(store.count).toBe(3);
  });

  // ─── Search ─────────────────────────────────────────────────

  test("search returns chunks sorted by similarity", () => {
    store.insert(makeChunk({ name: "exact" }), [1, 0, 0, 0], "c1");
    store.insert(makeChunk({ name: "partial" }), [0.7, 0.7, 0, 0], "c2");
    store.insert(makeChunk({ name: "orthogonal" }), [0, 1, 0, 0], "c3");

    const results = store.search([1, 0, 0, 0], 10);
    expect(results.length).toBe(3);
    expect(results[0]!.name).toBe("exact");
    expect(results[0]!.score).toBeCloseTo(1.0, 3);
    // partial should be second
    expect(results[1]!.name).toBe("partial");
  });

  test("search respects topK limit", () => {
    store.insert(makeChunk({ name: "a" }), [1, 0, 0], "c1");
    store.insert(makeChunk({ name: "b" }), [0, 1, 0], "c2");
    store.insert(makeChunk({ name: "c" }), [0, 0, 1], "c3");

    const results = store.search([1, 0, 0], 2);
    expect(results.length).toBe(2);
  });

  test("search returns empty for empty store", () => {
    const results = store.search([1, 0, 0, 0], 10);
    expect(results).toEqual([]);
  });

  test("search result includes all chunk metadata", () => {
    store.insert(
      makeChunk({
        filepath: "/a/b.ts",
        lineStart: 5,
        lineEnd: 15,
        type: "class",
        name: "MyClass",
        content: "class MyClass {}",
      }),
      [1, 0],
      "checksum1",
    );

    const results = store.search([1, 0], 1);
    expect(results[0]!.filepath).toBe("/a/b.ts");
    expect(results[0]!.lineStart).toBe(5);
    expect(results[0]!.lineEnd).toBe(15);
    expect(results[0]!.chunkType).toBe("class");
    expect(results[0]!.name).toBe("MyClass");
    expect(results[0]!.content).toBe("class MyClass {}");
  });

  // ─── deleteByFilepath ───────────────────────────────────────

  test("deleteByFilepath removes all chunks for a file", () => {
    store.insert(makeChunk({ filepath: "/a.ts", name: "a1" }), [1, 0], "c1");
    store.insert(makeChunk({ filepath: "/a.ts", name: "a2" }), [0, 1], "c1");
    store.insert(makeChunk({ filepath: "/b.ts", name: "b1" }), [1, 1], "c2");

    store.deleteByFilepath("/a.ts");
    expect(store.count).toBe(1);

    const results = store.search([1, 1], 10);
    expect(results[0]!.filepath).toBe("/b.ts");
  });

  test("deleteByFilepath is a no-op for non-existent filepath", () => {
    store.insert(makeChunk(), [1, 0], "c1");
    store.deleteByFilepath("/nonexistent.ts");
    expect(store.count).toBe(1);
  });

  // ─── isFileStale ────────────────────────────────────────────

  test("isFileStale returns true for unindexed file", () => {
    expect(store.isFileStale("/new.ts", "abc")).toBe(true);
  });

  test("isFileStale returns false when checksum matches", () => {
    store.insert(makeChunk({ filepath: "/test.ts" }), [1, 0], "abc123");
    expect(store.isFileStale("/test.ts", "abc123")).toBe(false);
  });

  test("isFileStale returns true when checksum differs", () => {
    store.insert(makeChunk({ filepath: "/test.ts" }), [1, 0], "old_checksum");
    expect(store.isFileStale("/test.ts", "new_checksum")).toBe(true);
  });

  // ─── getIndexedFiles ────────────────────────────────────────

  test("getIndexedFiles returns file info", () => {
    store.insert(makeChunk({ filepath: "/a.ts" }), [1, 0], "cs_a");
    store.insert(makeChunk({ filepath: "/b.ts" }), [0, 1], "cs_b");

    const files = store.getIndexedFiles();
    expect(files.length).toBe(2);
    expect(files.some((f) => f.filepath === "/a.ts")).toBe(true);
    expect(files.some((f) => f.filepath === "/b.ts")).toBe(true);
  });
});

// ─── Cosine Distance Tests ────────────────────────────────────

describe("cosineDistance", () => {
  test("identical vectors have distance 0", () => {
    expect(cosineDistance([1, 2, 3], [1, 2, 3])).toBeCloseTo(0, 5);
  });

  test("orthogonal vectors have distance 1", () => {
    expect(cosineDistance([1, 0, 0], [0, 1, 0])).toBeCloseTo(1, 5);
  });

  test("opposite vectors have distance 2", () => {
    expect(cosineDistance([1, 0, 0], [-1, 0, 0])).toBeCloseTo(2, 5);
  });

  test("scaled vectors have distance 0", () => {
    expect(cosineDistance([1, 2, 3], [2, 4, 6])).toBeCloseTo(0, 5);
  });

  test("empty vectors return 1", () => {
    expect(cosineDistance([], [])).toBe(1);
  });

  test("mismatched lengths return 1", () => {
    expect(cosineDistance([1, 2], [1, 2, 3])).toBe(1);
  });

  test("zero vector returns 1", () => {
    expect(cosineDistance([0, 0, 0], [1, 2, 3])).toBe(1);
  });
});
