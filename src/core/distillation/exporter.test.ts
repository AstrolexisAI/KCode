import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatasetExporter } from "./exporter";
import type { DistilledExampleRow, ExportConfig } from "./types";

// ─── Test Helpers ──────────────────────────────────────────────

let tempDir: string;
let db: Database;

function insertExample(overrides: Partial<DistilledExampleRow> = {}): void {
  const defaults: DistilledExampleRow = {
    id: 0,
    user_query: "Write a hello world function in TypeScript",
    assistant_response:
      'Here is a simple function:\n```ts\nexport function hello() { return "Hello, World!"; }\n```',
    tool_chain: JSON.stringify([
      { name: "Write", inputSummary: "hello.ts (50 chars)", success: true },
    ]),
    tool_count: 1,
    success: 1,
    project: "/home/user/project",
    tags: "typescript,write",
    quality: 1.0,
    use_count: 3,
    created_at: new Date().toISOString(),
  };

  const row = { ...defaults, ...overrides };

  db.query(
    `INSERT INTO distilled_examples
      (user_query, assistant_response, tool_chain, tool_count, success, project, tags, quality, use_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.user_query,
    row.assistant_response,
    row.tool_chain,
    row.tool_count,
    row.success,
    row.project,
    row.tags,
    row.quality,
    row.use_count,
  );
}

function makeConfig(overrides?: Partial<ExportConfig>): ExportConfig {
  return DatasetExporter.defaults({
    outputPath: tempDir,
    ...overrides,
  });
}

// ─── Setup / Teardown ──────────────────────────────────────────

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kcode-exporter-test-"));

  // Set up in-memory DB
  process.env.KCODE_DB_PATH = ":memory:";

  // Force re-init of DB module by importing fresh
  // Instead we just create the table in a test-local DB and mock getDb
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS distilled_examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_query TEXT NOT NULL,
    assistant_response TEXT NOT NULL,
    tool_chain TEXT DEFAULT '[]',
    tool_count INTEGER DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 1,
    project TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    quality REAL NOT NULL DEFAULT 1.0,
    use_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
  delete process.env.KCODE_DB_PATH;
});

// ─── Tests ─────────────────────────────────────────────────────

describe("DatasetExporter", () => {
  // ─── defaults() ─────────────────────────────────────────────

  test("defaults() returns a valid ExportConfig", () => {
    const config = DatasetExporter.defaults();
    expect(config.format).toBe("jsonl-chat");
    expect(config.minQuality).toBe(0.5);
    expect(config.maxExamples).toBe(5000);
    expect(config.includeToolCalls).toBe(true);
    expect(config.includeThinking).toBe(false);
  });

  test("defaults() merges partial overrides", () => {
    const config = DatasetExporter.defaults({
      format: "sharegpt",
      minQuality: 0.8,
    });
    expect(config.format).toBe("sharegpt");
    expect(config.minQuality).toBe(0.8);
    expect(config.maxExamples).toBe(5000); // unchanged
  });

  // ─── getExtension() ────────────────────────────────────────

  test("getExtension returns .jsonl for jsonl-chat", () => {
    expect(DatasetExporter.getExtension("jsonl-chat")).toBe("jsonl");
  });

  test("getExtension returns .jsonl for openai", () => {
    expect(DatasetExporter.getExtension("openai")).toBe("jsonl");
  });

  test("getExtension returns .json for sharegpt", () => {
    expect(DatasetExporter.getExtension("sharegpt")).toBe("json");
  });

  test("getExtension returns .json for alpaca", () => {
    expect(DatasetExporter.getExtension("alpaca")).toBe("json");
  });

  // ─── formatExample() ───────────────────────────────────────

  describe("formatExample - jsonl-chat", () => {
    test("formats basic example with system + user + assistant", () => {
      const exporter = new DatasetExporter();
      const example: DistilledExampleRow = {
        id: 1,
        user_query: "Hello",
        assistant_response: "Hi there!",
        tool_chain: "[]",
        tool_count: 0,
        success: 1,
        project: "/test",
        tags: "",
        quality: 1.0,
        use_count: 0,
        created_at: "",
      };

      const config = makeConfig({ format: "jsonl-chat" });
      const result = exporter.formatExample(example, config) as {
        messages: Record<string, unknown>[];
      };

      expect(result.messages).toBeArray();
      expect(result.messages.length).toBe(3);
      expect(result.messages[0]).toEqual({
        role: "system",
        content: "You are KCode, an AI coding assistant.",
      });
      expect(result.messages[1]).toEqual({ role: "user", content: "Hello" });
      expect(result.messages[2]).toEqual({
        role: "assistant",
        content: "Hi there!",
      });
    });

    test("includes tool calls when includeToolCalls is true", () => {
      const exporter = new DatasetExporter();
      const example: DistilledExampleRow = {
        id: 1,
        user_query: "Read file",
        assistant_response: "Done reading.",
        tool_chain: JSON.stringify([
          { name: "Read", inputSummary: "/src/index.ts", success: true },
        ]),
        tool_count: 1,
        success: 1,
        project: "/test",
        tags: "read",
        quality: 1.0,
        use_count: 0,
        created_at: "",
      };

      const config = makeConfig({
        format: "jsonl-chat",
        includeToolCalls: true,
      });
      const result = exporter.formatExample(example, config) as {
        messages: Record<string, unknown>[];
      };

      // system + user + assistant(tool_call) + tool + assistant
      expect(result.messages.length).toBe(5);
      expect(result.messages[2]).toHaveProperty("tool_calls");
      expect(result.messages[3]).toMatchObject({
        role: "tool",
        name: "Read",
      });
    });

    test("skips tool calls when includeToolCalls is false", () => {
      const exporter = new DatasetExporter();
      const example: DistilledExampleRow = {
        id: 1,
        user_query: "Read file",
        assistant_response: "Done.",
        tool_chain: JSON.stringify([
          { name: "Read", inputSummary: "/src/index.ts", success: true },
        ]),
        tool_count: 1,
        success: 1,
        project: "/test",
        tags: "",
        quality: 1.0,
        use_count: 0,
        created_at: "",
      };

      const config = makeConfig({
        format: "jsonl-chat",
        includeToolCalls: false,
      });
      const result = exporter.formatExample(example, config) as {
        messages: Record<string, unknown>[];
      };

      // system + user + assistant (no tool turns)
      expect(result.messages.length).toBe(3);
    });

    test("handles malformed tool_chain gracefully", () => {
      const exporter = new DatasetExporter();
      const example: DistilledExampleRow = {
        id: 1,
        user_query: "Do something",
        assistant_response: "Done.",
        tool_chain: "not valid json{{{",
        tool_count: 0,
        success: 1,
        project: "",
        tags: "",
        quality: 1.0,
        use_count: 0,
        created_at: "",
      };

      const config = makeConfig({ format: "jsonl-chat" });
      const result = exporter.formatExample(example, config) as {
        messages: Record<string, unknown>[];
      };

      // Should still produce system + user + assistant (skip broken tools)
      expect(result.messages.length).toBe(3);
    });
  });

  describe("formatExample - sharegpt", () => {
    test("formats as human/gpt conversation", () => {
      const exporter = new DatasetExporter();
      const example: DistilledExampleRow = {
        id: 1,
        user_query: "Explain closures",
        assistant_response: "A closure captures variables from its outer scope.",
        tool_chain: "[]",
        tool_count: 0,
        success: 1,
        project: "",
        tags: "",
        quality: 1.0,
        use_count: 0,
        created_at: "",
      };

      const config = makeConfig({ format: "sharegpt" });
      const result = exporter.formatExample(example, config) as {
        conversations: { from: string; value: string }[];
      };

      expect(result.conversations).toBeArray();
      expect(result.conversations.length).toBe(2);
      expect(result.conversations[0]).toEqual({
        from: "human",
        value: "Explain closures",
      });
      expect(result.conversations[1]).toEqual({
        from: "gpt",
        value: "A closure captures variables from its outer scope.",
      });
    });
  });

  describe("formatExample - alpaca", () => {
    test("formats as instruction/input/output", () => {
      const exporter = new DatasetExporter();
      const example: DistilledExampleRow = {
        id: 1,
        user_query: "Reverse a string",
        assistant_response: 'Use .split("").reverse().join("")',
        tool_chain: "[]",
        tool_count: 0,
        success: 1,
        project: "",
        tags: "",
        quality: 1.0,
        use_count: 0,
        created_at: "",
      };

      const config = makeConfig({ format: "alpaca" });
      const result = exporter.formatExample(example, config) as {
        instruction: string;
        input: string;
        output: string;
      };

      expect(result.instruction).toBe("Reverse a string");
      expect(result.input).toBe("");
      expect(result.output).toBe('Use .split("").reverse().join("")');
    });
  });

  describe("formatExample - openai", () => {
    test("formats as OpenAI fine-tuning messages", () => {
      const exporter = new DatasetExporter();
      const example: DistilledExampleRow = {
        id: 1,
        user_query: "Write tests",
        assistant_response: "Here are the tests...",
        tool_chain: "[]",
        tool_count: 0,
        success: 1,
        project: "",
        tags: "",
        quality: 1.0,
        use_count: 0,
        created_at: "",
      };

      const config = makeConfig({ format: "openai" });
      const result = exporter.formatExample(example, config) as {
        messages: Record<string, unknown>[];
      };

      expect(result.messages.length).toBe(3);
      expect(result.messages[0]).toMatchObject({ role: "system" });
      expect(result.messages[1]).toMatchObject({
        role: "user",
        content: "Write tests",
      });
      expect(result.messages[2]).toMatchObject({
        role: "assistant",
        content: "Here are the tests...",
      });
    });
  });

  // ─── writeDataset() ────────────────────────────────────────

  describe("writeDataset", () => {
    test("writes JSONL for jsonl-chat format", async () => {
      const exporter = new DatasetExporter();
      const data = [
        { messages: [{ role: "user", content: "A" }] },
        { messages: [{ role: "user", content: "B" }] },
      ];

      const outFile = join(tempDir, "test.jsonl");
      await exporter.writeDataset(outFile, data, "jsonl-chat");

      expect(existsSync(outFile)).toBe(true);
      const lines = readFileSync(outFile, "utf-8").trim().split("\n");
      expect(lines.length).toBe(2);

      // Each line must be valid JSON
      const first = JSON.parse(lines[0]!);
      expect(first.messages[0].content).toBe("A");
    });

    test("writes JSON array for sharegpt format", async () => {
      const exporter = new DatasetExporter();
      const data = [
        { conversations: [{ from: "human", value: "Hi" }] },
        { conversations: [{ from: "human", value: "Bye" }] },
      ];

      const outFile = join(tempDir, "test.json");
      await exporter.writeDataset(outFile, data, "sharegpt");

      expect(existsSync(outFile)).toBe(true);
      const parsed = JSON.parse(readFileSync(outFile, "utf-8"));
      expect(parsed).toBeArray();
      expect(parsed.length).toBe(2);
    });
  });

  // ─── estimateTokens() ──────────────────────────────────────

  test("estimateTokens returns a positive number", () => {
    const exporter = new DatasetExporter();
    const data = [{ messages: [{ role: "user", content: "Hello world" }] }];
    const tokens = exporter.estimateTokens(data);
    expect(tokens).toBeGreaterThan(0);
  });

  test("estimateTokens returns 0 for empty array", () => {
    const exporter = new DatasetExporter();
    expect(exporter.estimateTokens([])).toBe(0);
  });

  // ─── queryExamples() with real DB ──────────────────────────

  describe("queryExamples (uses test DB)", () => {
    test("returns examples filtered by quality", () => {
      insertExample({ quality: 0.8 });
      insertExample({ quality: 0.2, user_query: "Low quality query" });

      const exporter = new DatasetExporter(db);
      const results = exporter.queryExamples(makeConfig({ minQuality: 0.5 }));
      expect(results.length).toBe(1);
      expect(results[0]!.quality).toBeGreaterThanOrEqual(0.5);
    });

    test("filters by project", () => {
      insertExample({ project: "/home/user/projectA" });
      insertExample({
        project: "/home/user/projectB",
        user_query: "Another query",
      });

      const exporter = new DatasetExporter(db);
      const results = exporter.queryExamples(
        makeConfig({ filterProjects: ["/home/user/projectA"] }),
      );
      expect(results.length).toBe(1);
      expect(results[0]!.project).toBe("/home/user/projectA");
    });

    test("filters by tags", () => {
      insertExample({ tags: "typescript,react" });
      insertExample({
        tags: "python,django",
        user_query: "Django query",
      });

      const exporter = new DatasetExporter(db);
      const results = exporter.queryExamples(makeConfig({ filterTags: ["typescript"] }));
      expect(results.length).toBe(1);
      expect(results[0]!.tags).toContain("typescript");
    });

    test("limits results by maxExamples", () => {
      for (let i = 0; i < 10; i++) {
        insertExample({
          user_query: `Query number ${i}`,
          quality: 1.0,
        });
      }

      const exporter = new DatasetExporter(db);
      const results = exporter.queryExamples(makeConfig({ maxExamples: 3 }));
      expect(results.length).toBe(3);
    });
  });

  // ─── Full export() pipeline ────────────────────────────────

  test("export produces a valid JSONL file from DB examples", async () => {
    insertExample({ quality: 1.0 });
    insertExample({
      quality: 0.9,
      user_query: "Fix a bug in the auth module",
      assistant_response: "The issue was a missing null check.",
      tags: "fix,typescript",
    });

    const exporter = new DatasetExporter(db);
    const report = await exporter.export(makeConfig({ format: "jsonl-chat" }));

    expect(report.examplesExported).toBe(2);
    expect(report.format).toBe("jsonl-chat");
    expect(report.totalTokens).toBeGreaterThan(0);
    expect(existsSync(report.outputFile)).toBe(true);

    // Verify each line is valid JSON with messages array
    const lines = readFileSync(report.outputFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.messages).toBeArray();
      expect(parsed.messages.length).toBeGreaterThanOrEqual(3);
    }
  });

  test("export with sharegpt format produces valid JSON", async () => {
    insertExample();

    const exporter = new DatasetExporter(db);
    const report = await exporter.export(makeConfig({ format: "sharegpt" }));

    expect(report.examplesExported).toBe(1);
    expect(report.format).toBe("sharegpt");

    const content = readFileSync(report.outputFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed).toBeArray();
    expect(parsed[0].conversations).toBeArray();
  });

  test("export with zero matching examples produces empty file", async () => {
    // No examples inserted — DB is empty

    const exporter = new DatasetExporter(db);
    const report = await exporter.export(makeConfig({ format: "jsonl-chat" }));

    expect(report.examplesExported).toBe(0);
    expect(report.totalTokens).toBe(0);
  });
});
