// Tests for DiffViewer tool — file and git diffs
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffViewerDefinition, executeDiffViewer } from "./diff-viewer";

const testDir = join(tmpdir(), `kcode-diff-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("diffViewerDefinition", () => {
  test("has correct name", () => {
    expect(diffViewerDefinition.name).toBe("DiffView");
  });
});

describe("executeDiffViewer — files mode", () => {
  test("rejects missing file_a", async () => {
    const result = await executeDiffViewer({ mode: "files", file_b: "x" });
    expect(result.is_error).toBe(true);
  });

  test("rejects missing file_b in files mode", async () => {
    const result = await executeDiffViewer({ mode: "files", file_a: "x" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("file_b");
  });

  test("reports error for non-existent files", async () => {
    const result = await executeDiffViewer({
      mode: "files",
      file_a: join(testDir, "nonexistent-a.txt"),
      file_b: join(testDir, "nonexistent-b.txt"),
    });
    expect(result.is_error).toBe(true);
  });

  test("reports identical files", async () => {
    const f1 = join(testDir, "same1.txt");
    const f2 = join(testDir, "same2.txt");
    writeFileSync(f1, "identical\ncontent\n");
    writeFileSync(f2, "identical\ncontent\n");
    const result = await executeDiffViewer({ mode: "files", file_a: f1, file_b: f2 });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("identical");
  });

  test("generates diff for different files", async () => {
    const f1 = join(testDir, "v1.txt");
    const f2 = join(testDir, "v2.txt");
    writeFileSync(f1, "line1\nline2\nline3\n");
    writeFileSync(f2, "line1\nline2 modified\nline3\n");
    const result = await executeDiffViewer({ mode: "files", file_a: f1, file_b: f2 });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("Diff:");
    expect(result.content).toMatch(/\+1/); // 1 added
    expect(result.content).toMatch(/-1/); // 1 removed
  });

  test("shows line counts", async () => {
    const f1 = join(testDir, "small.txt");
    const f2 = join(testDir, "large.txt");
    writeFileSync(f1, "a\nb\n");
    writeFileSync(f2, "a\nb\nc\nd\ne\n");
    const result = await executeDiffViewer({ mode: "files", file_a: f1, file_b: f2 });
    expect(result.content).toContain("3 lines");
    expect(result.content).toContain("6 lines");
  });
});

describe("executeDiffViewer — git mode (default)", () => {
  test("rejects file paths with shell metacharacters", async () => {
    const result = await executeDiffViewer({ file_a: "file; rm -rf /" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("invalid characters");
  });

  test("rejects backtick injection", async () => {
    const result = await executeDiffViewer({ file_a: "file`whoami`.txt" });
    expect(result.is_error).toBe(true);
  });

  test("rejects pipe injection", async () => {
    const result = await executeDiffViewer({ file_a: "file | cat /etc/passwd" });
    expect(result.is_error).toBe(true);
  });
});
