import { describe, test, expect } from "bun:test";
import {
  stringSimilarity,
  extractTitlesFromIndex,
  filterMemories,
} from "./relevance-filter";
import type { ExtractedMemory, AutoMemoryConfig } from "./types";
import { DEFAULT_AUTO_MEMORY_CONFIG } from "./types";

// ─── stringSimilarity ───────────────────────────────────────────

describe("stringSimilarity", () => {
  test("identical strings return 1.0", () => {
    expect(stringSimilarity("hello", "hello")).toBe(1.0);
  });

  test("case insensitive comparison", () => {
    expect(stringSimilarity("Hello", "hello")).toBe(1.0);
  });

  test("completely different strings return low similarity", () => {
    const sim = stringSimilarity("abc", "xyz");
    expect(sim).toBeLessThan(0.5);
  });

  test("similar strings return high similarity", () => {
    const sim = stringSimilarity("No mocks in tests", "No mocks in test");
    expect(sim).toBeGreaterThan(0.9);
  });

  test("empty strings return 0", () => {
    expect(stringSimilarity("", "hello")).toBe(0.0);
    expect(stringSimilarity("hello", "")).toBe(0.0);
    expect(stringSimilarity("", "")).toBe(1.0);
  });

  test("handles whitespace trimming", () => {
    expect(stringSimilarity("  hello  ", "hello")).toBe(1.0);
  });
});

// ─── extractTitlesFromIndex ─────────────────────────────────────

describe("extractTitlesFromIndex", () => {
  test("extracts titles from standard format", () => {
    const index = `# Memory Index

- [User Profile](user_curly.md) -- Curly: KCode lead dev
- [KCode Roadmap](project_kcode_roadmap.md) -- External audit roadmap
`;
    const titles = extractTitlesFromIndex(index);
    expect(titles).toEqual(["User Profile", "KCode Roadmap"]);
  });

  test("handles em-dash separator", () => {
    const index = `- [My Title](file.md) — Some description`;
    const titles = extractTitlesFromIndex(index);
    expect(titles).toEqual(["My Title"]);
  });

  test("handles null input", () => {
    expect(extractTitlesFromIndex(null)).toEqual([]);
  });

  test("handles empty string", () => {
    expect(extractTitlesFromIndex("")).toEqual([]);
  });

  test("ignores lines without links", () => {
    const index = `# Memory Index

Some random text
- Not a link
- [Valid Title](file.md) -- description
Another line
`;
    const titles = extractTitlesFromIndex(index);
    expect(titles).toEqual(["Valid Title"]);
  });

  test("handles multiple entries", () => {
    const index = `- [A](a.md) -- desc a
- [B](b.md) -- desc b
- [C](c.md) -- desc c`;
    expect(extractTitlesFromIndex(index)).toHaveLength(3);
  });
});

// ─── filterMemories ─────────────────────────────────────────────

describe("filterMemories", () => {
  const defaultConfig: AutoMemoryConfig = { ...DEFAULT_AUTO_MEMORY_CONFIG };

  function makeMemory(overrides: Partial<ExtractedMemory> = {}): ExtractedMemory {
    return {
      type: "user",
      title: "Test Memory",
      description: "A test memory",
      content: "Some content here",
      confidence: 0.9,
      ...overrides,
    };
  }

  test("accepts memory above confidence threshold", () => {
    const result = filterMemories([makeMemory({ confidence: 0.8 })], [], defaultConfig);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  test("rejects memory below confidence threshold", () => {
    const result = filterMemories([makeMemory({ confidence: 0.5 })], [], defaultConfig);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toContain("confidence");
  });

  test("respects custom minConfidence", () => {
    const config = { ...defaultConfig, minConfidence: 0.9 };
    const result = filterMemories([makeMemory({ confidence: 0.85 })], [], config);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]!.reason).toContain("confidence");
  });

  test("filters excluded types", () => {
    const config = { ...defaultConfig, excludeTypes: ["project" as const] };
    const result = filterMemories([makeMemory({ type: "project" })], [], config);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]!.reason).toContain("excluded");
  });

  test("detects duplicate titles via fuzzy match", () => {
    const existing = ["User Profile"];
    const result = filterMemories([makeMemory({ title: "User Profile" })], existing, defaultConfig);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]!.reason).toContain("duplicate");
    expect(result.rejected[0]!.matchedTitle).toBe("User Profile");
  });

  test("detects near-duplicate titles", () => {
    const existing = ["No mocks in tests"];
    const result = filterMemories(
      [makeMemory({ title: "No mocks in test" })],
      existing,
      defaultConfig,
    );
    // Similarity 0.94 is above 0.85 threshold
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]!.reason).toContain("duplicate");
  });

  test("allows sufficiently different titles", () => {
    const existing = ["User Profile"];
    const result = filterMemories(
      [makeMemory({ title: "Project Deployment Notes" })],
      existing,
      defaultConfig,
    );
    expect(result.accepted).toHaveLength(1);
  });

  test("enforces maxPerTurn limit", () => {
    const config = { ...defaultConfig, maxPerTurn: 2 };
    const memories = [
      makeMemory({ title: "Memory A", confidence: 0.7 }),
      makeMemory({ title: "Memory B", confidence: 0.9 }),
      makeMemory({ title: "Memory C", confidence: 0.8 }),
    ];
    const result = filterMemories(memories, [], config);
    expect(result.accepted).toHaveLength(2);
    // Should keep highest confidence
    expect(result.accepted[0]!.title).toBe("Memory B");
    expect(result.accepted[1]!.title).toBe("Memory C");
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toContain("maxPerTurn");
  });

  test("handles empty input gracefully", () => {
    const result = filterMemories([], [], defaultConfig);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });

  test("handles empty MEMORY.md (no existing titles)", () => {
    const result = filterMemories(
      [makeMemory({ title: "Brand New Memory" })],
      [],
      defaultConfig,
    );
    expect(result.accepted).toHaveLength(1);
  });

  test("multiple filters combine correctly", () => {
    const config: AutoMemoryConfig = {
      ...defaultConfig,
      minConfidence: 0.7,
      excludeTypes: ["reference"],
      maxPerTurn: 2,
    };
    const existing = ["Existing Memory"];
    const memories = [
      makeMemory({ title: "Low Confidence", confidence: 0.5 }),          // rejected: confidence
      makeMemory({ title: "Reference Link", type: "reference" }),        // rejected: excluded type
      makeMemory({ title: "Existing Memory", confidence: 0.9 }),         // rejected: duplicate
      makeMemory({ title: "Valid Memory 1", confidence: 0.8 }),          // accepted
      makeMemory({ title: "Valid Memory 2", confidence: 0.9 }),          // accepted
      makeMemory({ title: "Valid Memory 3", confidence: 0.75 }),         // rejected: maxPerTurn
    ];
    const result = filterMemories(memories, existing, config);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(4);
  });
});
