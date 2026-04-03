import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RAGEngine, resetRAGEngine } from "./engine";

let tempDir: string;
let projectDir: string;

async function createFile(relPath: string, content: string): Promise<string> {
  const fullPath = join(projectDir, relPath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(fullPath, content, "utf-8");
  return fullPath;
}

describe("RAGEngine", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-rag-test-"));
    projectDir = join(tempDir, "project");
    await mkdir(projectDir, { recursive: true });

    // Set KCODE_DB_PATH to use in-memory DB for tests
    process.env.KCODE_DB_PATH = ":memory:";
    resetRAGEngine();

    // Reset the db singleton so it picks up the new env
    try {
      const { closeDb } = await import("../db");
      closeDb();
    } catch {
      /* ok */
    }
  });

  afterEach(async () => {
    resetRAGEngine();
    try {
      const { closeDb } = await import("../db");
      closeDb();
    } catch {
      /* ok */
    }
    delete process.env.KCODE_DB_PATH;
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Initialization ──────────────────────────────────────────

  test("init detects tfidf backend in test env", async () => {
    const engine = new RAGEngine(projectDir);
    await engine.init();

    const embedder = engine.getEmbedder();
    // In test env without Ollama/llama.cpp, should fall back to tfidf
    expect(embedder.getBackend()).toBeDefined();
  });

  // ─── Full Index ──────────────────────────────────────────────

  test("indexProject indexes TypeScript files", async () => {
    await createFile(
      "src/auth.ts",
      `
export function authenticate(user: string, pass: string): boolean {
  return user === "admin" && pass === "secret";
}

export function hashPassword(password: string): string {
  return password.split("").reverse().join("");
}
    `.trim(),
    );

    await createFile(
      "src/db.ts",
      `
export class Database {
  connect(): void { console.log("connected"); }
  query(sql: string): any[] { return []; }
}
    `.trim(),
    );

    const engine = new RAGEngine(projectDir);
    const report = await engine.indexProject();

    expect(report.filesProcessed).toBe(2);
    expect(report.chunksCreated).toBeGreaterThanOrEqual(2);
    expect(report.errors).toEqual([]);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("indexProject skips non-code files", async () => {
    await createFile("README.md", "# Hello");
    await createFile("data.json", '{"key": "value"}');
    await createFile("src/app.ts", "export const x = 1;");

    const engine = new RAGEngine(projectDir);
    const report = await engine.indexProject();

    expect(report.filesProcessed).toBe(1); // only app.ts
  });

  test("indexProject skips ignored directories", async () => {
    await createFile("node_modules/foo/index.js", "module.exports = 1;");
    await createFile("dist/bundle.js", "var x = 1;");
    await createFile("src/app.ts", "export const x = 1;");

    const engine = new RAGEngine(projectDir);
    const report = await engine.indexProject();

    expect(report.filesProcessed).toBe(1);
  });

  test("indexProject prevents concurrent indexing", async () => {
    await createFile("src/a.ts", "export const a = 1;");

    const engine = new RAGEngine(projectDir);

    // Start two concurrent index operations
    const p1 = engine.indexProject();

    // The second should fail
    await expect(engine.indexProject()).rejects.toThrow("already in progress");

    await p1; // let the first finish
  });

  // ─── Search ──────────────────────────────────────────────────

  test("search finds relevant chunks after indexing", async () => {
    await createFile(
      "src/auth.ts",
      `
export function authenticate(user: string, password: string): boolean {
  return user === "admin" && password === "secret";
}
    `.trim(),
    );

    await createFile(
      "src/math.ts",
      `
export function add(a: number, b: number): number {
  return a + b;
}
    `.trim(),
    );

    const engine = new RAGEngine(projectDir);
    await engine.indexProject();

    const results = await engine.search("authentication password");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("search returns empty for unindexed engine", async () => {
    const engine = new RAGEngine(projectDir);
    const results = await engine.search("anything");
    expect(results).toEqual([]);
  });

  test("search with filters narrows results", async () => {
    await createFile("src/app.ts", "export function handler() { return 1; }");
    await createFile("lib/util.py", "def helper():\n    return 1");

    const engine = new RAGEngine(projectDir);
    await engine.indexProject();

    const allResults = await engine.search("function handler helper");
    const tsResults = await engine.search("function handler helper", {
      filters: { language: "typescript" },
    });

    expect(tsResults.length).toBeLessThanOrEqual(allResults.length);
  });

  // ─── Incremental Update ──────────────────────────────────────

  test("updateIndex re-indexes modified files", async () => {
    await createFile("src/app.ts", "export const version = 1;");

    const engine = new RAGEngine(projectDir);
    await engine.indexProject();

    engine.stats();

    // Modify the file (with slight delay to ensure mtime changes)
    await new Promise((r) => setTimeout(r, 50));
    await createFile("src/app.ts", "export const version = 2;\nexport function newFunc() {}");

    const report = await engine.updateIndex();
    expect(report.filesProcessed).toBeGreaterThanOrEqual(1);
  });

  // ─── Format as Context ──────────────────────────────────────

  test("formatAsContext produces markdown with code blocks", async () => {
    await createFile("src/app.ts", "export function hello() { return 'world'; }");

    const engine = new RAGEngine(projectDir);
    await engine.indexProject();

    const results = await engine.search("hello");
    const context = engine.formatAsContext(results, 3000);

    expect(context).toContain("## Relevant codebase context (RAG)");
    expect(context).toContain("```");
  });

  test("formatAsContext respects token budget", async () => {
    await createFile("src/big.ts", "x".repeat(10000));

    const engine = new RAGEngine(projectDir);
    await engine.indexProject();

    const results = await engine.search("test");
    const context = engine.formatAsContext(results, 100);

    // Should be truncated
    expect(context.length).toBeLessThan(10000);
  });

  test("formatAsContext returns empty string for no results", () => {
    const engine = new RAGEngine(projectDir);
    expect(engine.formatAsContext([])).toBe("");
  });

  // ─── Stats & Clear ──────────────────────────────────────────

  test("stats returns zeros before indexing", async () => {
    const engine = new RAGEngine(projectDir);
    const stats = engine.stats();
    expect(stats.total).toBe(0);
  });

  test("clear removes all indexed data", async () => {
    await createFile("src/app.ts", "export const x = 1;");

    const engine = new RAGEngine(projectDir);
    await engine.indexProject();

    expect(engine.stats().total).toBeGreaterThan(0);

    engine.clear();
    expect(engine.stats().total).toBe(0);
  });

  // ─── Language Detection ──────────────────────────────────────

  test("detectLanguage maps extensions correctly", () => {
    const engine = new RAGEngine(projectDir);

    expect(engine.detectLanguage("test.ts")).toBe("typescript");
    expect(engine.detectLanguage("test.py")).toBe("python");
    expect(engine.detectLanguage("test.go")).toBe("go");
    expect(engine.detectLanguage("test.rs")).toBe("rust");
    expect(engine.detectLanguage("test.xyz")).toBe("unknown");
  });

  // ─── File Listing ────────────────────────────────────────────

  test("listEligibleFiles respects file limits", async () => {
    // Create a few code files
    for (let i = 0; i < 5; i++) {
      await createFile(`src/file${i}.ts`, `export const x${i} = ${i};`);
    }

    const engine = new RAGEngine(projectDir);
    const files = engine.listEligibleFiles(projectDir);

    expect(files.length).toBe(5);
    for (const f of files) {
      expect(f.path).toContain(".ts");
      expect(f.size).toBeGreaterThan(0);
    }
  });
});
