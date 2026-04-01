// KCode - Auto-Test Detection
// Finds and suggests related test files after code edits

import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

/**
 * Given a source file path, find the most likely related test file.
 * Checks common test file naming conventions.
 */
export function findRelatedTest(filePath: string): string | null {
  const dir = dirname(filePath);
  const ext = extname(filePath);
  const base = basename(filePath, ext);

  // Skip if the file itself is a test
  if (base.endsWith(".test") || base.endsWith(".spec") || base.endsWith("_test")) {
    return null;
  }

  // Common test patterns to check
  const candidates = [
    // Same directory: foo.test.ts, foo.spec.ts
    join(dir, `${base}.test${ext}`),
    join(dir, `${base}.spec${ext}`),
    // __tests__ directory
    join(dir, "__tests__", `${base}.test${ext}`),
    join(dir, "__tests__", `${base}${ext}`),
    // tests/ sibling directory
    join(dirname(dir), "tests", `${base}.test${ext}`),
    join(dirname(dir), "tests", `${base}${ext}`),
    // test/ sibling directory
    join(dirname(dir), "test", `${base}.test${ext}`),
    join(dirname(dir), "test", `${base}${ext}`),
    // _test suffix (Go/Rust convention)
    join(dir, `${base}_test${ext}`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Detect the test runner command for a project.
 * Returns the command to run a specific test file.
 */
export function getTestCommand(testFile: string, cwd: string): string | null {
  // Check for common test runner configs
  const checks: Array<{ file: string; cmd: (f: string) => string }> = [
    { file: "bun.lockb", cmd: (f) => `bun test ${f}` },
    { file: "bunfig.toml", cmd: (f) => `bun test ${f}` },
    { file: "vitest.config.ts", cmd: (f) => `npx vitest run ${f}` },
    { file: "vitest.config.js", cmd: (f) => `npx vitest run ${f}` },
    { file: "jest.config.ts", cmd: (f) => `npx jest ${f}` },
    { file: "jest.config.js", cmd: (f) => `npx jest ${f}` },
    { file: "pytest.ini", cmd: (f) => `pytest ${f}` },
    { file: "pyproject.toml", cmd: (f) => `pytest ${f}` },
    { file: "Cargo.toml", cmd: () => `cargo test` },
    { file: "go.mod", cmd: (f) => `go test -run ${basename(f, extname(f))} ./...` },
  ];

  for (const { file, cmd } of checks) {
    if (existsSync(join(cwd, file))) {
      return cmd(testFile);
    }
  }

  // Fallback: check package.json for test script
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    return `npx jest ${testFile}`;
  }

  return null;
}

/**
 * Format a suggestion to run tests for a modified file.
 */
export function getTestSuggestion(
  filePath: string,
  cwd: string,
): { testFile: string; command: string } | null {
  const testFile = findRelatedTest(filePath);
  if (!testFile) return null;

  const command = getTestCommand(testFile, cwd);
  if (!command) return null;

  return { testFile, command };
}

/**
 * Check multiple modified files and return all test suggestions.
 */
export function getTestSuggestionsForFiles(
  files: string[],
  cwd: string,
): Array<{ testFile: string; command: string; sourceFile: string }> {
  const seen = new Set<string>();
  const suggestions: Array<{ testFile: string; command: string; sourceFile: string }> = [];

  for (const file of files) {
    const result = getTestSuggestion(file, cwd);
    if (result && !seen.has(result.testFile)) {
      seen.add(result.testFile);
      suggestions.push({ ...result, sourceFile: file });
    }
  }

  return suggestions;
}
