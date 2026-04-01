import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CodeChunk } from "./types";
import { cosineSimilarity, VectorStore } from "./vector-store";

let db: Database;
let store: VectorStore;

function makeChunk(
  overrides: Partial<CodeChunk & { embedding: number[] }> = {},
): CodeChunk & { embedding: number[] } {
  return {
    id: overrides.id ?? "chunk-1",
    filePath: overrides.filePath ?? "/project/src/test.ts",
    relativePath: overrides.relativePath ?? "src/test.ts",
    language: overrides.language ?? "typescript",
    type: overrides.type ?? "function",
    name: overrides.name ?? "testFunc",
    content: overrides.content ?? "function testFunc() { return 1; }",
    signature: overrides.signature ?? "function testFunc()",
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 3,
    dependencies: overrides.dependencies ?? [],
    tokenEstimate: overrides.tokenEstimate ?? 10,
    embedding: overrides.embedding ?? [1, 0, 0, 0],
  };
}

describe("VectorStore", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode=WAL");
    store = new VectorStore(db, 4);
  });

  afterEach(() => {
    db.close();
  });

  // ─── Upsert ──────────────────────────────────────────────────

  test("upsert stores chunks and count increases", () => {
    store.upsert([makeChunk()]);
    expect(store.count()).toBe(1);
  });

  test("upsert replaces existing chunk with same id", () => {
    store.upsert([makeChunk({ id: "c1", content: "original" })]);
    store.upsert([makeChunk({ id: "c1", content: "updated" })]);

    expect(store.count()).toBe(1);
    const results = store.search([1, 0, 0, 0], 10);
    expect(results[0]!.content).toBe("updated");
  });

  test("upsert handles multiple chunks in batch", () => {
    store.upsert([
      makeChunk({ id: "c1", embedding: [1, 0, 0, 0] }),
      makeChunk({ id: "c2", embedding: [0, 1, 0, 0] }),
      makeChunk({ id: "c3", embedding: [0, 0, 1, 0] }),
    ]);
    expect(store.count()).toBe(3);
  });

  // ─── Search ──────────────────────────────────────────────────

  test("search returns chunks sorted by similarity", () => {
    store.upsert([
      makeChunk({ id: "c1", name: "exact", embedding: [1, 0, 0, 0] }),
      makeChunk({ id: "c2", name: "orthogonal", embedding: [0, 1, 0, 0] }),
      makeChunk({ id: "c3", name: "partial", embedding: [0.7, 0.7, 0, 0] }),
    ]);

    const results = store.search([1, 0, 0, 0], 10);
    expect(results.length).toBe(3);
    expect(results[0]!.name).toBe("exact");
    expect(results[0]!.similarity).toBeCloseTo(1.0, 3);
  });

  test("search respects limit", () => {
    store.upsert([
      makeChunk({ id: "c1", embedding: [1, 0, 0, 0] }),
      makeChunk({ id: "c2", embedding: [0, 1, 0, 0] }),
      makeChunk({ id: "c3", embedding: [0, 0, 1, 0] }),
    ]);

    const results = store.search([1, 0, 0, 0], 2);
    expect(results.length).toBe(2);
  });

  test("search filters by language", () => {
    store.upsert([
      makeChunk({ id: "c1", language: "typescript", embedding: [1, 0, 0, 0] }),
      makeChunk({ id: "c2", language: "python", embedding: [0.9, 0.1, 0, 0] }),
    ]);

    const results = store.search([1, 0, 0, 0], 10, { language: "python" });
    expect(results.length).toBe(1);
    expect(results[0]!.chunkId).toBe("c2");
  });

  test("search filters by type", () => {
    store.upsert([
      makeChunk({ id: "c1", type: "function", embedding: [1, 0, 0, 0] }),
      makeChunk({ id: "c2", type: "class", embedding: [0.9, 0.1, 0, 0] }),
    ]);

    const results = store.search([1, 0, 0, 0], 10, { type: "class" });
    expect(results.length).toBe(1);
    expect(results[0]!.type).toBe("class");
  });

  test("search filters by file paths", () => {
    store.upsert([
      makeChunk({ id: "c1", filePath: "/a/test.ts", embedding: [1, 0, 0, 0] }),
      makeChunk({ id: "c2", filePath: "/b/test.ts", embedding: [0.9, 0.1, 0, 0] }),
    ]);

    const results = store.search([1, 0, 0, 0], 10, { filePaths: ["/a/test.ts"] });
    expect(results.length).toBe(1);
    expect(results[0]!.filePath).toBe("/a/test.ts");
  });

  test("search returns empty for no matches", () => {
    const results = store.search([1, 0, 0, 0], 10);
    expect(results).toEqual([]);
  });

  // ─── Remove ──────────────────────────────────────────────────

  test("removeByFile deletes all chunks for a file", () => {
    store.upsert([
      makeChunk({ id: "c1", filePath: "/project/a.ts" }),
      makeChunk({ id: "c2", filePath: "/project/a.ts" }),
      makeChunk({ id: "c3", filePath: "/project/b.ts" }),
    ]);

    store.removeByFile("/project/a.ts");
    expect(store.count()).toBe(1);
  });

  test("clear removes all chunks", () => {
    store.upsert([makeChunk({ id: "c1" }), makeChunk({ id: "c2" })]);

    store.clear();
    expect(store.count()).toBe(0);
  });

  // ─── Stats ───────────────────────────────────────────────────

  test("stats returns correct totals", () => {
    store.upsert([
      makeChunk({ id: "c1", filePath: "/a.ts", tokenEstimate: 100 }),
      makeChunk({ id: "c2", filePath: "/a.ts", tokenEstimate: 200 }),
      makeChunk({ id: "c3", filePath: "/b.ts", tokenEstimate: 50 }),
    ]);

    const s = store.stats();
    expect(s.total).toBe(3);
    expect(s.files).toBe(2);
    expect(s.totalTokens).toBe(350);
  });

  test("stats returns zeros for empty store", () => {
    const s = store.stats();
    expect(s.total).toBe(0);
    expect(s.files).toBe(0);
    expect(s.totalTokens).toBe(0);
  });
});

// ─── Cosine Similarity Tests ───────────────────────────────────

describe("cosineSimilarity", () => {
  test("identical vectors return 1.0", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  test("orthogonal vectors return 0.0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  test("opposite vectors return -1.0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  test("zero vector returns 0.0", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test("different length vectors return 0.0", () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test("empty vectors return 0.0", () => {
    const a = new Float32Array([]);
    const b = new Float32Array([]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test("scaled vectors are still similar (cosine = 1.0)", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([2, 4, 6]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });
});
