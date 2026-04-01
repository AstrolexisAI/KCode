import { describe, expect, test } from "bun:test";
import { DEFAULT_RERANKER_CONFIG, getFileAge, pathProximity, rerank } from "./reranker";
import type { RerankerConfig, SearchResult } from "./types";

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    chunkId: overrides.chunkId ?? "c1",
    filePath: overrides.filePath ?? "/project/src/test.ts",
    relativePath: overrides.relativePath ?? "src/test.ts",
    name: overrides.name ?? "testFunc",
    type: overrides.type ?? "function",
    content: overrides.content ?? "function testFunc() {}",
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 3,
    similarity: overrides.similarity ?? 0.8,
    tokenEstimate: overrides.tokenEstimate ?? 10,
  };
}

describe("reranker", () => {
  // ─── Rerank ──────────────────────────────────────────────────

  test("rerank preserves order when all signals are equal", () => {
    const results = [
      makeResult({ chunkId: "c1", similarity: 0.9 }),
      makeResult({ chunkId: "c2", similarity: 0.5 }),
    ];

    const reranked = rerank(results, {
      sessionFiles: [],
      queryType: "code",
    });

    expect(reranked[0]!.chunkId).toBe("c1");
    expect(reranked[1]!.chunkId).toBe("c2");
  });

  test("rerank boosts results near current file", () => {
    const results = [
      makeResult({ chunkId: "far", filePath: "/project/other/deep/file.ts", similarity: 0.8 }),
      makeResult({ chunkId: "near", filePath: "/project/src/nearby.ts", similarity: 0.8 }),
    ];

    const reranked = rerank(results, {
      currentFile: "/project/src/test.ts",
      sessionFiles: [],
      queryType: "code",
    });

    // The nearby file should be boosted
    const nearIdx = reranked.findIndex((r) => r.chunkId === "near");
    const farIdx = reranked.findIndex((r) => r.chunkId === "far");
    expect(nearIdx).toBeLessThanOrEqual(farIdx);
  });

  test("rerank boosts frequently accessed session files", () => {
    const results = [
      makeResult({ chunkId: "rare", filePath: "/project/rare.ts", similarity: 0.8 }),
      makeResult({ chunkId: "freq", filePath: "/project/frequent.ts", similarity: 0.8 }),
    ];

    const reranked = rerank(results, {
      sessionFiles: [
        "/project/frequent.ts",
        "/project/frequent.ts",
        "/project/frequent.ts",
        "/project/frequent.ts",
        "/project/frequent.ts",
      ],
      queryType: "code",
    });

    const freqIdx = reranked.findIndex((r) => r.chunkId === "freq");
    const rareIdx = reranked.findIndex((r) => r.chunkId === "rare");
    expect(freqIdx).toBeLessThan(rareIdx);
  });

  test("rerank applies type boost for code queries", () => {
    const results = [
      makeResult({ chunkId: "block", type: "block", similarity: 0.8 }),
      makeResult({ chunkId: "func", type: "function", similarity: 0.8 }),
    ];

    const reranked = rerank(results, {
      sessionFiles: [],
      queryType: "code",
    });

    expect(reranked[0]!.chunkId).toBe("func");
  });

  test("rerank does not apply type boost for non-code queries", () => {
    const results = [
      makeResult({ chunkId: "block", type: "block", similarity: 0.9 }),
      makeResult({ chunkId: "func", type: "function", similarity: 0.8 }),
    ];

    const reranked = rerank(results, {
      sessionFiles: [],
      queryType: "explanation",
    });

    // Without type boost, the block (0.9) should rank higher
    expect(reranked[0]!.chunkId).toBe("block");
  });

  test("rerank with custom weights", () => {
    const config: RerankerConfig = {
      weights: {
        semantic: 1.0,
        recency: 0.0,
        frequency: 0.0,
        proximity: 0.0,
        typeBoost: 0.0,
      },
    };

    const results = [
      makeResult({ chunkId: "c1", similarity: 0.5 }),
      makeResult({ chunkId: "c2", similarity: 0.9 }),
    ];

    const reranked = rerank(results, { sessionFiles: [], queryType: "code" }, config);
    expect(reranked[0]!.chunkId).toBe("c2");
  });

  test("rerank handles empty results", () => {
    const reranked = rerank([], { sessionFiles: [], queryType: "code" });
    expect(reranked).toEqual([]);
  });

  test("rerank does not mutate input array", () => {
    const results = [
      makeResult({ chunkId: "c1", similarity: 0.5 }),
      makeResult({ chunkId: "c2", similarity: 0.9 }),
    ];
    const original = [...results];

    rerank(results, { sessionFiles: [], queryType: "code" });

    expect(results[0]!.similarity).toBe(original[0]!.similarity);
    expect(results[1]!.similarity).toBe(original[1]!.similarity);
  });
});

// ─── pathProximity Tests ───────────────────────────────────────

describe("pathProximity", () => {
  test("same directory returns 1.0", () => {
    expect(pathProximity("/a/b/c.ts", "/a/b/d.ts")).toBe(1.0);
  });

  test("parent-child returns 0.7", () => {
    expect(pathProximity("/a/b/c.ts", "/a/b/sub/d.ts")).toBe(0.7);
  });

  test("distant paths return 0.0", () => {
    expect(pathProximity("/project/src/a.ts", "/other/lib/b.ts")).toBe(0.0);
  });
});

// ─── getFileAge Tests ──────────────────────────────────────────

describe("getFileAge", () => {
  test("non-existent file returns Infinity", () => {
    expect(getFileAge("/nonexistent/path/file.ts")).toBe(Infinity);
  });

  test("existing file returns positive number", () => {
    // This test file itself should exist
    const age = getFileAge(import.meta.path);
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(Infinity);
  });
});
