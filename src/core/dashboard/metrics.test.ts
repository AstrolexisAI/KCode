// KCode - Dashboard Metrics Tests

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  countDependencies,
  countFiles,
  countLinesOfCode,
  detectLanguage,
  detectTestFramework,
  getProjectName,
  parseCoverage,
} from "./metrics";

const TEST_DIR = join(import.meta.dir, `__test_metrics_${process.pid}__`);

beforeAll(() => {
  mkdirSync(join(TEST_DIR, "src"), { recursive: true });
  mkdirSync(join(TEST_DIR, "coverage"), { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── detectLanguage ────────────────────────────────────────────

describe("detectLanguage", () => {
  test("detects TypeScript from tsconfig.json", async () => {
    writeFileSync(join(TEST_DIR, "tsconfig.json"), "{}");
    expect(await detectLanguage(TEST_DIR)).toBe("TypeScript");
  });

  test("detects Python from setup.py", async () => {
    const pyDir = join(TEST_DIR, "__py_project__");
    mkdirSync(pyDir, { recursive: true });
    writeFileSync(join(pyDir, "setup.py"), "");
    expect(await detectLanguage(pyDir)).toBe("Python");
    rmSync(pyDir, { recursive: true });
  });

  test("detects Go from go.mod", async () => {
    const goDir = join(TEST_DIR, "__go_project__");
    mkdirSync(goDir, { recursive: true });
    writeFileSync(join(goDir, "go.mod"), "module example.com/foo");
    expect(await detectLanguage(goDir)).toBe("Go");
    rmSync(goDir, { recursive: true });
  });

  test("detects Rust from Cargo.toml", async () => {
    const rsDir = join(TEST_DIR, "__rs_project__");
    mkdirSync(rsDir, { recursive: true });
    writeFileSync(join(rsDir, "Cargo.toml"), '[package]\nname = "foo"');
    expect(await detectLanguage(rsDir)).toBe("Rust");
    rmSync(rsDir, { recursive: true });
  });

  test("returns Unknown for empty directory", async () => {
    const emptyDir = join(TEST_DIR, "__empty__");
    mkdirSync(emptyDir, { recursive: true });
    expect(await detectLanguage(emptyDir)).toBe("Unknown");
    rmSync(emptyDir, { recursive: true });
  });
});

// ─── detectTestFramework ───────────────────────────────────────

describe("detectTestFramework", () => {
  test("detects bun test from scripts", async () => {
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ scripts: { test: "bun test" } }),
    );
    expect(await detectTestFramework(TEST_DIR)).toContain("bun");
  });

  test("detects jest from scripts", async () => {
    const jestDir = join(TEST_DIR, "__jest__");
    mkdirSync(jestDir, { recursive: true });
    writeFileSync(
      join(jestDir, "package.json"),
      JSON.stringify({ scripts: { test: "jest --coverage" } }),
    );
    expect(await detectTestFramework(jestDir)).toBe("jest");
    rmSync(jestDir, { recursive: true });
  });

  test("detects vitest from devDependencies", async () => {
    const vitestDir = join(TEST_DIR, "__vitest__");
    mkdirSync(vitestDir, { recursive: true });
    writeFileSync(
      join(vitestDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^1.0.0" } }),
    );
    expect(await detectTestFramework(vitestDir)).toBe("vitest");
    rmSync(vitestDir, { recursive: true });
  });

  test("returns unknown for projects without test config", async () => {
    const noTestDir = join(TEST_DIR, "__notest__");
    mkdirSync(noTestDir, { recursive: true });
    expect(await detectTestFramework(noTestDir)).toBe("unknown");
    rmSync(noTestDir, { recursive: true });
  });
});

// ─── countFiles ────────────────────────────────────────────────

describe("countFiles", () => {
  test("counts TypeScript files", async () => {
    writeFileSync(join(TEST_DIR, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(TEST_DIR, "src", "b.ts"), "export const b = 2;");
    const count = await countFiles(TEST_DIR, ["ts"]);
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("returns 0 for non-existent directory", async () => {
    const count = await countFiles("/nonexistent/unlikely/path", ["ts"]);
    expect(count).toBe(0);
  });
});

// ─── countLinesOfCode ──────────────────────────────────────────

describe("countLinesOfCode", () => {
  test("counts lines in source files", async () => {
    writeFileSync(join(TEST_DIR, "src", "loc.ts"), "line1\nline2\nline3\n");
    const loc = await countLinesOfCode(TEST_DIR, ["ts"]);
    expect(loc).toBeGreaterThan(0);
  });
});

// ─── parseCoverage ─────────────────────────────────────────────

describe("parseCoverage", () => {
  test("parses Istanbul coverage-summary.json", async () => {
    writeFileSync(
      join(TEST_DIR, "coverage", "coverage-summary.json"),
      JSON.stringify({ total: { lines: { pct: 85.3 }, statements: { pct: 87.1 } } }),
    );
    const cov = await parseCoverage(TEST_DIR);
    expect(cov).toBe(85);
  });

  test("parses lcov.info format", async () => {
    // Remove coverage-summary.json first
    try {
      rmSync(join(TEST_DIR, "coverage", "coverage-summary.json"));
    } catch {}
    writeFileSync(
      join(TEST_DIR, "coverage", "lcov.info"),
      "SF:src/a.ts\nLF:100\nLH:75\nend_of_record\nSF:src/b.ts\nLF:50\nLH:40\nend_of_record\n",
    );
    const cov = await parseCoverage(TEST_DIR);
    expect(cov).toBe(77); // (75+40)/(100+50) = 76.67 -> 77
  });

  test("returns undefined when no coverage data", async () => {
    const emptyDir = join(TEST_DIR, "__nocov__");
    mkdirSync(emptyDir, { recursive: true });
    const cov = await parseCoverage(emptyDir);
    expect(cov).toBeUndefined();
    rmSync(emptyDir, { recursive: true });
  });
});

// ─── getProjectName ────────────────────────────────────────────

describe("getProjectName", () => {
  test("reads name from package.json", async () => {
    writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify({ name: "my-cool-project" }));
    expect(await getProjectName(TEST_DIR)).toBe("my-cool-project");
  });

  test("falls back to directory name", async () => {
    const bareDir = join(TEST_DIR, "__bare_project__");
    mkdirSync(bareDir, { recursive: true });
    expect(await getProjectName(bareDir)).toBe("__bare_project__");
    rmSync(bareDir, { recursive: true });
  });
});

// ─── countDependencies ─────────────────────────────────────────

describe("countDependencies", () => {
  test("counts deps and devDeps from package.json", async () => {
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({
        dependencies: { a: "1.0", b: "2.0" },
        devDependencies: { c: "3.0" },
      }),
    );
    const result = await countDependencies(TEST_DIR);
    expect(result.total).toBe(3);
  });

  test("returns 0 for projects without package.json", async () => {
    const emptyDir = join(TEST_DIR, "__nodeps__");
    mkdirSync(emptyDir, { recursive: true });
    const result = await countDependencies(emptyDir);
    expect(result.total).toBe(0);
    rmSync(emptyDir, { recursive: true });
  });
});
