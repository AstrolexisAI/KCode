// KCode - Test Engine: Intelligent Test Generator
//
// Machine phase: reads source, detects framework, finds existing tests,
// extracts function signatures, identifies edge cases.
// LLM only generates the test body with this pre-analyzed context.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

function readSafe(path: string, max = 200): string {
  try {
    return readFileSync(path, "utf-8").split("\n").slice(0, max).join("\n");
  } catch {
    return "";
  }
}

// ── Function Signature Extraction ──────────────────────────────

export interface FunctionInfo {
  name: string;
  params: string;
  returnType: string;
  line: number;
  isAsync: boolean;
  isExported: boolean;
}

function extractFunctions(content: string, language: string): FunctionInfo[] {
  const fns: FunctionInfo[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // TypeScript/JavaScript
    if (language === "typescript" || language === "javascript") {
      const m = line.match(
        /^(export\s+)?(async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(?)/,
      );
      if (m) {
        fns.push({
          name: m[3] ?? m[4] ?? "anonymous",
          params: line.match(/\(([^)]*)\)/)?.[1] ?? "",
          returnType: line.match(/\)\s*:\s*([^{=]+)/)?.[1]?.trim() ?? "unknown",
          line: i + 1,
          isAsync: !!m[2],
          isExported: !!m[1],
        });
      }
    }

    // Python
    if (language === "python") {
      const m = line.match(/^(\s*)(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
      if (m && !m[3]!.startsWith("_")) {
        fns.push({
          name: m[3]!,
          params: m[4] ?? "",
          returnType: line.match(/->\s*(\w+)/)?.[1] ?? "None",
          line: i + 1,
          isAsync: !!m[2],
          isExported: !m[1] || m[1].length === 0, // top-level = exported
        });
      }
    }

    // Go
    if (language === "go") {
      const m = line.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(([^)]*)\)\s*(.*)/);
      if (m && m[1]![0] === m[1]![0]!.toUpperCase()) {
        // exported = capitalized
        fns.push({
          name: m[1]!,
          params: m[2] ?? "",
          returnType: m[3]?.replace(/\{.*/, "").trim() ?? "",
          line: i + 1,
          isAsync: false,
          isExported: true,
        });
      }
    }
  }

  return fns;
}

// ── Edge Case Detection ────────────────────────────────────────

function detectEdgeCases(content: string, fns: FunctionInfo[]): string[] {
  const edges: string[] = [];

  // Null/undefined checks
  if (/null|undefined|None|nil/.test(content)) edges.push("null/undefined input");

  // Empty collections
  if (/\.length\s*===?\s*0|len\(\w+\)\s*==\s*0|\.is_empty\(\)/.test(content))
    edges.push("empty collection");

  // Boundary values
  if (/MAX_|MIN_|overflow|underflow|INT_MAX|Number\.MAX/.test(content))
    edges.push("boundary values (max/min)");

  // Error handling
  if (/try|catch|except|rescue|\.unwrap|\.expect/.test(content))
    edges.push("error/exception paths");

  // Auth/permissions
  if (/auth|permission|role|admin|token|session/i.test(content)) edges.push("unauthorized access");

  // Concurrency
  if (/async|await|Promise|goroutine|thread|mutex|lock/i.test(content))
    edges.push("concurrent/async behavior");

  // Negative numbers
  if (/amount|price|quantity|count|size/i.test(content)) edges.push("negative numbers");

  // Empty strings
  if (/\.trim\(\)|\.strip\(\)|\.len\(\)/.test(content)) edges.push("empty string input");

  // Duplicate entries
  if (/unique|duplicate|already\s*exists/i.test(content)) edges.push("duplicate entries");

  return edges;
}

// ── Test Framework Detection ───────────────────────────────────

interface TestFramework {
  name: string;
  importLine: string;
  describeBlock: string;
  testBlock: string;
  assertStyle: string;
  fileExtension: string;
}

function detectTestFramework(cwd: string, language: string): TestFramework {
  if (language === "typescript" || language === "javascript") {
    const pkg = existsSync(join(cwd, "package.json"))
      ? JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"))
      : {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) {
      return {
        name: "bun:test",
        importLine: 'import { describe, expect, test } from "bun:test";',
        describeBlock: "describe",
        testBlock: "test",
        assertStyle: "expect(X).toBe(Y)",
        fileExtension: ".test.ts",
      };
    }
    if (deps?.vitest) {
      return {
        name: "vitest",
        importLine: 'import { describe, expect, test } from "vitest";',
        describeBlock: "describe",
        testBlock: "test",
        assertStyle: "expect(X).toBe(Y)",
        fileExtension: ".test.ts",
      };
    }
    return {
      name: "jest",
      importLine: "",
      describeBlock: "describe",
      testBlock: "test",
      assertStyle: "expect(X).toBe(Y)",
      fileExtension: ".test.ts",
    };
  }

  if (language === "python") {
    return {
      name: "pytest",
      importLine: "import pytest",
      describeBlock: "class Test",
      testBlock: "def test_",
      assertStyle: "assert X == Y",
      fileExtension: "_test.py",
    };
  }

  if (language === "go") {
    return {
      name: "testing",
      importLine: 'import "testing"',
      describeBlock: "func Test",
      testBlock: "func Test",
      assertStyle: 'if got != want { t.Errorf("got %v, want %v", got, want) }',
      fileExtension: "_test.go",
    };
  }

  if (language === "rust") {
    return {
      name: "cargo test",
      importLine: "#[cfg(test)]",
      describeBlock: "mod tests",
      testBlock: "#[test] fn",
      assertStyle: "assert_eq!(X, Y)",
      fileExtension: ".rs",
    };
  }

  return {
    name: "generic",
    importLine: "",
    describeBlock: "describe",
    testBlock: "test",
    assertStyle: "assert(X === Y)",
    fileExtension: ".test.ts",
  };
}

// ── Main: Build Test Prompt ────────────────────────────────────

export interface TestGenResult {
  functions: FunctionInfo[];
  edgeCases: string[];
  framework: TestFramework;
  existingTestExample: string;
  prompt: string;
  targetTestFile: string;
}

export function buildTestPrompt(
  targetFile: string,
  userRequest: string,
  cwd: string,
): TestGenResult {
  const fullPath = join(cwd, targetFile);
  const content = readSafe(fullPath);
  const ext = extname(targetFile);
  const language =
    ext === ".ts" || ext === ".tsx"
      ? "typescript"
      : ext === ".js" || ext === ".jsx"
        ? "javascript"
        : ext === ".py"
          ? "python"
          : ext === ".go"
            ? "go"
            : ext === ".rs"
              ? "rust"
              : "unknown";

  const functions = extractFunctions(content, language);
  const edgeCases = detectEdgeCases(content, functions);
  const framework = detectTestFramework(cwd, language);

  // Find existing test as example
  const base = basename(targetFile, ext);
  const dir = dirname(targetFile);
  let existingTestExample = "";
  const testCandidates = [
    join(dir, `${base}${framework.fileExtension}`),
    join(dir, `${base}.test${ext}`),
    join(dir, `${base}.spec${ext}`),
  ];
  for (const tc of testCandidates) {
    const full = join(cwd, tc);
    if (existsSync(full)) {
      existingTestExample = readSafe(full, 50);
      break;
    }
  }
  // If no specific test, find any test in the project as style reference
  if (!existingTestExample) {
    const anyTest = run(
      `find . -name "*${framework.fileExtension}" -not -path "*/node_modules/*" 2>/dev/null | head -1`,
      cwd,
    );
    if (anyTest) existingTestExample = readSafe(join(cwd, anyTest), 40);
  }

  const targetTestFile = join(dir, `${base}${framework.fileExtension}`);

  const prompt = `Generate tests for the following code.

USER REQUEST: "${userRequest}"

## Source Code (${targetFile})
\`\`\`
${content}
\`\`\`

## Functions to Test (extracted by machine)
${functions.map((f) => `- ${f.isAsync ? "async " : ""}${f.name}(${f.params})${f.returnType !== "unknown" ? " → " + f.returnType : ""} [line ${f.line}]${f.isExported ? " (exported)" : ""}`).join("\n")}

## Edge Cases to Cover (detected by machine)
${edgeCases.map((e) => `- ${e}`).join("\n")}

## Test Framework: ${framework.name}
Import: ${framework.importLine}
Assert style: ${framework.assertStyle}

${existingTestExample ? `## Existing Test Example (MATCH THIS STYLE)\n\`\`\`\n${existingTestExample}\n\`\`\`` : ""}

## Requirements
1. Test file: ${targetTestFile}
2. Test EVERY exported function listed above
3. Cover ALL edge cases listed above
4. Minimum 3 tests per function (happy path, edge case, error case)
5. Match the existing test style exactly
6. Use the correct import/assert patterns for ${framework.name}
7. Do NOT mock unless absolutely necessary — prefer real inputs`;

  return { functions, edgeCases, framework, existingTestExample, prompt, targetTestFile };
}
