// KCode - Ensemble Merger Tests

import { describe, expect, test } from "bun:test";
import { extractSections, llmMerge, mergeSections, scoreSection } from "./merger";
import type { CandidateResponse, ModelExecutor } from "./types";

// ─── Helpers ────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<CandidateResponse> = {}): CandidateResponse {
  return {
    model: "test-model",
    response: "Default test response.",
    tokensUsed: 50,
    durationMs: 100,
    ...overrides,
  };
}

// ─── extractSections ────────────────────────────────────────────

describe("extractSections", () => {
  test("extracts markdown heading-based sections", () => {
    const response = [
      "# Introduction",
      "This is the intro.",
      "## Details",
      "Here are the details.",
      "## Conclusion",
      "Final thoughts.",
    ].join("\n");

    const sections = extractSections(response, "model-a");
    expect(sections.length).toBeGreaterThanOrEqual(3);
    expect(sections.some((s) => s.heading === "Introduction")).toBe(true);
    expect(sections.some((s) => s.heading === "Details")).toBe(true);
    expect(sections.every((s) => s.source === "model-a")).toBe(true);
  });

  test("falls back to paragraph splitting when no headings", () => {
    const response = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const sections = extractSections(response, "model-b");
    expect(sections.length).toBe(3);
    expect(sections[0]!.heading).toBe("section-1");
    expect(sections[0]!.content).toBe("First paragraph.");
  });

  test("handles empty response", () => {
    const sections = extractSections("", "model-c");
    expect(sections.length).toBe(0);
  });

  test("includes preamble before first heading", () => {
    const response = "Some preamble text.\n# First Section\nContent here.";
    const sections = extractSections(response, "model-d");
    expect(sections[0]!.heading).toBe("introduction");
    expect(sections[0]!.content).toBe("Some preamble text.");
  });
});

// ─── scoreSection ───────────────────────────────────────────────

describe("scoreSection", () => {
  test("gives higher score to longer sections", () => {
    const short = { heading: "test", content: "hi", source: "m" };
    const long = { heading: "test", content: "a".repeat(300), source: "m" };
    expect(scoreSection(long)).toBeGreaterThan(scoreSection(short));
  });

  test("gives bonus for code blocks", () => {
    const withCode = {
      heading: "test",
      content: "Here is code:\n```typescript\nconst x = 1;\n```",
      source: "m",
    };
    const withoutCode = {
      heading: "test",
      content: "Here is a description of the code approach.",
      source: "m",
    };
    expect(scoreSection(withCode)).toBeGreaterThan(scoreSection(withoutCode));
  });

  test("gives bonus for concrete examples", () => {
    const withExample = {
      heading: "test",
      content: "For example, you can use the map function.",
      source: "m",
    };
    const withoutExample = {
      heading: "test",
      content: "You can use the map function.",
      source: "m",
    };
    expect(scoreSection(withExample)).toBeGreaterThan(scoreSection(withoutExample));
  });

  test("penalizes filler language", () => {
    const filler = {
      heading: "test",
      content: "It is basically just a simple approach really.",
      source: "m",
    };
    const clean = {
      heading: "test",
      content: "It is a proven robust approach for this.",
      source: "m",
    };
    expect(scoreSection(clean)).toBeGreaterThan(scoreSection(filler));
  });
});

// ─── mergeSections ──────────────────────────────────────────────

describe("mergeSections", () => {
  test("merges structured responses by picking best sections", () => {
    const candidates: CandidateResponse[] = [
      makeCandidate({
        model: "model-a",
        response:
          "# Setup\nBasic setup.\n\n# Usage\nFor example, use `map()` to transform arrays with code:\n```js\narr.map(x => x * 2)\n```",
      }),
      makeCandidate({
        model: "model-b",
        response:
          "# Setup\nDetailed setup with step-by-step instructions and configuration.\n\n# Usage\nJust use it.",
      }),
    ];

    const result = mergeSections(candidates);
    expect(result.strategy).toBe("merge");
    expect(result.finalResponse.length).toBeGreaterThan(0);
    expect(result.reasoning).toContain("Merged best sections");
  });

  test("falls back to best overall when no structured sections", () => {
    const candidates: CandidateResponse[] = [
      makeCandidate({ model: "a", response: "Short." }),
      makeCandidate({ model: "b", response: "A much more detailed and comprehensive response." }),
    ];

    const result = mergeSections(candidates);
    expect(result.strategy).toBe("merge");
    expect(result.reasoning).toContain("most substantive");
  });

  test("includes candidates with scores in result", () => {
    const candidates: CandidateResponse[] = [
      makeCandidate({ model: "a", response: "# Intro\nHello\n\n# Body\nWorld" }),
      makeCandidate({ model: "b", response: "# Intro\nHi there\n\n# Body\nDetailed body" }),
    ];

    const result = mergeSections(candidates);
    expect(result.candidates.length).toBe(2);
    for (const c of result.candidates) {
      expect(typeof c.score).toBe("number");
    }
  });
});

// ─── llmMerge ───────────────────────────────────────────────────

describe("llmMerge", () => {
  test("uses executor to produce merged response", async () => {
    const candidates: CandidateResponse[] = [
      makeCandidate({ model: "a", response: "Answer A" }),
      makeCandidate({ model: "b", response: "Answer B" }),
    ];

    const executor: ModelExecutor = {
      execute: async () => ({
        content: "Combined answer from A and B.",
        tokensUsed: 30,
        durationMs: 200,
      }),
    };

    const result = await llmMerge(
      candidates,
      [{ role: "user", content: "What is X?" }],
      "merge-model",
      executor,
    );

    expect(result.finalResponse).toBe("Combined answer from A and B.");
    expect(result.strategy).toBe("merge");
    expect(result.reasoning).toContain("LLM-merged");
  });

  test("falls back to section-based merge on executor failure", async () => {
    const candidates: CandidateResponse[] = [
      makeCandidate({ model: "a", response: "Short." }),
      makeCandidate({ model: "b", response: "A longer and more detailed response here." }),
    ];

    const failingExecutor: ModelExecutor = {
      execute: async () => {
        throw new Error("Merge model failed");
      },
    };

    const result = await llmMerge(
      candidates,
      [{ role: "user", content: "test" }],
      "merge-model",
      failingExecutor,
    );

    // Should fall back to section-based merge
    expect(result.strategy).toBe("merge");
    expect(result.finalResponse.length).toBeGreaterThan(0);
  });

  test("assigns 0.5 score to all candidates for LLM merge", async () => {
    const candidates: CandidateResponse[] = [
      makeCandidate({ model: "a", response: "X" }),
      makeCandidate({ model: "b", response: "Y" }),
    ];

    const executor: ModelExecutor = {
      execute: async () => ({ content: "merged", tokensUsed: 5, durationMs: 50 }),
    };

    const result = await llmMerge(candidates, [{ role: "user", content: "q" }], "judge", executor);

    for (const c of result.candidates) {
      expect(c.score).toBe(0.5);
    }
  });
});
