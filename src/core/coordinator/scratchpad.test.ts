import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Scratchpad } from "./scratchpad";

let tempDir: string;

describe("Scratchpad", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-scratchpad-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Constructor ─────────────────────────────────────────────

  test("creates scratchpad directory on construction", () => {
    const sp = new Scratchpad("test-session-1", tempDir);
    expect(existsSync(join(tempDir, "test-session-1"))).toBe(true);
  });

  test("does not fail if directory already exists", () => {
    const sp1 = new Scratchpad("test-session-2", tempDir);
    const sp2 = new Scratchpad("test-session-2", tempDir);
    expect(existsSync(join(tempDir, "test-session-2"))).toBe(true);
  });

  // ─── Write & Read ───────────────────────────────────────────

  test("write and read a file", () => {
    const sp = new Scratchpad("sess-rw", tempDir);
    sp.write("plan.md", "# My Plan\n\nDo things", "coordinator");
    const content = sp.read("plan.md");
    expect(content).toBe("# My Plan\n\nDo things");
  });

  test("read returns null for non-existent file", () => {
    const sp = new Scratchpad("sess-null", tempDir);
    expect(sp.read("nonexistent.md")).toBeNull();
  });

  test("write overwrites existing file", () => {
    const sp = new Scratchpad("sess-overwrite", tempDir);
    sp.write("notes.md", "version 1", "coordinator");
    sp.write("notes.md", "version 2", "worker-1");
    expect(sp.read("notes.md")).toBe("version 2");
  });

  // ─── Append ─────────────────────────────────────────────────

  test("append adds content to existing file", () => {
    const sp = new Scratchpad("sess-append", tempDir);
    sp.write("log.txt", "line1\n", "coordinator");
    sp.append("log.txt", "line2\n", "worker-1");
    expect(sp.read("log.txt")).toBe("line1\nline2\n");
  });

  test("append creates file if it does not exist", () => {
    const sp = new Scratchpad("sess-append2", tempDir);
    sp.append("new.txt", "hello", "worker-2");
    expect(sp.read("new.txt")).toBe("hello");
  });

  // ─── Exists ─────────────────────────────────────────────────

  test("exists returns true for written file", () => {
    const sp = new Scratchpad("sess-exists", tempDir);
    sp.write("test.md", "content", "coordinator");
    expect(sp.exists("test.md")).toBe(true);
  });

  test("exists returns false for missing file", () => {
    const sp = new Scratchpad("sess-noexist", tempDir);
    expect(sp.exists("missing.md")).toBe(false);
  });

  // ─── List ───────────────────────────────────────────────────

  test("list returns all non-hidden files", () => {
    const sp = new Scratchpad("sess-list", tempDir);
    sp.write("plan.md", "plan", "coordinator");
    sp.write("progress.md", "progress", "coordinator");
    sp.write("worker-1.md", "result", "worker-1");

    const entries = sp.list();
    const names = entries.map(e => e.file).sort();
    expect(names).toEqual(["plan.md", "progress.md", "worker-1.md"]);
  });

  test("list excludes hidden files", () => {
    const sp = new Scratchpad("sess-hidden", tempDir);
    sp.write("visible.md", "yes", "coordinator");
    // The log file is hidden (.scratchpad.log)
    const entries = sp.list();
    expect(entries.every(e => !e.file.startsWith("."))).toBe(true);
  });

  test("list returns correct content", () => {
    const sp = new Scratchpad("sess-content", tempDir);
    sp.write("data.txt", "hello world", "worker-1");
    const entries = sp.list();
    const entry = entries.find(e => e.file === "data.txt");
    expect(entry).toBeDefined();
    expect(entry!.content).toBe("hello world");
  });

  test("list tracks author from log", () => {
    const sp = new Scratchpad("sess-author", tempDir);
    sp.write("output.md", "result data", "worker-3");
    const entries = sp.list();
    const entry = entries.find(e => e.file === "output.md");
    expect(entry).toBeDefined();
    expect(entry!.author).toBe("worker-3");
  });

  // ─── Cleanup ────────────────────────────────────────────────

  test("cleanup removes the scratchpad directory", () => {
    const sp = new Scratchpad("sess-cleanup", tempDir);
    sp.write("test.md", "data", "coordinator");
    const path = sp.getPath();
    expect(existsSync(path)).toBe(true);

    sp.cleanup();
    expect(existsSync(path)).toBe(false);
  });

  test("cleanup is safe to call multiple times", () => {
    const sp = new Scratchpad("sess-double-clean", tempDir);
    sp.cleanup();
    sp.cleanup(); // Should not throw
  });

  // ─── getPath ────────────────────────────────────────────────

  test("getPath returns the scratchpad directory", () => {
    const sp = new Scratchpad("sess-path", tempDir);
    expect(sp.getPath()).toBe(join(tempDir, "sess-path"));
  });

  // ─── Path Traversal Protection ──────────────────────────────

  test("rejects file names with ..", () => {
    const sp = new Scratchpad("sess-traversal", tempDir);
    expect(() => sp.write("../escape.txt", "hack", "evil")).toThrow("path traversal");
  });

  test("rejects file names starting with /", () => {
    const sp = new Scratchpad("sess-abs", tempDir);
    expect(() => sp.write("/etc/passwd", "hack", "evil")).toThrow("path traversal");
  });

  test("rejects file names with backslashes", () => {
    const sp = new Scratchpad("sess-backslash", tempDir);
    expect(() => sp.write("..\\escape.txt", "hack", "evil")).toThrow("path traversal");
  });

  test("rejects Windows absolute paths", () => {
    const sp = new Scratchpad("sess-win", tempDir);
    expect(() => sp.write("C:\\file.txt", "hack", "evil")).toThrow("absolute paths");
  });

  test("rejects empty file names", () => {
    const sp = new Scratchpad("sess-empty", tempDir);
    expect(() => sp.write("", "data", "user")).toThrow("empty name");
    expect(() => sp.write("  ", "data", "user")).toThrow("empty name");
  });

  test("path traversal also blocked on read", () => {
    const sp = new Scratchpad("sess-trav-read", tempDir);
    expect(() => sp.read("../../etc/passwd")).toThrow("path traversal");
  });

  // ─── Multiple Writers ───────────────────────────────────────

  test("multiple writers do not corrupt data", () => {
    const sp = new Scratchpad("sess-multi", tempDir);

    // Simulate multiple writers writing to different files
    sp.write("worker-1.md", "result from worker 1", "worker-1");
    sp.write("worker-2.md", "result from worker 2", "worker-2");
    sp.write("worker-3.md", "result from worker 3", "worker-3");

    expect(sp.read("worker-1.md")).toBe("result from worker 1");
    expect(sp.read("worker-2.md")).toBe("result from worker 2");
    expect(sp.read("worker-3.md")).toBe("result from worker 3");
  });

  test("concurrent appends to progress file maintain all entries", () => {
    const sp = new Scratchpad("sess-progress", tempDir);
    sp.write("progress.md", "# Progress\n", "coordinator");
    sp.append("progress.md", "- Worker 1 done\n", "worker-1");
    sp.append("progress.md", "- Worker 2 done\n", "worker-2");

    const content = sp.read("progress.md");
    expect(content).toContain("Worker 1 done");
    expect(content).toContain("Worker 2 done");
  });
});
