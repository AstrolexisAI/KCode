// KCode - Enhanced Auto-Test Detector
// Finds related test files for a given source file using multiple strategies.

import { existsSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { log } from "../logger";
import type { TestDetection, TestFramework } from "./types";

// ─── Test file detection ───────────────────────────────────────

const TEST_SUFFIXES = [".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx", ".test.js", ".spec.js", ".test.jsx", ".spec.jsx", "_test.go", "_test.py"];

/**
 * Detect related test files for a modified source file.
 * Uses 4 strategies in order of confidence.
 */
export async function detectTests(modifiedFile: string, cwd: string): Promise<TestDetection | null> {
  const ext = extname(modifiedFile);
  const base = basename(modifiedFile, ext);

  // Skip test files themselves
  if (isTestFile(modifiedFile)) return null;

  const testFiles: string[] = [];

  // Strategy 1: Same directory (foo.ts → foo.test.ts)
  const dir = dirname(modifiedFile);
  for (const suffix of TEST_SUFFIXES) {
    const candidate = join(dir, base + suffix);
    if (existsSync(candidate)) testFiles.push(candidate);
  }

  // Strategy 2: __tests__/ directory
  const testsDir = join(dir, "__tests__");
  for (const suffix of TEST_SUFFIXES) {
    const candidate = join(testsDir, base + suffix);
    if (existsSync(candidate)) testFiles.push(candidate);
  }
  // Also check __tests__/base.ext (without .test suffix)
  const testsDirCandidate = join(testsDir, base + ext);
  if (existsSync(testsDirCandidate)) testFiles.push(testsDirCandidate);

  // Strategy 3: Parallel tests/ or test/ directory
  for (const testDirName of ["tests", "test"]) {
    const parallelDir = join(dirname(dir), testDirName);
    for (const suffix of TEST_SUFFIXES) {
      const candidate = join(parallelDir, base + suffix);
      if (existsSync(candidate)) testFiles.push(candidate);
    }
    const candidate2 = join(parallelDir, base + ext);
    if (existsSync(candidate2) && isTestFile(candidate2)) testFiles.push(candidate2);
  }

  // Strategy 4: Import-based detection (grep for imports of this file)
  if (testFiles.length === 0) {
    const importResults = await findTestsByImport(modifiedFile, cwd);
    testFiles.push(...importResults);
  }

  // Deduplicate
  const uniqueTests = [...new Set(testFiles)];
  if (uniqueTests.length === 0) return null;

  const framework = await detectFramework(cwd);
  const command = buildTestCommand(framework, uniqueTests);

  return {
    sourceFile: modifiedFile,
    testFiles: uniqueTests,
    command,
    framework,
    confidence: uniqueTests.length > 0 ? 0.9 : 0.5,
  };
}

// ─── Framework detection ───────────────────────────────────────

export async function detectFramework(cwd: string): Promise<TestFramework> {
  // Check package.json scripts
  try {
    const pkg = Bun.file(join(cwd, "package.json"));
    if (await pkg.exists()) {
      const json = await pkg.json();
      const testScript: string = json?.scripts?.test ?? "";
      if (testScript.includes("bun test")) return "bun";
      if (testScript.includes("vitest")) return "vitest";
      if (testScript.includes("jest")) return "jest";
      if (testScript.includes("mocha")) return "mocha";

      const devDeps = json?.devDependencies ?? {};
      if (devDeps["vitest"]) return "vitest";
      if (devDeps["jest"]) return "jest";
    }
  } catch {}

  // Check for bun.lockb (strong signal for bun:test)
  if (existsSync(join(cwd, "bun.lockb"))) return "bun";

  // Non-JS ecosystems
  if (existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "pyproject.toml"))) return "pytest";
  if (existsSync(join(cwd, "go.mod"))) return "go";
  if (existsSync(join(cwd, "Cargo.toml"))) return "cargo";

  return "bun"; // Default for KCode projects
}

// ─── Test command builder ──────────────────────────────────────

export function buildTestCommand(framework: TestFramework, testFiles: string[]): string {
  const files = testFiles.join(" ");
  switch (framework) {
    case "bun": return `bun test ${files}`;
    case "vitest": return `npx vitest run ${files}`;
    case "jest": return `npx jest ${files}`;
    case "mocha": return `npx mocha ${files}`;
    case "pytest": return `pytest ${files}`;
    case "go": return `go test ${files}`;
    case "cargo": return "cargo test";
    case "unknown": return `bun test ${files}`;
  }
}

// ─── Helpers ───────────────────────────────────────────────────

function isTestFile(filePath: string): boolean {
  const name = basename(filePath);
  return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(name) || /_test\.(go|py)$/.test(name);
}

async function findTestsByImport(sourceFile: string, cwd: string): Promise<string[]> {
  try {
    const base = basename(sourceFile, extname(sourceFile));
    const proc = Bun.spawn(
      ["rg", "--files-with-matches", "--glob", "*.test.*", "--glob", "*.spec.*", `from.*['\"].*${base}['\"]`, cwd],
      { stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;
    if (code !== 0) return [];
    const output = await new Response(proc.stdout).text();
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
