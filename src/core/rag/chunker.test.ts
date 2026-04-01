import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodeChunker } from "./chunker";

let tempDir: string;
let chunker: CodeChunker;

describe("CodeChunker", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-chunker-test-"));
    chunker = new CodeChunker(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── TypeScript / JavaScript ─────────────────────────────────

  describe("TypeScript chunking", () => {
    test("small file (<100 lines) returns single module chunk", () => {
      const content = `
import { foo } from "./foo";

export function hello() {
  return "world";
}

export const bar = 42;
`.trim();

      const filePath = join(tempDir, "small.ts");
      const chunks = chunker.chunk(filePath, content, "typescript");

      expect(chunks.length).toBe(1);
      expect(chunks[0]!.type).toBe("module");
      expect(chunks[0]!.name).toBe("small.ts");
      expect(chunks[0]!.content).toBe(content);
    });

    test("large file with functions creates per-function chunks", () => {
      // Generate a file with 150+ lines containing multiple functions
      const lines: string[] = ['import { something } from "./lib";', ""];
      for (let i = 0; i < 5; i++) {
        lines.push(`export function func${i}(arg: string) {`);
        for (let j = 0; j < 25; j++) {
          lines.push(`  const x${j} = arg + "${j}";`);
        }
        lines.push("  return arg;");
        lines.push("}");
        lines.push("");
      }

      const content = lines.join("\n");
      const filePath = join(tempDir, "large.ts");
      const chunks = chunker.chunk(filePath, content, "typescript");

      // Should have import chunk + function chunks
      expect(chunks.length).toBeGreaterThanOrEqual(5);

      // Each function chunk should have the correct name
      const funcChunks = chunks.filter((c) => c.type === "function");
      expect(funcChunks.length).toBeGreaterThanOrEqual(4); // some may merge
    });

    test("detects class definitions", () => {
      const lines: string[] = [];
      for (let i = 0; i < 50; i++) lines.push(`// filler line ${i}`);
      lines.push("export class MyClass {");
      for (let i = 0; i < 30; i++) lines.push(`  field${i} = ${i};`);
      lines.push("}");
      for (let i = 0; i < 30; i++) lines.push(`// more filler ${i}`);

      const content = lines.join("\n");
      const filePath = join(tempDir, "cls.ts");
      const chunks = chunker.chunk(filePath, content, "typescript");

      const classChunks = chunks.filter((c) => c.name === "MyClass");
      expect(classChunks.length).toBeGreaterThanOrEqual(1);
    });

    test("handles JSX files the same as TypeScript", () => {
      const content = "export const App = () => <div>hello</div>;";
      const filePath = join(tempDir, "app.jsx");
      const chunks = chunker.chunk(filePath, content, "jsx");

      expect(chunks.length).toBe(1); // small file
      expect(chunks[0]!.language).toBe("jsx");
    });
  });

  // ─── Python ──────────────────────────────────────────────────

  describe("Python chunking", () => {
    test("small Python file returns single chunk", () => {
      const content = `
def hello():
    return "world"

class Greeter:
    def greet(self):
        return "hi"
`.trim();

      const filePath = join(tempDir, "small.py");
      const chunks = chunker.chunk(filePath, content, "python");

      expect(chunks.length).toBe(1);
      expect(chunks[0]!.type).toBe("module");
    });

    test("large Python file splits by def/class", () => {
      const lines: string[] = [];
      for (let i = 0; i < 5; i++) {
        lines.push(`def function_${i}(arg):`);
        for (let j = 0; j < 25; j++) {
          lines.push(`    x = arg + "${j}"`);
        }
        lines.push(`    return arg`);
        lines.push("");
      }

      const content = lines.join("\n");
      const filePath = join(tempDir, "large.py");
      const chunks = chunker.chunk(filePath, content, "python");

      expect(chunks.length).toBeGreaterThanOrEqual(5);
      const funcChunks = chunks.filter((c) => c.type === "function");
      expect(funcChunks.length).toBe(5);
    });
  });

  // ─── Go ──────────────────────────────────────────────────────

  describe("Go chunking", () => {
    test("detects Go functions and types", () => {
      const lines: string[] = ["package main", "", 'import "fmt"', ""];
      for (let i = 0; i < 3; i++) {
        lines.push(`func Handler${i}(w http.ResponseWriter, r *http.Request) {`);
        for (let j = 0; j < 30; j++) lines.push(`\tfmt.Println("${j}")`);
        lines.push("}");
        lines.push("");
      }
      lines.push("type Server struct {");
      for (let j = 0; j < 10; j++) lines.push(`\tField${j} string`);
      lines.push("}");

      const content = lines.join("\n");
      const filePath = join(tempDir, "main.go");
      const chunks = chunker.chunk(filePath, content, "go");

      const funcChunks = chunks.filter((c) => c.type === "function");
      expect(funcChunks.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ─── Rust ────────────────────────────────────────────────────

  describe("Rust chunking", () => {
    test("detects Rust fn, struct, impl", () => {
      const lines: string[] = [];
      lines.push("pub struct Config {");
      for (let j = 0; j < 10; j++) lines.push(`    field${j}: String,`);
      lines.push("}");
      lines.push("");
      lines.push("impl Config {");
      for (let j = 0; j < 30; j++) lines.push(`    // impl line ${j}`);
      lines.push("}");
      lines.push("");
      lines.push("pub fn main() {");
      for (let j = 0; j < 30; j++) lines.push(`    println!("${j}");`);
      lines.push("}");
      // pad to 100+ lines
      for (let j = 0; j < 30; j++) lines.push(`// padding ${j}`);

      const content = lines.join("\n");
      const filePath = join(tempDir, "lib.rs");
      const chunks = chunker.chunk(filePath, content, "rust");

      expect(chunks.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ─── Sliding Window (generic) ────────────────────────────────

  describe("sliding window", () => {
    test("uses sliding window for unknown languages", () => {
      const lines = Array.from({ length: 120 }, (_, i) => `line ${i}`);
      const content = lines.join("\n");
      const filePath = join(tempDir, "data.txt");
      const chunks = chunker.chunk(filePath, content, "unknown");

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      for (const chunk of chunks) {
        expect(chunk.type).toBe("block");
      }
    });

    test("window size and overlap are configurable", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
      const content = lines.join("\n");
      const filePath = join(tempDir, "data.txt");

      const chunks = chunker.chunkSlidingWindow(filePath, content, "text", 20, 5);

      // With window=20, overlap=5, step=15, 100 lines: ceil(100/15) ~ 7 chunks
      expect(chunks.length).toBeGreaterThanOrEqual(5);
      expect(chunks.length).toBeLessThanOrEqual(10);
    });
  });

  // ─── Edge Cases ──────────────────────────────────────────────

  describe("edge cases", () => {
    test("empty content returns empty array", () => {
      const chunks = chunker.chunk(join(tempDir, "empty.ts"), "", "typescript");
      expect(chunks).toEqual([]);
    });

    test("whitespace-only content returns empty array", () => {
      const chunks = chunker.chunk(join(tempDir, "ws.ts"), "   \n\n  ", "typescript");
      expect(chunks).toEqual([]);
    });

    test("chunk IDs are deterministic", () => {
      const content = "export function hello() { return 1; }";
      const filePath = join(tempDir, "det.ts");

      const chunks1 = chunker.chunk(filePath, content, "typescript");
      const chunks2 = chunker.chunk(filePath, content, "typescript");

      expect(chunks1[0]!.id).toBe(chunks2[0]!.id);
    });

    test("relative paths are computed from project root", () => {
      const filePath = join(tempDir, "src", "core", "test.ts");
      const chunks = chunker.chunk(filePath, "const x = 1;", "typescript");

      expect(chunks[0]!.relativePath).toBe(join("src", "core", "test.ts"));
    });

    test("token estimate is approximately content.length / 4", () => {
      const content = "x".repeat(400);
      const chunks = chunker.chunk(join(tempDir, "tok.ts"), content, "typescript");
      expect(chunks[0]!.tokenEstimate).toBe(100);
    });

    test("dependencies are extracted from imports", () => {
      const content = `
import { foo } from "./foo";
import { bar } from "../bar";

export const baz = foo + bar;
`.trim();

      const chunks = chunker.chunk(join(tempDir, "deps.ts"), content, "typescript");
      expect(chunks[0]!.dependencies).toContain("./foo");
      expect(chunks[0]!.dependencies).toContain("../bar");
    });
  });
});
