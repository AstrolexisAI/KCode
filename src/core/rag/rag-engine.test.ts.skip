// KCode - RagEngine Tests

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbedderInterface } from "./embedder";
import { RagEngine } from "./rag-engine";

// ─── Mock Embedder ────────────────────────────────────────────

/** Simple mock embedder that returns deterministic vectors based on content hash */
class MockEmbedder implements EmbedderInterface {
  dimensions = 4;
  callCount = 0;

  async embed(text: string): Promise<number[]> {
    this.callCount++;
    return this.hashToVector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    this.callCount += texts.length;
    return texts.map((t) => this.hashToVector(t));
  }

  private hashToVector(text: string): number[] {
    // Deterministic pseudo-vector from text content
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) & 0xffffffff;
    }
    const a = ((hash >> 24) & 0xff) / 255;
    const b = ((hash >> 16) & 0xff) / 255;
    const c = ((hash >> 8) & 0xff) / 255;
    const d = (hash & 0xff) / 255;
    // Normalize
    const norm = Math.sqrt(a * a + b * b + c * c + d * d) || 1;
    return [a / norm, b / norm, c / norm, d / norm];
  }
}

// ─── Test Setup ───────────────────────────────────────────────

let tempDir: string;
let db: Database;
let embedder: MockEmbedder;
let engine: RagEngine;

async function createFile(relPath: string, content: string): Promise<string> {
  const fullPath = join(tempDir, relPath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(fullPath, content, "utf-8");
  return fullPath;
}

describe("RagEngine", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-rag-engine-test-"));
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode=WAL");
    embedder = new MockEmbedder();
    engine = new RagEngine(embedder, db);
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── indexFile ──────────────────────────────────────────────

  test("indexFile creates chunks and returns count", async () => {
    const filePath = await createFile(
      "src/app.ts",
      `function hello() {
  return "world";
}

function goodbye() {
  return "bye";
}`,
    );

    const count = await engine.indexFile(filePath);
    expect(count).toBeGreaterThanOrEqual(2);
    expect(embedder.callCount).toBeGreaterThanOrEqual(2);
  });

  test("indexFile returns 0 for unchanged file (incremental)", async () => {
    const filePath = await createFile("src/app.ts", "const x = 1;");

    const count1 = await engine.indexFile(filePath);
    expect(count1).toBeGreaterThan(0);

    const count2 = await engine.indexFile(filePath);
    expect(count2).toBe(0); // Skipped because checksum unchanged
  });

  test("indexFile re-indexes when file content changes", async () => {
    const filePath = await createFile("src/app.ts", "const x = 1;");
    await engine.indexFile(filePath);

    // Change the file
    await writeFile(filePath, "const x = 2;\nconst y = 3;", "utf-8");
    const count = await engine.indexFile(filePath);
    expect(count).toBeGreaterThan(0);
  });

  test("indexFile throws for non-existent file", async () => {
    await expect(engine.indexFile("/nonexistent/file.ts")).rejects.toThrow();
  });

  // ─── indexDirectory ─────────────────────────────────────────

  test("indexDirectory processes all matching files", async () => {
    await createFile("src/a.ts", "function a() { return 1; }");
    await createFile("src/b.ts", "function b() { return 2; }");
    await createFile("src/c.py", "def c():\n    return 3");

    const stats = await engine.indexDirectory(tempDir);
    expect(stats.filesProcessed).toBe(3);
    expect(stats.chunksCreated).toBeGreaterThanOrEqual(3);
    expect(stats.errors).toEqual([]);
    expect(stats.duration).toBeGreaterThanOrEqual(0);
  });

  test("indexDirectory skips non-code files", async () => {
    await createFile("README.md", "# Hello");
    await createFile("data.json", '{"key": "value"}');
    await createFile("src/app.ts", "export const x = 1;");

    const stats = await engine.indexDirectory(tempDir);
    expect(stats.filesProcessed).toBe(1);
  });

  test("indexDirectory skips ignored directories", async () => {
    await createFile("node_modules/foo/index.js", "module.exports = 1;");
    await createFile("dist/bundle.js", "var x = 1;");
    await createFile("src/app.ts", "export const x = 1;");

    const stats = await engine.indexDirectory(tempDir);
    expect(stats.filesProcessed).toBe(1);
  });

  test("indexDirectory supports custom extensions filter", async () => {
    await createFile("src/a.ts", "const a = 1;");
    await createFile("src/b.py", "b = 2");

    const stats = await engine.indexDirectory(tempDir, { extensions: [".py"] });
    expect(stats.filesProcessed).toBe(1);
  });

  // ─── search ─────────────────────────────────────────────────

  test("search returns ranked results after indexing", async () => {
    await createFile(
      "src/auth.ts",
      `function authenticate(user: string, pass: string) {
  return user === "admin" && pass === "secret";
}`,
    );
    await createFile(
      "src/math.ts",
      `function add(a: number, b: number) {
  return a + b;
}`,
    );

    await engine.indexDirectory(tempDir);
    const results = await engine.search("authenticate user password");

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.score).toBeGreaterThan(0);
    expect(results[0]!.filepath).toBeDefined();
    expect(results[0]!.lineStart).toBeGreaterThanOrEqual(1);
    expect(results[0]!.content).toBeDefined();
  });

  test("search respects topK parameter", async () => {
    await createFile("src/a.ts", "function a() { return 1; }");
    await createFile("src/b.ts", "function b() { return 2; }");
    await createFile("src/c.ts", "function c() { return 3; }");

    await engine.indexDirectory(tempDir);
    const results = await engine.search("function", 1);
    expect(results.length).toBe(1);
  });

  test("search returns empty array when no index exists", async () => {
    const results = await engine.search("anything");
    expect(results).toEqual([]);
  });

  // ─── formatAsContext ────────────────────────────────────────

  test("formatAsContext produces markdown with code blocks", () => {
    const results = [
      {
        filepath: "/src/auth.ts",
        lineStart: 1,
        lineEnd: 5,
        content: "function authenticate() {}",
        score: 0.95,
        chunkType: "function",
        name: "authenticate",
      },
    ];

    const context = engine.formatAsContext(results);
    expect(context).toContain("## Relevant Code Context (RAG)");
    expect(context).toContain("authenticate");
    expect(context).toContain("```");
    expect(context).toContain("0.950");
    expect(context).toContain("/src/auth.ts:1-5");
  });

  test("formatAsContext returns empty string for no results", () => {
    expect(engine.formatAsContext([])).toBe("");
  });

  test("formatAsContext includes all result fields", () => {
    const results = [
      {
        filepath: "/a.ts",
        lineStart: 10,
        lineEnd: 20,
        content: "code here",
        score: 0.8,
        chunkType: "class",
        name: "MyClass",
      },
      {
        filepath: "/b.ts",
        lineStart: 1,
        lineEnd: 5,
        content: "more code",
        score: 0.6,
        chunkType: "function",
        name: "helper",
      },
    ];

    const context = engine.formatAsContext(results);
    expect(context).toContain("MyClass");
    expect(context).toContain("helper");
    expect(context).toContain("class");
    expect(context).toContain("function");
  });

  // ─── getStore ───────────────────────────────────────────────

  test("getStore returns the underlying vector store", () => {
    const store = engine.getStore();
    expect(store).toBeDefined();
    expect(store.count).toBe(0);
  });
});
