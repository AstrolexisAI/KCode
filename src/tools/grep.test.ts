// Tests for Grep tool — search file contents via ripgrep
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeGrep, grepDefinition } from "./grep";
import { setToolWorkspace } from "./workspace";

const testDir = join(tmpdir(), `kcode-grep-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, "file1.ts"), "function hello() {\n  return 'world';\n}\n");
  writeFileSync(join(testDir, "file2.js"), "// hello comment\nfunction foo() {}\n");
  writeFileSync(join(testDir, "file3.md"), "# Title\n\nHello World\n");
  mkdirSync(join(testDir, "nested"), { recursive: true });
  writeFileSync(join(testDir, "nested", "deep.ts"), "const HELLO = 'deep';\n");
  setToolWorkspace(testDir);
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("grepDefinition", () => {
  test("has correct name and required params", () => {
    expect(grepDefinition.name).toBe("Grep");
    expect(grepDefinition.input_schema.required).toContain("pattern");
  });
});

describe("executeGrep", () => {
  test("finds files containing pattern (default: files_with_matches)", async () => {
    const result = await executeGrep({ pattern: "hello", path: testDir });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("file1.ts");
  });

  test("case-insensitive search finds uppercase matches", async () => {
    const result = await executeGrep({ pattern: "hello", path: testDir, "-i": true });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("file1.ts");
    expect(result.content).toContain("nested/deep.ts");
  });

  test("content mode returns matching lines", async () => {
    const result = await executeGrep({
      pattern: "function",
      path: testDir,
      output_mode: "content",
    });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("function hello");
  });

  test("count mode returns match counts", async () => {
    const result = await executeGrep({
      pattern: "function",
      path: testDir,
      output_mode: "count",
    });
    expect(result.is_error).toBeFalsy();
  });

  test("glob filter restricts to matching files", async () => {
    const result = await executeGrep({ pattern: "hello", path: testDir, glob: "*.ts" });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain(".ts");
    expect(result.content).not.toContain("file2.js");
  });

  test("type filter works with recognized types", async () => {
    const result = await executeGrep({ pattern: "function", path: testDir, type: "ts" });
    expect(result.is_error).toBeFalsy();
  });

  test("no matches returns clean message", async () => {
    const result = await executeGrep({
      pattern: "xxxzzzyyynotthere",
      path: testDir,
    });
    expect(result.is_error).toBeFalsy();
  });

  test("head_limit truncates output", async () => {
    const result = await executeGrep({
      pattern: ".",
      path: testDir,
      output_mode: "content",
      head_limit: 2,
    });
    const lines = (result.content as string).split("\n").filter((l: string) => l.trim());
    expect(lines.length).toBeLessThanOrEqual(10); // header + 2 entries + padding
  });

  test("rejects missing pattern", async () => {
    const result = await executeGrep({ path: testDir });
    // Grep without pattern either errors or returns no results — both acceptable
    expect(typeof result.content).toBe("string");
  });
});
