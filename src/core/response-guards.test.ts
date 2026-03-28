// KCode - Response Guards Tests
// Tests for: think tag parsing (<thinking>), looksIncomplete(), detectNonShellExpression()

import { describe, test, expect } from "bun:test";
import { createThinkTagParser } from "./think-tag-parser";
import { looksIncomplete } from "./conversation";
import { detectNonShellExpression } from "./safety-analysis";

// ─── Think Tag Parser — <thinking> support ──────────────────────

describe("Think tag parser — <thinking> variant", () => {
  function parse(input: string) {
    const parser = createThinkTagParser();
    const events: Array<{ type: string; text: string }> = [];
    for (const e of parser.feed(input)) events.push(e);
    for (const e of parser.flush()) events.push(e);
    return events;
  }

  function collectByType(events: Array<{ type: string; text: string }>) {
    const thinking = events.filter(e => e.type === "thinking").map(e => e.text).join("");
    const content = events.filter(e => e.type === "content").map(e => e.text).join("");
    return { thinking, content };
  }

  test("extracts <thinking> as thinking event", () => {
    const { thinking, content } = collectByType(parse("Hello <thinking>reasoning here</thinking> answer"));
    expect(thinking).toBe("reasoning here");
    expect(content).toContain("Hello");
    expect(content).toContain("answer");
  });

  test("extracts <think> as thinking event", () => {
    const { thinking, content } = collectByType(parse("<think>thought</think>result"));
    expect(thinking).toBe("thought");
    expect(content).toBe("result");
  });

  test("extracts <reasoning> as thinking event", () => {
    const { thinking, content } = collectByType(parse("<reasoning>analysis</reasoning>done"));
    expect(thinking).toBe("analysis");
    expect(content).toBe("done");
  });

  test("passes through content with no thinking tags", () => {
    const { thinking, content } = collectByType(parse("Just regular text without any tags at all"));
    expect(thinking).toBe("");
    expect(content).toBe("Just regular text without any tags at all");
  });

  test("handles thinking-only content (no visible text)", () => {
    const { thinking, content } = collectByType(parse("<thinking>only internal reasoning</thinking>"));
    expect(thinking).toBe("only internal reasoning");
    expect(content).toBe("");
  });

  test("handles mixed tags in stream", () => {
    const events = parse("a<thinking>b</thinking>c<think>d</think>e");
    const types = events.map(e => e.type);
    const thinkCount = types.filter(t => t === "thinking").length;
    const contentCount = types.filter(t => t === "content").length;
    expect(thinkCount).toBe(2);
    expect(contentCount).toBeGreaterThanOrEqual(2); // may split due to buffering
  });
});

// ─── looksIncomplete — truncation detection ─────────────────────

describe("looksIncomplete", () => {
  // Pad short strings to exceed the 50-char minimum
  const pad = (s: string) => "x".repeat(60) + " " + s;

  test("returns false for short text", () => {
    expect(looksIncomplete("ok")).toBe(false);
  });

  test("returns false for properly ended text", () => {
    expect(looksIncomplete(pad("This response ends properly with a period."))).toBe(false);
  });

  test("detects unclosed code fence", () => {
    expect(looksIncomplete(pad("Here is code:\n```typescript\nconst x = 1;"))).toBe(true);
  });

  test("returns false for closed code fence", () => {
    expect(looksIncomplete(pad("```typescript\nconst x = 1;\n```\nDone."))).toBe(false);
  });

  test("detects open table row", () => {
    expect(looksIncomplete(pad("| Col A | Col B |\n|------|------|\n| val |"))).toBe(true);
  });

  test("detects ending with 'the'", () => {
    expect(looksIncomplete(pad("The analysis provides guarantees for the"))).toBe(true);
  });

  test("detects ending with 'of'", () => {
    expect(looksIncomplete(pad("This is the complete result of"))).toBe(true);
  });

  test("detects ending with 'and'", () => {
    expect(looksIncomplete(pad("We need to check all the files and"))).toBe(true);
  });

  test("detects ending with 'provides'", () => {
    expect(looksIncomplete(pad("The core algorithm provides"))).toBe(true);
  });

  test("detects ending with 'ensures'", () => {
    expect(looksIncomplete(pad("This security mechanism ensures"))).toBe(true);
  });

  test("returns false for text ending with period", () => {
    expect(looksIncomplete(pad("The algorithm works correctly."))).toBe(false);
  });
});

// ─── detectNonShellExpression ───────────────────────────────────

describe("detectNonShellExpression", () => {
  test("returns null for valid shell commands", () => {
    expect(detectNonShellExpression("ls -la")).toBeNull();
    expect(detectNonShellExpression("git status")).toBeNull();
    expect(detectNonShellExpression("echo hello")).toBeNull();
    expect(detectNonShellExpression("npm run build")).toBeNull();
    expect(detectNonShellExpression("cat /etc/hosts | grep localhost")).toBeNull();
    expect(detectNonShellExpression("bun test src/core/*.test.ts")).toBeNull();
  });

  test("detects mathematical Unicode symbols", () => {
    expect(detectNonShellExpression("a × b")).not.toBeNull();
    expect(detectNonShellExpression("x ÷ y")).not.toBeNull();
    expect(detectNonShellExpression("n ≤ 100")).not.toBeNull();
    expect(detectNonShellExpression("∑(values)")).not.toBeNull();
    expect(detectNonShellExpression("x ≈ y")).not.toBeNull();
  });

  test("detects bare identifier comparisons", () => {
    expect(detectNonShellExpression("compactThreshold < currentTokens")).not.toBeNull();
    expect(detectNonShellExpression("maxRetries >= attempts")).not.toBeNull();
    expect(detectNonShellExpression("count == limit")).not.toBeNull();
  });

  test("detects symbolic multiplication", () => {
    expect(detectNonShellExpression("compactThreshold × contextWindowSize")).not.toBeNull();
  });

  test("detects PascalCase function calls", () => {
    expect(detectNonShellExpression("CalculateScore(input)")).not.toBeNull();
    expect(detectNonShellExpression("ProcessData(x, y)")).not.toBeNull();
  });

  test("allows PowerShell-like commands", () => {
    expect(detectNonShellExpression("Test something")).toBeNull();
    expect(detectNonShellExpression("Install package")).toBeNull();
  });

  test("returns null for empty/whitespace", () => {
    expect(detectNonShellExpression("")).toBeNull();
    expect(detectNonShellExpression("   ")).toBeNull();
  });

  test("does not false-positive on paths with slashes", () => {
    expect(detectNonShellExpression("cat /usr/local/bin/kcode")).toBeNull();
  });
});
