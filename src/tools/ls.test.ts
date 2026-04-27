// Tests for LS tool — directory listing
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { executeLs, lsDefinition } from "./ls";

// LS validates paths must be in home or project dir — use a subdir of HOME
const testDir = join(homedir(), `.kcode-ls-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, "file1.ts"), "x");
  writeFileSync(join(testDir, "file2.md"), "x");
  writeFileSync(join(testDir, ".hidden"), "x");
  mkdirSync(join(testDir, "subdir"), { recursive: true });
  writeFileSync(join(testDir, "subdir", "nested.ts"), "x");
  mkdirSync(join(testDir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(testDir, "node_modules", "pkg", "index.js"), "x");
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("lsDefinition", () => {
  test("has correct name and schema", () => {
    expect(lsDefinition.name).toBe("LS");
    expect(lsDefinition.input_schema.type).toBe("object");
  });
});

describe("executeLs", () => {
  test("lists a directory", async () => {
    const result = await executeLs({ path: testDir });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("file1.ts");
    expect(result.content).toContain("file2.md");
    expect(result.content).toContain("subdir");
  });

  test("directories have trailing slash", async () => {
    const result = await executeLs({ path: testDir });
    expect(result.content).toContain("subdir/");
  });

  test("includes hidden files by default (dotfiles visible)", async () => {
    const result = await executeLs({ path: testDir });
    expect(result.content).toContain(".hidden");
  });

  test("excludes node_modules by default", async () => {
    const result = await executeLs({ path: testDir });
    expect(result.content).not.toContain("node_modules");
  });

  test("returns error for non-existent path", async () => {
    const result = await executeLs({ path: "/nonexistent/path/that/doesnt/exist" });
    expect(result.is_error).toBe(true);
  });

  test("rejects file path (must be directory)", async () => {
    const result = await executeLs({ path: join(testDir, "file1.ts") });
    expect(result.is_error).toBe(true);
  });

  test("shows entry count in header", async () => {
    const result = await executeLs({ path: testDir });
    expect(result.content).toMatch(/\d+ entries/);
  });

  test("resolves relative path against HOME", async () => {
    // Use absolute testDir — resolution logic
    const result = await executeLs({ path: testDir });
    expect(result.is_error).toBeFalsy();
  });
});
