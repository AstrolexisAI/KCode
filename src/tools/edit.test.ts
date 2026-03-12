import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeEdit } from "./edit.ts";

let tempDir: string;

async function createTempFile(name: string, content: string): Promise<string> {
  const filePath = join(tempDir, name);
  await Bun.write(filePath, content);
  return filePath;
}

describe("edit tool", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-edit-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Successful replacement ───

  test("successful single string replacement", async () => {
    const filePath = await createTempFile("test.txt", "Hello world, welcome to the world.");

    const result = await executeEdit({
      file_path: filePath,
      old_string: "Hello world",
      new_string: "Goodbye world",
    });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("replaced 1 occurrence");

    const updated = readFileSync(filePath, "utf-8");
    expect(updated).toBe("Goodbye world, welcome to the world.");
  });

  // ─── old_string not found ───

  test("error when old_string not found", async () => {
    const filePath = await createTempFile("test.txt", "The quick brown fox");

    const result = await executeEdit({
      file_path: filePath,
      old_string: "lazy dog",
      new_string: "active cat",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not found");

    // File should be unchanged
    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe("The quick brown fox");
  });

  // ─── old_string not unique ───

  test("error when old_string is not unique", async () => {
    const filePath = await createTempFile("test.txt", "foo bar foo baz foo");

    const result = await executeEdit({
      file_path: filePath,
      old_string: "foo",
      new_string: "qux",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("3 times");
    expect(result.content).toContain("replace_all");

    // File should be unchanged
    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe("foo bar foo baz foo");
  });

  // ─── replace_all ───

  test("replace_all replaces all occurrences", async () => {
    const filePath = await createTempFile("test.txt", "aaa bbb aaa ccc aaa");

    const result = await executeEdit({
      file_path: filePath,
      old_string: "aaa",
      new_string: "zzz",
      replace_all: true,
    });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("replaced 3 occurrence");

    const updated = readFileSync(filePath, "utf-8");
    expect(updated).toBe("zzz bbb zzz ccc zzz");
  });

  // ─── Preserves surrounding content ───

  test("preserves file content around the edit", async () => {
    const originalContent = [
      "line 1: header",
      "line 2: REPLACE_ME",
      "line 3: footer",
      "line 4: more content",
    ].join("\n");

    const filePath = await createTempFile("multi.txt", originalContent);

    const result = await executeEdit({
      file_path: filePath,
      old_string: "line 2: REPLACE_ME",
      new_string: "line 2: REPLACED",
    });

    expect(result.is_error).toBeUndefined();

    const updated = readFileSync(filePath, "utf-8");
    expect(updated).toBe(
      ["line 1: header", "line 2: REPLACED", "line 3: footer", "line 4: more content"].join("\n"),
    );
  });

  // ─── old_string equals new_string ───

  test("error when old_string and new_string are identical", async () => {
    const filePath = await createTempFile("test.txt", "hello world");

    const result = await executeEdit({
      file_path: filePath,
      old_string: "hello",
      new_string: "hello",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("identical");
  });

  // ─── Non-existent file ───

  test("error on non-existent file", async () => {
    const result = await executeEdit({
      file_path: join(tempDir, "does-not-exist.txt"),
      old_string: "foo",
      new_string: "bar",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Error");
  });

  // ─── Multi-line replacement ───

  test("handles multi-line old_string and new_string", async () => {
    const filePath = await createTempFile(
      "multiline.txt",
      "function hello() {\n  console.log('hi');\n}\n",
    );

    const result = await executeEdit({
      file_path: filePath,
      old_string: "function hello() {\n  console.log('hi');\n}",
      new_string: "function hello() {\n  console.log('hello world');\n  return true;\n}",
    });

    expect(result.is_error).toBeUndefined();

    const updated = readFileSync(filePath, "utf-8");
    expect(updated).toContain("hello world");
    expect(updated).toContain("return true;");
  });

  // ─── Empty replacement (deletion) ───

  test("replaces with empty string (deletion)", async () => {
    const filePath = await createTempFile("test.txt", "keep this remove_me keep this too");

    const result = await executeEdit({
      file_path: filePath,
      old_string: " remove_me",
      new_string: "",
    });

    expect(result.is_error).toBeUndefined();

    const updated = readFileSync(filePath, "utf-8");
    expect(updated).toBe("keep this keep this too");
  });
});
