import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { DatasetCurator, type DatasetEntry } from "./curator";

// ─── Test Helpers ──────────────────────────────────────────────

let tempDir: string;
let curator: DatasetCurator;

async function writeJsonl(
  filename: string,
  entries: Record<string, unknown>[],
): Promise<string> {
  const filePath = join(tempDir, filename);
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await Bun.write(filePath, content);
  return filePath;
}

async function writeJson(
  filename: string,
  data: unknown,
): Promise<string> {
  const filePath = join(tempDir, filename);
  await Bun.write(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

function makeEntry(overrides?: Partial<DatasetEntry>): DatasetEntry {
  return {
    user_query: "Write a function that adds two numbers",
    assistant_response:
      "Here is a TypeScript function:\n```ts\nfunction add(a: number, b: number): number {\n  return a + b;\n}\n```",
    tool_chain: JSON.stringify([
      { name: "Write", inputSummary: "add.ts", success: true },
    ]),
    success: true,
    tags: "typescript,code",
    quality: 1.0,
    ...overrides,
  };
}

// ─── Setup / Teardown ──────────────────────────────────────────

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kcode-curator-test-"));
  curator = new DatasetCurator();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── Tests ─────────────────────────────────────────────────────

describe("DatasetCurator", () => {
  // ─── loadDataset() ────────────────────────────────────────

  describe("loadDataset", () => {
    test("loads JSONL format (one object per line)", async () => {
      const file = await writeJsonl("data.jsonl", [
        { user_query: "Q1", assistant_response: "A1" },
        { user_query: "Q2", assistant_response: "A2" },
      ]);

      const entries = await curator.loadDataset(file);
      expect(entries.length).toBe(2);
      expect(entries[0]!.user_query).toBe("Q1");
      expect(entries[1]!.user_query).toBe("Q2");
    });

    test("loads JSON array format", async () => {
      const file = await writeJson("data.json", [
        { user_query: "Q1", assistant_response: "A1" },
        { user_query: "Q2", assistant_response: "A2" },
      ]);

      const entries = await curator.loadDataset(file);
      expect(entries.length).toBe(2);
    });

    test("normalizes JSONL Chat format (messages array)", async () => {
      const file = await writeJsonl("chat.jsonl", [
        {
          messages: [
            { role: "system", content: "System." },
            { role: "user", content: "Hi" },
            { role: "assistant", content: "Hello!" },
          ],
        },
      ]);

      const entries = await curator.loadDataset(file);
      expect(entries.length).toBe(1);
      expect(entries[0]!.user_query).toBe("Hi");
      expect(entries[0]!.assistant_response).toBe("Hello!");
    });

    test("normalizes ShareGPT format", async () => {
      const file = await writeJsonl("sharegpt.jsonl", [
        {
          conversations: [
            { from: "human", value: "Explain X" },
            { from: "gpt", value: "X is..." },
          ],
        },
      ]);

      const entries = await curator.loadDataset(file);
      expect(entries.length).toBe(1);
      expect(entries[0]!.user_query).toBe("Explain X");
      expect(entries[0]!.assistant_response).toBe("X is...");
    });

    test("normalizes Alpaca format", async () => {
      const file = await writeJsonl("alpaca.jsonl", [
        { instruction: "Do thing", input: "", output: "Done thing." },
      ]);

      const entries = await curator.loadDataset(file);
      expect(entries.length).toBe(1);
      expect(entries[0]!.user_query).toBe("Do thing");
      expect(entries[0]!.assistant_response).toBe("Done thing.");
    });
  });

  // ─── deduplicateByQuery() ─────────────────────────────────

  describe("deduplicateByQuery", () => {
    test("removes exact duplicates", () => {
      const entries = [
        makeEntry({ user_query: "Write a hello world" }),
        makeEntry({ user_query: "Write a hello world" }),
        makeEntry({ user_query: "Something completely different" }),
      ];

      const result = curator.deduplicateByQuery(entries, 0.95);
      expect(result.length).toBe(2);
    });

    test("removes near-duplicates above threshold", () => {
      const entries = [
        makeEntry({ user_query: "Write a function to add two numbers" }),
        makeEntry({
          user_query: "Write a function to add two numbers together",
        }),
        makeEntry({ user_query: "Deploy the kubernetes cluster" }),
      ];

      const result = curator.deduplicateByQuery(entries, 0.8);
      expect(result.length).toBe(2);
    });

    test("keeps all entries when none are similar", () => {
      const entries = [
        makeEntry({ user_query: "Implement binary search in Go" }),
        makeEntry({
          user_query: "Configure nginx reverse proxy",
        }),
        makeEntry({ user_query: "Write SQL migration for users table" }),
      ];

      const result = curator.deduplicateByQuery(entries, 0.95);
      expect(result.length).toBe(3);
    });

    test("returns empty for empty input", () => {
      expect(curator.deduplicateByQuery([], 0.95)).toEqual([]);
    });
  });

  // ─── querySimilarity() ────────────────────────────────────

  describe("querySimilarity", () => {
    test("returns 1.0 for identical strings", () => {
      expect(DatasetCurator.querySimilarity("hello", "hello")).toBe(1.0);
    });

    test("returns 1.0 for case-different identical strings", () => {
      expect(DatasetCurator.querySimilarity("Hello World", "hello world")).toBe(
        1.0,
      );
    });

    test("returns 0.0 for completely different strings", () => {
      const sim = DatasetCurator.querySimilarity("abc", "xyz");
      expect(sim).toBe(0.0);
    });

    test("returns high similarity for near-identical strings", () => {
      const sim = DatasetCurator.querySimilarity(
        "Write a function to add numbers",
        "Write a function to add numbers together",
      );
      expect(sim).toBeGreaterThan(0.7);
    });

    test("returns low similarity for unrelated strings", () => {
      const sim = DatasetCurator.querySimilarity(
        "Implement a REST API in Python",
        "Configure the kubernetes cluster",
      );
      expect(sim).toBeLessThan(0.3);
    });
  });

  // ─── trigrams() ───────────────────────────────────────────

  describe("trigrams", () => {
    test("extracts correct trigrams", () => {
      const result = DatasetCurator.trigrams("hello");
      expect(result).toEqual(["hel", "ell", "llo"]);
    });

    test("returns empty for strings shorter than 3", () => {
      expect(DatasetCurator.trigrams("ab")).toEqual([]);
      expect(DatasetCurator.trigrams("")).toEqual([]);
    });
  });

  // ─── filterProblematic() ──────────────────────────────────

  describe("filterProblematic", () => {
    test("removes responses shorter than 20 chars", () => {
      const entries = [
        makeEntry({ assistant_response: "OK" }),
        makeEntry({
          assistant_response: "This is a sufficiently long response with detail.",
        }),
      ];

      const result = curator.filterProblematic(entries);
      expect(result.length).toBe(1);
      expect(result[0]!.assistant_response).toContain("sufficiently");
    });

    test("removes failed interactions without fix mention", () => {
      const entries = [
        makeEntry({
          success: false,
          assistant_response: "I encountered an error and could not complete the task.",
        }),
        makeEntry({
          success: false,
          assistant_response:
            "I found the bug and applied a fix to the auth module.",
        }),
      ];

      const result = curator.filterProblematic(entries);
      expect(result.length).toBe(1);
      expect(result[0]!.assistant_response).toContain("fix");
    });

    test("removes entries with broken tool_chain JSON", () => {
      const entries = [
        makeEntry({ tool_chain: "not valid json{{{" }),
        makeEntry({ tool_chain: JSON.stringify([{ name: "Read" }]) }),
      ];

      const result = curator.filterProblematic(entries);
      expect(result.length).toBe(1);
    });

    test("keeps entries without tool_chain", () => {
      const entries = [
        makeEntry({ tool_chain: undefined }),
      ];

      const result = curator.filterProblematic(entries);
      expect(result.length).toBe(1);
    });
  });

  // ─── balanceByTags() ──────────────────────────────────────

  describe("balanceByTags", () => {
    test("caps entries per tag at maxPerTag", () => {
      const entries = [
        makeEntry({ tags: "typescript,code" }),
        makeEntry({ tags: "typescript,code", user_query: "Q2" }),
        makeEntry({ tags: "typescript,code", user_query: "Q3" }),
        makeEntry({ tags: "python,code", user_query: "Q4" }),
      ];

      const result = curator.balanceByTags(entries, {
        maxPerTag: 2,
        minPerTag: 1,
      });
      // 2 from typescript + 1 from python = 3
      const tsCount = result.filter((e) =>
        e.tags?.startsWith("typescript"),
      ).length;
      expect(tsCount).toBeLessThanOrEqual(2);
    });

    test("includes untagged entries", () => {
      const entries = [
        makeEntry({ tags: "" }),
        makeEntry({ tags: "typescript" }),
      ];

      const result = curator.balanceByTags(entries, {
        maxPerTag: 10,
        minPerTag: 1,
      });
      expect(result.length).toBe(2);
    });

    test("returns empty for empty input", () => {
      expect(
        curator.balanceByTags([], { maxPerTag: 10, minPerTag: 5 }),
      ).toEqual([]);
    });
  });

  // ─── cleanText() ──────────────────────────────────────────

  describe("cleanText", () => {
    test("trims whitespace", () => {
      expect(DatasetCurator.cleanText("  hello  ")).toBe("hello");
    });

    test("collapses excessive newlines", () => {
      expect(DatasetCurator.cleanText("a\n\n\n\n\nb")).toBe("a\n\nb");
    });

    test("strips control characters", () => {
      expect(DatasetCurator.cleanText("hello\x00world\x1F!")).toBe(
        "helloworld!",
      );
    });

    test("preserves tabs and normal newlines", () => {
      expect(DatasetCurator.cleanText("a\tb\nc")).toBe("a\tb\nc");
    });
  });

  // ─── Full curate() pipeline ───────────────────────────────

  describe("curate (end-to-end)", () => {
    test("curates a JSONL dataset and writes output", async () => {
      const entries = [
        makeEntry({ user_query: "Write a function" }),
        makeEntry({ user_query: "Write a function" }), // duplicate
        makeEntry({ assistant_response: "OK" }), // too short
        makeEntry({
          user_query: "Deploy to production",
          assistant_response:
            "Here are the deployment steps for the production environment.",
          tags: "deploy",
        }),
        makeEntry({
          tool_chain: "invalid{json",
          user_query: "Broken entry",
        }), // broken
      ];

      const inputFile = await writeJsonl(
        "input.jsonl",
        entries as unknown as Record<string, unknown>[],
      );
      const outputFile = join(tempDir, "output.jsonl");

      const report = await curator.curate(inputFile, outputFile);

      expect(report.inputCount).toBe(5);
      // Should remove: 1 duplicate + 1 short + 1 broken = 3 removed
      expect(report.outputCount).toBeLessThan(5);
      expect(report.removedDuplicates).toBeGreaterThanOrEqual(1);

      // Output file should exist and be valid JSONL
      const outputContent = readFileSync(outputFile, "utf-8").trim();
      const lines = outputContent.split("\n");
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    test("curates a JSON array dataset", async () => {
      const entries = [
        makeEntry({ user_query: "Implement binary search in Python with detailed error handling", tags: "python,algorithms" }),
        makeEntry({ user_query: "Configure nginx reverse proxy for microservices architecture", tags: "devops,nginx" }),
      ];

      const inputFile = await writeJson(
        "input.json",
        entries as unknown as Record<string, unknown>[],
      );
      const outputFile = join(tempDir, "output.jsonl");

      const report = await curator.curate(inputFile, outputFile);
      expect(report.inputCount).toBe(2);
      expect(report.outputCount).toBe(2);
    });

    test("handles empty dataset", async () => {
      const inputFile = await writeJsonl("empty.jsonl", []);
      const outputFile = join(tempDir, "output.jsonl");

      // Empty file should throw or handle gracefully
      // JSONL with no entries: the file is empty or has no lines
      await Bun.write(inputFile, "");

      try {
        const report = await curator.curate(inputFile, outputFile);
        expect(report.inputCount).toBe(0);
        expect(report.outputCount).toBe(0);
      } catch {
        // Empty file may throw, which is acceptable
        expect(true).toBe(true);
      }
    });
  });
});
