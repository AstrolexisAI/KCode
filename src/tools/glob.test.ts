import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { executeGlob, globDefinition } from "./glob.ts";
import { setToolWorkspace } from "./workspace";

const tempDir = `/tmp/kcode-test-glob-${Date.now()}`;

describe("glob tool", () => {
  beforeAll(() => {
    // Set workspace to the test tmpdir so paths are valid
    setToolWorkspace(tempDir);
    // Create a test directory structure
    mkdirSync(join(tempDir, "src"), { recursive: true });
    mkdirSync(join(tempDir, "src", "utils"), { recursive: true });
    mkdirSync(join(tempDir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(tempDir, ".git", "objects"), { recursive: true });
    mkdirSync(join(tempDir, "dist"), { recursive: true });

    // Create test files
    writeFileSync(join(tempDir, "src", "index.ts"), "export {}");
    writeFileSync(join(tempDir, "src", "app.ts"), "const app = 1;");
    writeFileSync(join(tempDir, "src", "utils", "helpers.ts"), "export function help() {}");
    writeFileSync(join(tempDir, "src", "style.css"), "body {}");
    writeFileSync(join(tempDir, "node_modules", "pkg", "index.ts"), "module");
    writeFileSync(join(tempDir, ".git", "objects", "abc"), "git object");
    writeFileSync(join(tempDir, "dist", "bundle.js"), "bundled");
    writeFileSync(join(tempDir, "README.md"), "# Readme");
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Definition ───

  test("globDefinition has correct name and required fields", () => {
    expect(globDefinition.name).toBe("Glob");
    expect(globDefinition.input_schema.required).toContain("pattern");
  });

  // ─── Basic pattern matching ───

  test("finds files matching **/*.ts pattern", async () => {
    const result = await executeGlob({ pattern: "**/*.ts", path: tempDir });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("index.ts");
    expect(result.content).toContain("app.ts");
    expect(result.content).toContain("helpers.ts");
  });

  test("finds files with specific name", async () => {
    const result = await executeGlob({ pattern: "**/README.md", path: tempDir });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("README.md");
  });

  // ─── No matches ───

  test("returns 'No files found' for non-matching pattern", async () => {
    const result = await executeGlob({ pattern: "**/*.xyz", path: tempDir });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("No files found");
    expect(result.content).toContain("*.xyz");
  });

  // ─── Excludes node_modules, .git, dist ───

  test("excludes node_modules directory", async () => {
    const result = await executeGlob({ pattern: "**/*.ts", path: tempDir });

    expect(result.content).not.toContain("node_modules");
  });

  test("excludes .git directory", async () => {
    const result = await executeGlob({ pattern: "**/*", path: tempDir });

    expect(result.content).not.toContain(".git");
  });

  test("excludes dist directory", async () => {
    const result = await executeGlob({ pattern: "**/*.js", path: tempDir });

    expect(result.content).not.toContain("dist");
  });

  // ─── Respects path parameter ───

  test("respects the path parameter", async () => {
    const result = await executeGlob({
      pattern: "*.ts",
      path: join(tempDir, "src"),
    });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("index.ts");
    expect(result.content).toContain("app.ts");
    // Should NOT include files from subdirectories with a non-recursive pattern
    expect(result.content).not.toContain("helpers.ts");
  });

  test("searches subdirectories with ** pattern", async () => {
    const result = await executeGlob({
      pattern: "**/*.ts",
      path: join(tempDir, "src"),
    });

    expect(result.content).toContain("helpers.ts");
  });

  // ─── File count reporting ───

  test("reports correct file count", async () => {
    const result = await executeGlob({ pattern: "**/*.ts", path: tempDir });

    // Should find 3 .ts files (index.ts, app.ts, helpers.ts — not node_modules)
    expect(result.content).toContain("3 file(s)");
  });

  // ─── Large result truncation ───

  test("truncates results beyond MAX_RESULTS (1000)", async () => {
    // Create a directory with many files
    const bigDir = join(tempDir, "big");
    mkdirSync(bigDir, { recursive: true });

    for (let i = 0; i < 1050; i++) {
      writeFileSync(join(bigDir, `file-${i.toString().padStart(4, "0")}.txt`), `content ${i}`);
    }

    const result = await executeGlob({ pattern: "**/*.txt", path: bigDir });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("1050 file(s)");
    expect(result.content).toContain("showing first 1000");
  });

  // ─── Non-matching CSS pattern ───

  test("finds CSS files but not TS files with *.css", async () => {
    const result = await executeGlob({ pattern: "**/*.css", path: tempDir });

    expect(result.content).toContain("style.css");
    expect(result.content).not.toContain("index.ts");
  });

  // ─── Error handling ───

  test("handles invalid path gracefully", async () => {
    const result = await executeGlob({
      pattern: "**/*.ts",
      path: "/nonexistent-path-12345",
    });

    // Should either return no files or an error — not crash
    const isHandled = result.content.includes("No files found") || result.is_error === true;
    expect(isHandled).toBe(true);
  });

  // ─── tool_use_id ───

  test("result always has empty tool_use_id", async () => {
    const result = await executeGlob({ pattern: "**/*.ts", path: tempDir });
    expect(result.tool_use_id).toBe("");
  });
});
