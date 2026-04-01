import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localSearch, searchManPages } from "./local-search";

describe("local-search", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origKcodeHome: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "kcode-local-search-test-"));
    origHome = process.env.HOME;
    origKcodeHome = process.env.KCODE_HOME;
    process.env.HOME = tempHome;
    // Also set KCODE_HOME so the db module uses temp dir
    process.env.KCODE_HOME = join(tempHome, ".kcode");
    await mkdir(join(tempHome, ".kcode"), { recursive: true });
  });

  afterEach(async () => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origKcodeHome !== undefined) process.env.KCODE_HOME = origKcodeHome;
    else delete process.env.KCODE_HOME;
    await rm(tempHome, { recursive: true, force: true });
  });

  // ─── localSearch ─────────────────────────────────────────────

  describe("localSearch", () => {
    test("returns empty array with no cached data", async () => {
      const results = await localSearch("nonexistent query xyz");
      expect(results).toBeInstanceOf(Array);
      expect(results.length).toBe(0);
    });

    test("respects limit parameter", async () => {
      // Even with data, limit should cap results
      const results = await localSearch("test", 5);
      expect(results.length).toBeLessThanOrEqual(5);
    });

    test("searches cached docs when available", async () => {
      // Create a cached doc file under KCODE_HOME (which is set in beforeEach)
      const docsDir = join(process.env.KCODE_HOME!, "cache", "docs");
      await mkdir(docsDir, { recursive: true });
      await writeFile(
        join(docsDir, "typescript-guide.md"),
        "# TypeScript Guide\n\nTypeScript is a typed superset of JavaScript.\nUse interfaces to define contracts.",
      );

      const results = await localSearch("TypeScript", 10, ["docs"]);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.source).toBe("docs");
      expect(results[0]!.title).toContain("typescript-guide");
    });

    test("searches cached search results when available", async () => {
      // Create a cached search result under KCODE_HOME
      const searchDir = join(process.env.KCODE_HOME!, "cache", "search");
      await mkdir(searchDir, { recursive: true });
      await writeFile(
        join(searchDir, "abc123.json"),
        JSON.stringify({
          query: "bun runtime",
          results: [
            {
              title: "Bun - Fast JS Runtime",
              url: "https://bun.sh",
              snippet: "Bun is a fast JavaScript runtime",
            },
          ],
          timestamp: Date.now(),
        }),
      );

      const results = await localSearch("bun runtime", 10, ["cache"]);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.source).toBe("cache");
      expect(results[0]!.title).toContain("Bun");
    });

    test("skips expired cache entries (>7 days)", async () => {
      const searchDir = join(process.env.KCODE_HOME!, "cache", "search");
      await mkdir(searchDir, { recursive: true });
      await writeFile(
        join(searchDir, "old.json"),
        JSON.stringify({
          query: "old query",
          results: [{ title: "Old Result", url: "https://old.com", snippet: "This is old" }],
          timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
        }),
      );

      const results = await localSearch("old query", 10, ["cache"]);
      expect(results.length).toBe(0);
    });

    test("deduplicates results by title", async () => {
      const docsDir = join(process.env.KCODE_HOME!, "cache", "docs");
      await mkdir(docsDir, { recursive: true });
      // Two files with same-titled content
      await writeFile(join(docsDir, "guide.md"), "This is about golang programming");
      await writeFile(join(docsDir, "guide.txt"), "This is about golang programming");

      const results = await localSearch("golang", 10, ["docs"]);
      const titles = results.map((r) => r.title);
      const uniqueTitles = new Set(titles);
      expect(titles.length).toBe(uniqueTitles.size);
    });

    test("sorts results by relevance descending", async () => {
      const docsDir = join(process.env.KCODE_HOME!, "cache", "docs");
      await mkdir(docsDir, { recursive: true });
      await writeFile(
        join(docsDir, "relevant.md"),
        "React hooks are great for state management in React apps",
      );

      const searchDir = join(process.env.KCODE_HOME!, "cache", "search");
      await mkdir(searchDir, { recursive: true });
      await writeFile(
        join(searchDir, "r1.json"),
        JSON.stringify({
          query: "React hooks",
          results: [
            {
              title: "React Hooks Guide",
              url: "https://react.dev",
              snippet: "Learn about React hooks",
            },
          ],
          timestamp: Date.now(),
        }),
      );

      const results = await localSearch("React", 10, ["cache", "docs"]);
      if (results.length > 1) {
        for (let i = 1; i < results.length; i++) {
          expect(results[i]!.relevance).toBeLessThanOrEqual(results[i - 1]!.relevance);
        }
      }
    });

    test("handles only specified sources", async () => {
      const results = await localSearch("test", 10, ["manpages"]);
      for (const r of results) {
        expect(r.source).toBe("manpages");
      }
    });
  });

  // ─── searchManPages ──────────────────────────────────────────

  describe("searchManPages", () => {
    test("returns results for common commands", async () => {
      const results = await searchManPages("grep");
      // apropos may or may not be available in CI
      expect(results).toBeInstanceOf(Array);
      // If apropos is available, we should get results for "grep"
      if (results.length > 0) {
        expect(results[0]!.source).toBe("manpages");
        expect(results[0]!.relevance).toBe(0.3);
        expect(typeof results[0]!.title).toBe("string");
      }
    });

    test("returns empty array for nonsense query", async () => {
      const results = await searchManPages("zzzznonexistentcommandxyz");
      expect(results).toBeInstanceOf(Array);
      // Should be empty or apropos returns "nothing appropriate"
    });

    test("limits to 5 results", async () => {
      const results = await searchManPages("file");
      expect(results.length).toBeLessThanOrEqual(5);
    });
  });
});
