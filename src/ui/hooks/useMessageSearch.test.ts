// KCode - useMessageSearch pure function tests
// Tests extractText and findMatches without React

import { describe, expect, test } from "bun:test";
import type { MessageEntry } from "../components/MessageList";
import { extractText, findMatches } from "./useMessageSearch";

// ─── Helpers ────────────────────────────────────────────────────

function textEntry(role: "user" | "assistant", text: string): MessageEntry {
  return { kind: "text", role, text };
}

function toolUseEntry(name: string, summary: string): MessageEntry {
  return { kind: "tool_use", name, summary };
}

function toolResultEntry(name: string, result: string): MessageEntry {
  return { kind: "tool_result", name, result };
}

function thinkingEntry(text: string): MessageEntry {
  return { kind: "thinking", text };
}

function bannerEntry(title: string, subtitle: string): MessageEntry {
  return { kind: "banner", title, subtitle };
}

function learnEntry(text: string): MessageEntry {
  return { kind: "learn", text };
}

// ─── extractText ────────────────────────────────────────────────

describe("extractText", () => {
  test("extracts text from text entries", () => {
    expect(extractText(textEntry("user", "Hello world"))).toBe("Hello world");
    expect(extractText(textEntry("assistant", "Hi there"))).toBe("Hi there");
  });

  test("extracts text from tool use entries", () => {
    expect(extractText(toolUseEntry("Read", "/path/to/file"))).toBe("Read /path/to/file");
  });

  test("extracts text from tool result entries", () => {
    expect(extractText(toolResultEntry("Bash", "output here"))).toBe("Bash output here");
  });

  test("extracts text from thinking entries", () => {
    expect(extractText(thinkingEntry("Let me think..."))).toBe("Let me think...");
  });

  test("extracts text from banner entries", () => {
    expect(extractText(bannerEntry("KCode", "v1.0"))).toBe("KCode v1.0");
  });

  test("extracts text from learn entries", () => {
    expect(extractText(learnEntry("learned something"))).toBe("learned something");
  });

  test("extracts text from suggestion entries", () => {
    const entry: MessageEntry = {
      kind: "suggestion",
      suggestions: [
        { type: "test", message: "Run tests", priority: "high" },
        { type: "commit", message: "Commit changes", priority: "low" },
      ],
    };
    expect(extractText(entry)).toBe("Run tests Commit changes");
  });

  test("extracts text from plan entries", () => {
    const entry: MessageEntry = {
      kind: "plan",
      title: "My Plan",
      steps: [
        { id: "1", title: "Step one", status: "done" },
        { id: "2", title: "Step two", status: "pending" },
      ],
    };
    expect(extractText(entry)).toBe("My Plan Step one Step two");
  });

  test("extracts text from diff entries", () => {
    const entry: MessageEntry = {
      kind: "diff",
      filePath: "src/index.ts",
      hunks: "+added line\n-removed line",
    };
    expect(extractText(entry)).toContain("src/index.ts");
    expect(extractText(entry)).toContain("+added line");
  });

  test("extracts text from partial_progress entries", () => {
    const entry: MessageEntry = {
      kind: "partial_progress",
      toolsUsed: 5,
      elapsedMs: 1000,
      filesModified: ["a.ts", "b.ts"],
      summary: "Working on it",
    };
    expect(extractText(entry)).toContain("Working on it");
    expect(extractText(entry)).toContain("a.ts");
  });

  test("extracts text from incomplete_response entries", () => {
    const entry: MessageEntry = {
      kind: "incomplete_response",
      continuations: 2,
      stopReason: "max_tokens",
    };
    expect(extractText(entry)).toBe("max_tokens");
  });
});

// ─── findMatches ────────────────────────────────────────────────

describe("findMatches", () => {
  test("returns empty for empty query", () => {
    const messages = [textEntry("user", "hello")];
    expect(findMatches(messages, "", new Map())).toEqual([]);
  });

  test("returns empty for no messages", () => {
    expect(findMatches([], "hello", new Map())).toEqual([]);
  });

  test("finds single match", () => {
    const messages = [textEntry("user", "Hello world")];
    const matches = findMatches(messages, "hello", new Map());
    expect(matches).toHaveLength(1);
    expect(matches[0]!.messageIndex).toBe(0);
    expect(matches[0]!.charOffset).toBe(0);
  });

  test("case insensitive search", () => {
    const messages = [textEntry("assistant", "Hello World")];
    const matches = findMatches(messages, "HELLO", new Map());
    expect(matches).toHaveLength(1);
  });

  test("finds matches across multiple messages", () => {
    const messages = [
      textEntry("user", "find the needle"),
      textEntry("assistant", "no match here"),
      textEntry("user", "another needle here"),
    ];
    const matches = findMatches(messages, "needle", new Map());
    expect(matches).toHaveLength(2);
    expect(matches[0]!.messageIndex).toBe(0);
    expect(matches[1]!.messageIndex).toBe(2);
  });

  test("finds multiple matches in same message", () => {
    const messages = [textEntry("assistant", "foo bar foo baz foo")];
    const matches = findMatches(messages, "foo", new Map());
    expect(matches).toHaveLength(3);
    expect(matches[0]!.charOffset).toBe(0);
    expect(matches[1]!.charOffset).toBe(8);
    expect(matches[2]!.charOffset).toBe(16);
  });

  test("searches tool entries", () => {
    const messages = [
      toolUseEntry("Read", "/home/user/file.txt"),
      toolResultEntry("Read", "file contents here"),
    ];
    const matches = findMatches(messages, "file", new Map());
    expect(matches).toHaveLength(2);
  });

  test("no matches returns empty array", () => {
    const messages = [textEntry("user", "hello"), textEntry("assistant", "world")];
    const matches = findMatches(messages, "xyz", new Map());
    expect(matches).toHaveLength(0);
  });

  test("uses and populates text cache", () => {
    const cache = new Map<number, string>();
    const messages = [textEntry("user", "Hello World")];

    findMatches(messages, "hello", cache);

    // Cache should now have the lowercased text
    expect(cache.get(0)).toBe("hello world");

    // Second search should use cache
    const matches = findMatches(messages, "world", cache);
    expect(matches).toHaveLength(1);
  });

  test("respects existing cache entries", () => {
    const cache = new Map<number, string>();
    cache.set(0, "cached text");

    const messages = [textEntry("user", "Original text")];
    // Should use cache, not the actual message text
    const matches = findMatches(messages, "cached", cache);
    expect(matches).toHaveLength(1);
  });

  test("handles special regex characters in query", () => {
    const messages = [textEntry("user", "file.txt (copy)")];
    // indexOf doesn't use regex, so special chars are literal
    const matches = findMatches(messages, "file.txt", new Map());
    expect(matches).toHaveLength(1);

    const matches2 = findMatches(messages, "(copy)", new Map());
    expect(matches2).toHaveLength(1);
  });

  test("performance: 2000 messages under 16ms", () => {
    const messages: MessageEntry[] = [];
    for (let i = 0; i < 2000; i++) {
      messages.push(textEntry("user", `Message number ${i} with some text content for searching`));
    }

    const cache = new Map<number, string>();
    const start = performance.now();
    findMatches(messages, "number", cache);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(16);
  });
});
