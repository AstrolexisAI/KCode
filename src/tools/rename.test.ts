import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeRename } from "./rename.ts";

let tempDir: string;
let originalCwd: string;

async function createTempFile(name: string, content: string): Promise<string> {
  const filePath = join(tempDir, name);
  await Bun.write(filePath, content);
  return filePath;
}

describe("rename tool", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-rename-test-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Dry-run preview ───

  test("dry_run shows preview without modifying files", async () => {
    await createTempFile("code.ts", "function myFunc() { return myFunc(); }");

    const result = await executeRename({
      symbol: "myFunc",
      new_name: "myNewFunc",
      scope: tempDir,
      dry_run: true,
    });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Dry run");
    expect(result.content).toContain("myFunc");
    expect(result.content).toContain("myNewFunc");

    // File should NOT be modified
    const content = readFileSync(join(tempDir, "code.ts"), "utf-8");
    expect(content).toContain("myFunc");
    expect(content).not.toContain("myNewFunc");
  });

  // ─── Word-boundary matching ───

  test("uses word-boundary matching (does not rename partial matches)", async () => {
    await createTempFile("vars.ts", "const item = 1;\nconst itemCount = 2;\nconst myItem = 3;\n");

    const result = await executeRename({
      symbol: "item",
      new_name: "entry",
      scope: tempDir,
      dry_run: false,
    });

    expect(result.is_error).toBeUndefined();

    const content = readFileSync(join(tempDir, "vars.ts"), "utf-8");
    // "item" standalone should be renamed
    expect(content).toContain("const entry = 1;");
    // "itemCount" should NOT become "entryCount" (word boundary)
    expect(content).toContain("itemCount");
    // "myItem" should NOT be changed (word boundary on left)
    expect(content).toContain("myItem");
  });

  // ─── Invalid identifier rejected ───

  test("rejects invalid identifier for new_name", async () => {
    const result = await executeRename({
      symbol: "foo",
      new_name: "123invalid",
      scope: tempDir,
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("valid identifier");
  });

  test("rejects invalid identifier for symbol", async () => {
    const result = await executeRename({
      symbol: "foo-bar",
      new_name: "fooBar",
      scope: tempDir,
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("valid identifier");
  });

  // ─── Scope outside working dir rejected ───

  test("rejects scope outside current working directory", async () => {
    const result = await executeRename({
      symbol: "foo",
      new_name: "bar",
      scope: "/etc",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("within the project directory");
  });

  // ─── Actual rename across multiple files ───

  test("renames symbol across multiple files", async () => {
    await createTempFile("a.ts", "export function doWork() {}\n");
    await createTempFile("b.ts", 'import { doWork } from "./a";\ndoWork();\n');

    const result = await executeRename({
      symbol: "doWork",
      new_name: "performWork",
      scope: tempDir,
      dry_run: false,
    });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Renamed");
    expect(result.content).toContain("2 file(s)");

    expect(readFileSync(join(tempDir, "a.ts"), "utf-8")).toContain("performWork");
    expect(readFileSync(join(tempDir, "b.ts"), "utf-8")).toContain("performWork");
  });

  // ─── No references found ───

  test("reports when no references are found", async () => {
    await createTempFile("empty.ts", "const x = 1;");

    const result = await executeRename({
      symbol: "nonexistent",
      new_name: "something",
      scope: tempDir,
    });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("No references");
  });
});
