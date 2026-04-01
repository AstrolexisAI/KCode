// KCode - GrepReplace Preview Tests

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatPreview, previewGrepReplace } from "./grep-replace-preview";

const TEST_DIR = join(import.meta.dir, `__test_grep_preview_${process.pid}__`);

beforeAll(() => {
  mkdirSync(join(TEST_DIR, "src"), { recursive: true });
  writeFileSync(
    join(TEST_DIR, "src", "foo.ts"),
    `const name = "hello";\nconst greeting = "hello world";\nconst other = "bye";\n`,
  );
  writeFileSync(join(TEST_DIR, "src", "bar.ts"), `console.log("hello");\nfoo();\n`);
  writeFileSync(join(TEST_DIR, "src", "data.json"), `{"key": "hello"}\n`);
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("previewGrepReplace", () => {
  test("finds matches in TypeScript files", async () => {
    const result = await previewGrepReplace("hello", "goodbye", "*.ts", TEST_DIR);
    expect(result.totalFiles).toBe(2);
    expect(result.totalMatches).toBeGreaterThanOrEqual(3);
  });

  test("generates diff with old and new lines", async () => {
    const result = await previewGrepReplace("hello", "goodbye", "*.ts", TEST_DIR);
    expect(result.files.length).toBeGreaterThan(0);
    const diff = result.files[0]!.diff;
    expect(diff).toContain("hello");
    expect(diff).toContain("goodbye");
  });

  test("respects glob filter", async () => {
    const result = await previewGrepReplace("hello", "hi", "*.json", TEST_DIR);
    expect(result.totalFiles).toBe(1);
  });

  test("returns 0 matches for non-matching pattern", async () => {
    const result = await previewGrepReplace(
      "nonexistent_string_xyz",
      "replacement",
      "*.ts",
      TEST_DIR,
    );
    expect(result.totalFiles).toBe(0);
    expect(result.totalMatches).toBe(0);
  });

  test("throws on invalid regex", async () => {
    await expect(previewGrepReplace("[invalid", "replacement", "*.ts", TEST_DIR)).rejects.toThrow(
      "Invalid regex",
    );
  });

  test("does not modify original files", async () => {
    await previewGrepReplace("hello", "goodbye", "*.ts", TEST_DIR);
    const content = await Bun.file(join(TEST_DIR, "src", "foo.ts")).text();
    expect(content).toContain("hello"); // Not modified
    expect(content).not.toContain("goodbye");
  });

  test("file paths are relative", async () => {
    const result = await previewGrepReplace("hello", "hi", "*.ts", TEST_DIR);
    for (const file of result.files) {
      expect(file.path).not.toContain(TEST_DIR);
      expect(file.path.startsWith("src/")).toBe(true);
    }
  });
});

describe("formatPreview", () => {
  test("formats non-empty preview", () => {
    const output = formatPreview({
      files: [{ path: "src/foo.ts", matches: 2, diff: "-old\n+new" }],
      totalFiles: 1,
      totalMatches: 2,
    });
    expect(output).toContain("2 match(es) in 1 file(s)");
    expect(output).toContain("src/foo.ts");
  });

  test("formats empty preview", () => {
    const output = formatPreview({ files: [], totalFiles: 0, totalMatches: 0 });
    expect(output).toContain("No matches found");
  });
});
