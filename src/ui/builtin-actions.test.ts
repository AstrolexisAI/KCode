// Tests for summarizeInput — extracts brief UI summaries from tool inputs
import { describe, expect, test } from "bun:test";
import { summarizeInput } from "./builtin-actions";

describe("summarizeInput", () => {
  test("Bash shows truncated command (80 chars)", () => {
    expect(summarizeInput("Bash", { command: "ls -la" })).toBe("ls -la");
    const long = "a".repeat(100);
    expect(summarizeInput("Bash", { command: long }).length).toBe(80);
  });

  test("Read/Write/Edit show file path", () => {
    expect(summarizeInput("Read", { file_path: "/home/src/app.ts" })).toBe("/home/src/app.ts");
    expect(summarizeInput("Write", { file_path: "/tmp/x.md" })).toBe("/tmp/x.md");
    expect(summarizeInput("Edit", { file_path: "/a/b/c.ts" })).toBe("/a/b/c.ts");
  });

  test("Glob shows pattern", () => {
    expect(summarizeInput("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
  });

  test("Grep shows pattern", () => {
    expect(summarizeInput("Grep", { pattern: "TODO|FIXME" })).toBe("TODO|FIXME");
  });

  test("Agent shows description", () => {
    expect(summarizeInput("Agent", { description: "audit codebase" })).toBe("audit codebase");
  });

  test("WebFetch truncates URL (60 chars)", () => {
    const long = "https://example.com/" + "x".repeat(100);
    expect(summarizeInput("WebFetch", { url: long }).length).toBe(60);
  });

  test("WebSearch truncates query (60 chars)", () => {
    const long = "find " + "a".repeat(100);
    expect(summarizeInput("WebSearch", { query: long }).length).toBe(60);
  });

  test("TestRunner shows file or 'all tests'", () => {
    expect(summarizeInput("TestRunner", { file: "src/foo.test.ts" })).toBe("src/foo.test.ts");
    expect(summarizeInput("TestRunner", {})).toBe("all tests");
  });

  test("Rename shows 'old → new'", () => {
    expect(summarizeInput("Rename", { symbol: "oldName", new_name: "newName" })).toBe(
      "oldName → newName",
    );
  });

  test("Clipboard truncates text (40 chars)", () => {
    const long = "x".repeat(100);
    expect(summarizeInput("Clipboard", { text: long }).length).toBe(40);
  });

  test("GitStatus has no summary", () => {
    expect(summarizeInput("GitStatus", {})).toBe("");
  });

  test("GitCommit shows commit message (60 chars)", () => {
    expect(summarizeInput("GitCommit", { message: "fix bug" })).toBe("fix bug");
    const long = "feat: " + "x".repeat(100);
    expect(summarizeInput("GitCommit", { message: long }).length).toBe(60);
  });

  test("GitLog shows file or count", () => {
    expect(summarizeInput("GitLog", { file: "src/a.ts" })).toBe("src/a.ts");
    expect(summarizeInput("GitLog", { count: 20 })).toBe("last 20");
    expect(summarizeInput("GitLog", {})).toBe("last 10");
  });

  test("GrepReplace shows pattern → replacement", () => {
    expect(
      summarizeInput("GrepReplace", { pattern: "foo", replacement: "bar" }),
    ).toBe("foo → bar");
  });

  test("Stash shows action and optional name", () => {
    expect(summarizeInput("Stash", { action: "save", name: "wip" })).toBe("save wip");
    expect(summarizeInput("Stash", { action: "list" })).toBe("list");
  });

  test("AskUser truncates question (60 chars)", () => {
    const long = "Should I " + "x".repeat(100);
    expect(summarizeInput("AskUser", { question: long }).length).toBe(60);
  });

  test("LSP shows action + file", () => {
    expect(
      summarizeInput("LSP", { action: "definition", file: "a.ts" }),
    ).toBe("definition a.ts");
  });

  test("ToolSearch truncates query (60 chars)", () => {
    const long = "find " + "y".repeat(100);
    expect(summarizeInput("ToolSearch", { query: long }).length).toBe(60);
  });

  test("unknown tool returns empty string", () => {
    expect(summarizeInput("UnknownTool", { foo: "bar" })).toBe("");
  });

  test("handles missing fields gracefully", () => {
    expect(summarizeInput("Bash", {})).toBe("");
    expect(summarizeInput("Read", {})).toBe("");
    expect(summarizeInput("Grep", {})).toBe("");
  });
});
