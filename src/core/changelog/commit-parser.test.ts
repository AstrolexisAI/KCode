// KCode - Commit Parser Tests

import { describe, expect, test } from "bun:test";
import { classifyCommit, parseConventionalCommit } from "./commit-parser";

describe("parseConventionalCommit", () => {
  test("parses feat with scope", () => {
    const result = parseConventionalCommit("feat(auth): add JWT login");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("feat");
    expect(result!.scope).toBe("auth");
    expect(result!.description).toBe("add JWT login");
    expect(result!.breaking).toBe(false);
  });

  test("parses fix without scope", () => {
    const result = parseConventionalCommit("fix: resolve null pointer");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("fix");
    expect(result!.scope).toBeUndefined();
    expect(result!.description).toBe("resolve null pointer");
  });

  test("parses breaking change with bang", () => {
    const result = parseConventionalCommit("feat!: remove deprecated API");
    expect(result).not.toBeNull();
    expect(result!.breaking).toBe(true);
  });

  test("parses breaking change with scope and bang", () => {
    const result = parseConventionalCommit("refactor(core)!: rewrite engine");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("refactor");
    expect(result!.scope).toBe("core");
    expect(result!.breaking).toBe(true);
  });

  test("returns null for non-conventional commit", () => {
    expect(parseConventionalCommit("Update README")).toBeNull();
    expect(parseConventionalCommit("Bump version to 1.2.0")).toBeNull();
    expect(parseConventionalCommit("WIP")).toBeNull();
  });

  test("handles all standard types", () => {
    for (const type of [
      "feat",
      "fix",
      "docs",
      "refactor",
      "test",
      "chore",
      "perf",
      "style",
      "ci",
      "build",
    ] as const) {
      const result = parseConventionalCommit(`${type}: something`);
      expect(result).not.toBeNull();
      expect(result!.type).toBe(type);
    }
  });

  test("unknown type defaults to chore", () => {
    const result = parseConventionalCommit("yolo: whatever");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("chore");
  });

  test("trims description whitespace", () => {
    const result = parseConventionalCommit("feat:   add feature  ");
    expect(result).not.toBeNull();
    expect(result!.description).toBe("add feature");
  });
});

describe("classifyCommit", () => {
  test("classifies fix-like messages", () => {
    expect(classifyCommit("Fix login bug").type).toBe("fix");
    expect(classifyCommit("fix crash on startup").type).toBe("fix");
    expect(classifyCommit("Patch memory leak").type).toBe("fix");
  });

  test("classifies feature-like messages", () => {
    expect(classifyCommit("Add dark mode").type).toBe("feat");
    expect(classifyCommit("Implement search feature").type).toBe("feat");
  });

  test("classifies refactor-like messages", () => {
    expect(classifyCommit("Refactor auth module").type).toBe("refactor");
    expect(classifyCommit("Cleanup old code").type).toBe("refactor");
  });

  test("classifies docs-like messages", () => {
    expect(classifyCommit("Update README").type).toBe("docs");
    expect(classifyCommit("Documentation fixes").type).toBe("docs");
  });

  test("classifies test-like messages", () => {
    expect(classifyCommit("Test coverage improvements").type).toBe("test");
  });

  test("classifies perf-like messages", () => {
    expect(classifyCommit("Optimize database queries").type).toBe("perf");
  });

  test("defaults to chore for unknown messages", () => {
    expect(classifyCommit("Merge branch main").type).toBe("chore");
    expect(classifyCommit("WIP").type).toBe("chore");
  });

  test("detects breaking changes", () => {
    expect(classifyCommit("BREAKING CHANGE: remove old API").breaking).toBe(true);
  });
});
