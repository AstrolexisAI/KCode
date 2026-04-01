import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeMultiEdit } from "./multi-edit.ts";

let tempDir: string;

async function createTempFile(name: string, content: string): Promise<string> {
  const filePath = join(tempDir, name);
  await Bun.write(filePath, content);
  return filePath;
}

describe("multi-edit tool", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-multi-edit-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Successful multi-file edit ───

  test("edits multiple files atomically", async () => {
    const fileA = await createTempFile("a.ts", "const foo = 1;");
    const fileB = await createTempFile("b.ts", "const bar = 2;");

    const result = await executeMultiEdit({
      edits: [
        { file_path: fileA, old_string: "foo", new_string: "alpha" },
        { file_path: fileB, old_string: "bar", new_string: "beta" },
      ],
    });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("2 edits");
    expect(result.content).toContain("2 files");

    expect(readFileSync(fileA, "utf-8")).toBe("const alpha = 1;");
    expect(readFileSync(fileB, "utf-8")).toBe("const beta = 2;");
  });

  // ─── Rollback on failure ───

  test("rolls back all changes when a file cannot be read", async () => {
    const fileA = await createTempFile("a.ts", "const foo = 1;");
    const missingFile = join(tempDir, "does-not-exist.ts");

    const result = await executeMultiEdit({
      edits: [
        { file_path: fileA, old_string: "foo", new_string: "alpha" },
        { file_path: missingFile, old_string: "x", new_string: "y" },
      ],
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Cannot read");

    // File A should remain unchanged (validation fails before any write)
    expect(readFileSync(fileA, "utf-8")).toBe("const foo = 1;");
  });

  // ─── Max 50 edits limit ───

  test("rejects more than 50 edits", async () => {
    const edits = Array.from({ length: 51 }, (_, i) => ({
      file_path: `/tmp/fake-${i}.ts`,
      old_string: "a",
      new_string: "b",
    }));

    const result = await executeMultiEdit({ edits });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Maximum 50 edits");
  });

  // ─── Empty edits array rejected ───

  test("rejects empty edits array", async () => {
    const result = await executeMultiEdit({ edits: [] });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("non-empty array");
  });

  // ─── old_string not found ───

  test("error when old_string not found in file", async () => {
    const filePath = await createTempFile("test.ts", "const hello = 1;");

    const result = await executeMultiEdit({
      edits: [{ file_path: filePath, old_string: "goodbye", new_string: "world" }],
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not found");

    // File should be unchanged
    expect(readFileSync(filePath, "utf-8")).toBe("const hello = 1;");
  });

  // ─── Multiple edits in same file ───

  test("applies multiple edits to the same file sequentially", async () => {
    const filePath = await createTempFile("test.ts", "const a = 1;\nconst b = 2;\n");

    const result = await executeMultiEdit({
      edits: [
        { file_path: filePath, old_string: "const a = 1;", new_string: "const x = 10;" },
        { file_path: filePath, old_string: "const b = 2;", new_string: "const y = 20;" },
      ],
    });

    expect(result.is_error).toBeUndefined();

    const updated = readFileSync(filePath, "utf-8");
    expect(updated).toBe("const x = 10;\nconst y = 20;\n");
  });

  // ─── old_string equals new_string ───

  test("error when old_string and new_string are identical", async () => {
    const filePath = await createTempFile("test.ts", "const x = 1;");

    const result = await executeMultiEdit({
      edits: [{ file_path: filePath, old_string: "const x", new_string: "const x" }],
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("old_string === new_string");
  });
});
