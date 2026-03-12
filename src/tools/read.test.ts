import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeRead } from "./read.ts";

let tempDir: string;

async function createTempFile(name: string, content: string): Promise<string> {
  const filePath = join(tempDir, name);
  await Bun.write(filePath, content);
  return filePath;
}

describe("read tool", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-read-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Basic text file reading ───

  test("reads a text file with line numbers", async () => {
    const content = "line one\nline two\nline three\n";
    const filePath = await createTempFile("test.txt", content);

    const result = await executeRead({ file_path: filePath });

    expect(result.is_error).toBeUndefined();
    // Should have cat -n style line numbers
    expect(result.content).toContain("1\tline one");
    expect(result.content).toContain("2\tline two");
    expect(result.content).toContain("3\tline three");
  });

  test("reads single-line file", async () => {
    const filePath = await createTempFile("single.txt", "just one line");

    const result = await executeRead({ file_path: filePath });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("1\tjust one line");
  });

  test("reads empty file", async () => {
    const filePath = await createTempFile("empty.txt", "");

    const result = await executeRead({ file_path: filePath });

    expect(result.is_error).toBeUndefined();
    // Empty file has one empty line
    expect(result.content).toContain("1\t");
  });

  // ─── Offset and limit ───

  test("offset parameter starts at specified line", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const filePath = await createTempFile("lines.txt", lines);

    const result = await executeRead({ file_path: filePath, offset: 3 });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("3\tline 3");
    expect(result.content).not.toContain("1\tline 1");
    expect(result.content).not.toContain("2\tline 2");
  });

  test("limit parameter restricts number of lines", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const filePath = await createTempFile("lines.txt", lines);

    const result = await executeRead({ file_path: filePath, limit: 3 });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("1\tline 1");
    expect(result.content).toContain("2\tline 2");
    expect(result.content).toContain("3\tline 3");
    expect(result.content).not.toContain("4\tline 4");
  });

  test("offset and limit together", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const filePath = await createTempFile("lines.txt", lines);

    const result = await executeRead({ file_path: filePath, offset: 5, limit: 3 });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("5\tline 5");
    expect(result.content).toContain("6\tline 6");
    expect(result.content).toContain("7\tline 7");
    expect(result.content).not.toContain("4\tline 4");
    expect(result.content).not.toContain("8\tline 8");
  });

  // ─── Error on directory ───

  test("error when reading a directory", async () => {
    const dirPath = join(tempDir, "subdir");
    await mkdir(dirPath);

    const result = await executeRead({ file_path: dirPath });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("directory");
  });

  // ─── Error on non-existent file ───

  test("error on non-existent file", async () => {
    const result = await executeRead({ file_path: join(tempDir, "nope.txt") });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Error");
  });

  // ─── MAX_LINES truncation ───

  test("truncates output at MAX_LINES (2000)", async () => {
    // Create file with more than 2000 lines
    const lineCount = 2500;
    const lines = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n");
    const filePath = await createTempFile("big.txt", lines);

    const result = await executeRead({ file_path: filePath });

    expect(result.is_error).toBeUndefined();
    // Should show a header indicating truncation
    expect(result.content).toContain("Showing lines");
    // Should contain line 2000 but not line 2001
    expect(result.content).toContain("2000\tline 2000");
    expect(result.content).not.toContain("2001\tline 2001");
  });

  test("limit is capped at MAX_LINES even if larger value specified", async () => {
    const lineCount = 2500;
    const lines = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n");
    const filePath = await createTempFile("big.txt", lines);

    const result = await executeRead({ file_path: filePath, limit: 5000 });

    expect(result.is_error).toBeUndefined();
    // Even with limit=5000, MAX_LINES (2000) should cap it
    expect(result.content).toContain("2000\tline 2000");
    expect(result.content).not.toContain("2001\tline 2001");
  });

  // ─── Long line truncation ───

  test("truncates lines longer than MAX_LINE_LENGTH (2000 chars)", async () => {
    const longLine = "x".repeat(3000);
    const filePath = await createTempFile("long.txt", longLine);

    const result = await executeRead({ file_path: filePath });

    expect(result.is_error).toBeUndefined();
    // Line should be truncated to 2000 chars + "..."
    expect(result.content).toContain("...");
    // The truncated line should have exactly 2000 x's before the ...
    const lineContent = result.content.split("\t")[1]!;
    // lineContent starts with the truncated text
    expect(lineContent.startsWith("x".repeat(2000))).toBe(true);
  });

  // ─── Line number formatting ───

  test("line numbers are right-padded to 6 characters", async () => {
    const filePath = await createTempFile("test.txt", "hello\nworld");

    const result = await executeRead({ file_path: filePath });

    // Line numbers are padStart(6), so "     1\t..."
    expect(result.content).toMatch(/\s+1\thello/);
    expect(result.content).toMatch(/\s+2\tworld/);
  });

  // ─── Showing lines header ───

  test("no header when entire file fits", async () => {
    const filePath = await createTempFile("small.txt", "a\nb\nc");

    const result = await executeRead({ file_path: filePath });

    expect(result.content).not.toContain("Showing lines");
  });

  test("shows header when file is truncated", async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `${i}`).join("\n");
    const filePath = await createTempFile("large.txt", lines);

    const result = await executeRead({ file_path: filePath });

    expect(result.content).toContain("Showing lines 1-2000 of");
  });
});
