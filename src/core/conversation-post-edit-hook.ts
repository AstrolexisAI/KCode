// KCode - Post-Edit Feedback Hook
// After Write/Edit/MultiEdit tool calls, automatically runs the project's
// build check and related tests. Injects failures back into the conversation
// so the model must fix them before proceeding.

import { existsSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { log } from "./logger";
import type { ToolUseBlock } from "./types";

// ─── Types ──────────────────────────────────────────────────────

export type ProjectType =
  | "typescript-bun"
  | "typescript-npm"
  | "rust"
  | "go"
  | "python"
  | "unknown";

export interface PostEditFeedback {
  buildPassed: boolean;
  testsPassed: boolean;
  /** Non-null when there is actionable feedback to inject into the conversation. */
  message: string | null;
}

// ─── File extraction ────────────────────────────────────────────

/** Extract file paths modified by Write / Edit / MultiEdit tool calls. */
export function extractEditedFiles(toolCalls: ToolUseBlock[]): string[] {
  const files = new Set<string>();
  for (const tc of toolCalls) {
    const input = tc.input as Record<string, unknown>;
    if (tc.name === "Write" || tc.name === "Edit") {
      if (typeof input.file_path === "string") files.add(input.file_path);
    } else if (tc.name === "MultiEdit") {
      if (typeof input.file_path === "string") files.add(input.file_path);
      for (const edit of (input.edits ?? []) as Array<{ file_path?: string }>) {
        if (typeof edit.file_path === "string") files.add(edit.file_path);
      }
    }
  }
  return [...files];
}

// ─── Project detection ──────────────────────────────────────────

/** Detect the build system used in cwd. */
export function detectProjectType(cwd: string): ProjectType {
  if (existsSync(join(cwd, "tsconfig.json"))) {
    if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bunfig.toml"))) {
      return "typescript-bun";
    }
    return "typescript-npm";
  }
  if (existsSync(join(cwd, "Cargo.toml"))) return "rust";
  if (existsSync(join(cwd, "go.mod"))) return "go";
  if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py"))) {
    return "python";
  }
  return "unknown";
}

// ─── Related test discovery ─────────────────────────────────────

const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".test.js", ".spec.js"];

/** Find test files that correspond to the edited source files. */
export function findRelatedTests(files: string[], cwd: string): string[] {
  const tests: string[] = [];
  for (const file of files) {
    const dir = dirname(file);
    const base = file.replace(/\.(ts|tsx|js|jsx|mjs)$/, "");
    for (const suffix of TEST_SUFFIXES) {
      const candidate = base + suffix;
      if (existsSync(candidate)) {
        tests.push(candidate);
        break;
      }
    }
    // Also look in __tests__ subdirectory
    const basename = file.split("/").pop()?.replace(/\.(ts|tsx|js|jsx)$/, "") ?? "";
    if (basename) {
      const inTestsDir = join(dir, "__tests__", basename + ".test.ts");
      if (existsSync(inTestsDir)) tests.push(inTestsDir);
    }
  }
  // Deduplicate and filter out .skip files
  return [...new Set(tests)].filter((t) => !t.endsWith(".skip"));
}

// ─── Build check ────────────────────────────────────────────────

interface ShellResult {
  success: boolean;
  output: string;
}

function runCommand(cmd: string[], cwd: string, timeoutMs: number): ShellResult {
  try {
    const result = spawnSync(cmd[0]!, cmd.slice(1), {
      cwd,
      timeout: timeoutMs,
      encoding: "utf-8",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    const output = ((result.stdout ?? "") + (result.stderr ?? "")).trim();
    const success = result.status === 0 && !result.error;
    return { success, output };
  } catch (err) {
    return { success: false, output: String(err) };
  }
}

/** Run the project's type-check / build command. Returns null on success. */
export function runBuildCheck(
  cwd: string,
  projectType: ProjectType,
  timeoutMs = 30_000,
): ShellResult | null {
  switch (projectType) {
    case "typescript-bun":
      return runCommand(["bun", "run", "--bun", "tsc", "--noEmit"], cwd, timeoutMs);
    case "typescript-npm":
      return runCommand(["npx", "tsc", "--noEmit"], cwd, timeoutMs);
    case "rust":
      return runCommand(["cargo", "check", "--message-format=short"], cwd, timeoutMs);
    case "go":
      return runCommand(["go", "build", "./..."], cwd, timeoutMs);
    case "python":
      // mypy if available, else skip
      return null;
    default:
      return null;
  }
}

/** Run only the test files related to the edited source. */
export function runRelatedTests(
  testFiles: string[],
  cwd: string,
  timeoutMs = 30_000,
): ShellResult | null {
  if (testFiles.length === 0) return null;
  return runCommand(["bun", "test", ...testFiles], cwd, timeoutMs);
}

// ─── Error pattern detection ────────────────────────────────────

const COMPILE_ERROR_PATTERNS: RegExp[] = [
  /error TS\d+:/,              // TypeScript: error TS2304: ...
  /error\[E\d+\]/,             // Rust: error[E0308]: ...
  /\b[1-9]\d* errors?\b/,      // tsc summary: "3 errors" / "Found 3 errors in..."
  /^error:/m,                  // Go / cargo: error: ...
  /BUILD FAILED/i,             // Maven/Gradle
  /compilation failed/i,       // generic
  /SyntaxError:/,              // JS/Python syntax
  /Cannot find module/,        // JS missing module
];

const TEST_FAILURE_PATTERNS: RegExp[] = [
  /\b[1-9]\d* fail(s|ed)?\b/i, // "3 fail", "3 fails", "3 failed" — NOT "0 fail"
  /\bFAILED\b/,                // bun test: "FAILED src/..."
  /\d+ tests? failed/i,        // jest-style: "3 tests failed"
  /assertion.*failed/i,
  /AssertionError/,
];

/** Extract first N lines of error output, stripping ANSI codes. */
function summarizeOutput(output: string, maxLines = 15): string {
  return output
    .replace(/\x1B\[[0-9;]*m/g, "")   // strip ANSI
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, maxLines)
    .join("\n");
}

export function hasCompileErrors(output: string): boolean {
  return COMPILE_ERROR_PATTERNS.some((p) => p.test(output));
}

export function hasTestFailures(output: string): boolean {
  return TEST_FAILURE_PATTERNS.some((p) => p.test(output));
}

// ─── Error recovery injection ────────────────────────────────────

/**
 * Scan existing tool result contents for compilation / test failure patterns.
 * Returns a recovery directive string if failures are detected, null otherwise.
 * Used by the agent loop to inject a fix-directive before the next LLM turn.
 */
export function buildErrorRecoveryMessage(toolResultTexts: string[]): string | null {
  const combined = toolResultTexts.join("\n");
  const isCompileError = hasCompileErrors(combined);
  const isTestFailure = hasTestFailures(combined);
  if (!isCompileError && !isTestFailure) return null;

  const kind = isCompileError ? "COMPILATION ERROR" : "TEST FAILURE";
  const summary = summarizeOutput(combined, 20);
  return (
    `[KCODE POST-EDIT CHECK — ${kind} DETECTED]\n` +
    `The tool results above contain errors that MUST be fixed before proceeding.\n` +
    `Do NOT continue to the next task. Do NOT explain the error — FIX IT NOW.\n\n` +
    `Error summary:\n${summary}\n\n` +
    `Steps:\n` +
    `1. Read the error message carefully — identify the exact file and line.\n` +
    `2. Fix the root cause (not a workaround).\n` +
    `3. After fixing, re-run the build/tests to confirm green.\n` +
    `4. Only then continue with the original task.`
  );
}

// ─── Main entry point ────────────────────────────────────────────

export interface PostEditOptions {
  /**
   * Run the project's type-check / build command (e.g. tsc --noEmit, cargo check).
   * Disabled by default because full tsc can take 30+ seconds on large projects.
   * Enable via KCodeConfig.postEditTypeCheck: true.
   */
  runBuild?: boolean;
  /** Run only the test files that correspond to the edited sources. Default: true. */
  runTests?: boolean;
  /** Per-command timeout in ms. Defaults to 20s for tests, 30s for build. */
  testTimeoutMs?: number;
  buildTimeoutMs?: number;
}

/**
 * Run post-edit feedback after Write/Edit/MultiEdit tool calls.
 * Returns a feedback message to inject into the conversation, or null if all green.
 *
 * Default behavior: runs only related tests (fast, ~30-100ms).
 * Set runBuild: true to also run tsc/cargo check (opt-in due to latency).
 */
export async function runPostEditFeedback(
  toolCalls: ToolUseBlock[],
  cwd: string,
  opts: PostEditOptions = {},
): Promise<string | null> {
  const editCalls = toolCalls.filter((tc) =>
    tc.name === "Write" || tc.name === "Edit" || tc.name === "MultiEdit",
  );
  if (editCalls.length === 0) return null;

  const projectType = detectProjectType(cwd);
  if (projectType === "unknown") return null;

  const editedFiles = extractEditedFiles(editCalls);
  const errors: string[] = [];

  // Related tests (default ON — fast)
  if (opts.runTests !== false) {
    const testFiles = findRelatedTests(editedFiles, cwd);
    if (testFiles.length > 0) {
      const tests = runRelatedTests(testFiles, cwd, opts.testTimeoutMs ?? 20_000);
      if (tests && !tests.success) {
        log.warn("post-edit", `Tests failed:\n${tests.output.slice(0, 500)}`);
        errors.push(`TESTS FAILED (${testFiles.map((t) => t.split("/").pop()).join(", ")}):\n${summarizeOutput(tests.output, 20)}`);
      }
    }
  }

  // Type check / build (default OFF — expensive)
  if (opts.runBuild === true && errors.length === 0) {
    const build = runBuildCheck(cwd, projectType, opts.buildTimeoutMs ?? 30_000);
    if (build && !build.success) {
      log.warn("post-edit", `Build check failed:\n${build.output.slice(0, 500)}`);
      errors.push(`BUILD CHECK FAILED (${projectType}):\n${summarizeOutput(build.output, 20)}`);
    }
  }

  if (errors.length === 0) return null;

  const modifiedNames = editedFiles.map((f) => f.split("/").pop()).join(", ");
  return (
    `[KCODE POST-EDIT CHECK — FAILURE]\n` +
    `Files modified: ${modifiedNames}\n\n` +
    errors.join("\n\n") +
    `\n\nFix all errors above before continuing. Do NOT proceed to the next subtask until green.`
  );
}
