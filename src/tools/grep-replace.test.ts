import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeGrepReplace } from "./grep-replace.ts";

let tempDir: string;
let originalCwd: string;

async function createTempFile(name: string, content: string): Promise<string> {
  const filePath = join(tempDir, name);
  await Bun.write(filePath, content);
  return filePath;
}

describe("grep-replace tool", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-grep-replace-test-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Dry-run mode (default) ───

  test("dry-run shows preview without modifying files", async () => {
    await createTempFile("hello.ts", 'const msg = "hello";\nconsole.log(msg);\n');

    const result = await executeGrepReplace({
      pattern: "hello",
      replacement: "world",
      path: tempDir,
    });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Dry run");
    expect(result.content).toContain("dry_run=false");

    // File should NOT be modified
    const content = readFileSync(join(tempDir, "hello.ts"), "utf-8");
    expect(content).toContain("hello");
  });

  // ─── Actual replacement ───

  test("dry_run=false modifies files", async () => {
    await createTempFile("greet.ts", 'const msg = "hello";\n');

    const result = await executeGrepReplace({
      pattern: "hello",
      replacement: "world",
      path: tempDir,
      dry_run: false,
    });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Applied");

    const content = readFileSync(join(tempDir, "greet.ts"), "utf-8");
    expect(content).toContain("world");
    expect(content).not.toContain("hello");
  });

  // ─── ReDoS pattern rejected ───

  test("rejects nested quantifiers (ReDoS)", async () => {
    await createTempFile("test.ts", "aaa");

    const result = await executeGrepReplace({
      pattern: "(a+)+",
      replacement: "b",
      path: tempDir,
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("nested quantifiers");
  });

  // ─── File extension filter ───

  test("glob filter restricts to specified extensions", async () => {
    await createTempFile("code.ts", "foo bar");
    await createTempFile("data.json", "foo bar");

    const result = await executeGrepReplace({
      pattern: "foo",
      replacement: "baz",
      path: tempDir,
      glob: ".ts",
      dry_run: false,
    });

    expect(result.is_error).toBeUndefined();

    // .ts file should be changed
    expect(readFileSync(join(tempDir, "code.ts"), "utf-8")).toContain("baz");
    // .json file should be unchanged
    expect(readFileSync(join(tempDir, "data.json"), "utf-8")).toBe("foo bar");
  });

  // ─── Literal mode ───

  test("literal mode escapes regex special characters", async () => {
    await createTempFile("regex.ts", "const re = /foo.bar/;\n");

    const result = await executeGrepReplace({
      pattern: "foo.bar",
      replacement: "foo_bar",
      path: tempDir,
      literal: true,
      dry_run: false,
    });

    expect(result.is_error).toBeUndefined();

    const content = readFileSync(join(tempDir, "regex.ts"), "utf-8");
    expect(content).toContain("foo_bar");
  });

  // ─── Max file size skip ───

  test("skips files larger than 500KB", async () => {
    // Create a file just over 500KB
    const largeContent = "x".repeat(500_001);
    await createTempFile("large.ts", largeContent);
    await createTempFile("small.ts", "findme here");

    const result = await executeGrepReplace({
      pattern: "findme",
      replacement: "found",
      path: tempDir,
    });

    // Only the small file should appear in results
    expect(result.content).toContain("small.ts");
    expect(result.content).not.toContain("large.ts");
  });

  // ─── Path outside cwd rejected ───

  test("rejects path outside project directory", async () => {
    const result = await executeGrepReplace({
      pattern: "foo",
      replacement: "bar",
      path: "/etc",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("within the project directory");
  });

  // ─── Phase 19: oversized multi-region patterns ───

  test("rejects pattern over 500 chars", async () => {
    const bigPattern = `let foo = ${"x".repeat(600)} end`;
    const result = await executeGrepReplace({
      pattern: bigPattern,
      replacement: "const foo = 1",
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("too large for reliable matching");
    expect(String(result.content)).toMatch(/Edit with a small unique anchor/);
  });

  test("rejects pattern with 2+ [\\s\\S]*? lazy wildcards", async () => {
    const pattern = `const foo = \\{[\\s\\S]*?\\};\\s*const bar = \\[[\\s\\S]*?\\];`;
    const result = await executeGrepReplace({
      pattern,
      replacement: "/* ... */",
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("too large for reliable matching");
    expect(String(result.content)).toContain("2 lazy");
  });

  test("literal=true bypasses pattern size check", async () => {
    // Literal strings can legitimately be long (e.g. replacing a big
    // comment block). Size guard only applies to regex patterns.
    const bigLiteral = "x".repeat(800);
    const result = await executeGrepReplace({
      pattern: bigLiteral,
      replacement: "y",
      literal: true,
    });
    // Should NOT be a size-guard rejection — may hit "no matches" but
    // that's a different code path.
    if (result.is_error) {
      expect(String(result.content)).not.toContain("too large for reliable matching");
    }
  });
});
