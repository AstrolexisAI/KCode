// KCode - Auto-Test Framework Detection
// Detects the test framework used in a project and maps modified files
// to their related test files for targeted test execution.

import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export type TestFramework =
  | "bun-test"
  | "vitest"
  | "jest"
  | "mocha"
  | "pytest"
  | "go-test"
  | "cargo-test"
  | "dotnet-test"
  | "unknown";

export interface DetectedFramework {
  framework: TestFramework;
  command: string;
  /** Pattern to find test files */
  testFilePattern: string;
  /** Confidence: 0-1 */
  confidence: number;
}

export interface TestMapping {
  sourceFile: string;
  testFiles: string[];
  framework: TestFramework;
  runCommand: string;
}

// ─── Framework Detection ───────────────────────────────────────

interface FrameworkSignal {
  framework: TestFramework;
  command: string;
  testFilePattern: string;
  /** Files or patterns that indicate this framework */
  indicators: Array<{ file: string; weight: number }>;
}

const FRAMEWORK_SIGNALS: FrameworkSignal[] = [
  {
    framework: "bun-test",
    command: "bun test",
    testFilePattern: "**/*.test.{ts,tsx,js,jsx}",
    indicators: [
      { file: "bunfig.toml", weight: 0.8 },
      { file: "bun.lockb", weight: 0.7 },
      { file: "bun.lock", weight: 0.7 },
    ],
  },
  {
    framework: "vitest",
    command: "npx vitest run",
    testFilePattern: "**/*.{test,spec}.{ts,tsx,js,jsx}",
    indicators: [
      { file: "vitest.config.ts", weight: 0.95 },
      { file: "vitest.config.js", weight: 0.95 },
      { file: "vitest.config.mts", weight: 0.95 },
    ],
  },
  {
    framework: "jest",
    command: "npx jest",
    testFilePattern: "**/*.{test,spec}.{ts,tsx,js,jsx}",
    indicators: [
      { file: "jest.config.ts", weight: 0.9 },
      { file: "jest.config.js", weight: 0.9 },
      { file: "jest.config.json", weight: 0.9 },
    ],
  },
  {
    framework: "mocha",
    command: "npx mocha",
    testFilePattern: "test/**/*.{ts,js}",
    indicators: [
      { file: ".mocharc.yml", weight: 0.9 },
      { file: ".mocharc.json", weight: 0.9 },
      { file: ".mocharc.js", weight: 0.9 },
    ],
  },
  {
    framework: "pytest",
    command: "pytest",
    testFilePattern: "**/test_*.py",
    indicators: [
      { file: "pytest.ini", weight: 0.95 },
      { file: "pyproject.toml", weight: 0.5 },
      { file: "setup.py", weight: 0.4 },
      { file: "conftest.py", weight: 0.8 },
    ],
  },
  {
    framework: "go-test",
    command: "go test ./...",
    testFilePattern: "**/*_test.go",
    indicators: [
      { file: "go.mod", weight: 0.9 },
      { file: "go.sum", weight: 0.7 },
    ],
  },
  {
    framework: "cargo-test",
    command: "cargo test",
    testFilePattern: "**/tests/**/*.rs",
    indicators: [
      { file: "Cargo.toml", weight: 0.95 },
      { file: "Cargo.lock", weight: 0.7 },
    ],
  },
  {
    framework: "dotnet-test",
    command: "dotnet test",
    testFilePattern: "**/*Tests.cs",
    indicators: [
      { file: "*.csproj", weight: 0.5 },
      { file: "*.sln", weight: 0.7 },
    ],
  },
];

/**
 * Detect the test framework used in the project directory.
 * Returns the best match with confidence score.
 */
export function detectFramework(projectDir: string): DetectedFramework {
  let best: DetectedFramework = {
    framework: "unknown",
    command: "",
    testFilePattern: "",
    confidence: 0,
  };

  for (const signal of FRAMEWORK_SIGNALS) {
    let totalWeight = 0;

    for (const indicator of signal.indicators) {
      const filePath = join(projectDir, indicator.file);
      // Handle glob patterns like *.csproj
      if (indicator.file.includes("*")) {
        try {
          const { readdirSync } = require("node:fs") as typeof import("node:fs");
          const files = readdirSync(projectDir);
          const ext = indicator.file.replace("*", "");
          if (files.some((f: string) => f.endsWith(ext))) {
            totalWeight += indicator.weight;
          }
        } catch {
          /* skip */
        }
      } else if (existsSync(filePath)) {
        totalWeight += indicator.weight;
      }
    }

    const confidence = Math.min(1, totalWeight);
    if (confidence > best.confidence) {
      best = {
        framework: signal.framework,
        command: signal.command,
        testFilePattern: signal.testFilePattern,
        confidence,
      };
    }
  }

  return best;
}

/**
 * Find test files related to a source file.
 * Checks common naming conventions:
 * - foo.ts → foo.test.ts, foo.spec.ts
 * - foo.py → test_foo.py
 * - foo.go → foo_test.go
 * - foo.rs → tests/foo.rs
 */
export function findRelatedTests(sourceFile: string, projectDir: string): string[] {
  const ext = extname(sourceFile);
  const base = basename(sourceFile, ext);
  const dir = dirname(sourceFile);
  const tests: string[] = [];

  // Common patterns per language
  const candidates: string[] = [];

  if ([".ts", ".tsx", ".js", ".jsx", ".mjs"].includes(ext)) {
    candidates.push(
      join(dir, `${base}.test${ext}`),
      join(dir, `${base}.spec${ext}`),
      join(dir, "__tests__", `${base}${ext}`),
      join(dir, "__tests__", `${base}.test${ext}`),
    );
  }

  if (ext === ".py") {
    candidates.push(
      join(dir, `test_${base}.py`),
      join(dir, "tests", `test_${base}.py`),
      join(dirname(dir), "tests", `test_${base}.py`),
    );
  }

  if (ext === ".go") {
    candidates.push(join(dir, `${base}_test.go`));
  }

  if (ext === ".rs") {
    candidates.push(join(dir, "tests", `${base}.rs`), join(dirname(dir), "tests", `${base}.rs`));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      tests.push(candidate);
    }
  }

  return tests;
}

/**
 * Build a test command for a set of modified files.
 * Detects framework and constructs the most targeted test command.
 */
export function buildTestCommand(modifiedFiles: string[], projectDir: string): TestMapping[] {
  const detected = detectFramework(projectDir);
  if (detected.framework === "unknown") return [];

  const mappings: TestMapping[] = [];

  for (const file of modifiedFiles) {
    const testFiles = findRelatedTests(file, projectDir);
    if (testFiles.length > 0) {
      // Build targeted command
      let runCommand = detected.command;
      if (
        detected.framework === "bun-test" ||
        detected.framework === "vitest" ||
        detected.framework === "jest"
      ) {
        runCommand += " " + testFiles.join(" ");
      } else if (detected.framework === "pytest") {
        runCommand += " " + testFiles.join(" ");
      } else if (detected.framework === "go-test") {
        const pkg = dirname(testFiles[0]).replace(projectDir, ".");
        runCommand = `go test ${pkg}`;
      }

      mappings.push({
        sourceFile: file,
        testFiles,
        framework: detected.framework,
        runCommand,
      });
    }
  }

  return mappings;
}
