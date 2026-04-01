// KCode - Auto-Test Runner
// Executes detected test commands and returns structured results.

import { log } from "../logger";
import type { TestRunResult } from "./types";

/**
 * Run a test command and return structured results.
 */
export async function runTests(command: string, cwd: string): Promise<TestRunResult> {
  const start = Date.now();

  try {
    const parts = command.split(" ");
    const proc = Bun.spawn(parts, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const durationMs = Date.now() - start;

    return {
      command,
      exitCode,
      stdout: stdout.slice(0, 10_000), // Cap output
      stderr: stderr.slice(0, 5_000),
      durationMs,
      passed: exitCode === 0,
    };
  } catch (err) {
    log.debug("auto-test/runner", `Error running "${command}": ${err}`);
    return {
      command,
      exitCode: 1,
      stdout: "",
      stderr: String(err),
      durationMs: Date.now() - start,
      passed: false,
    };
  }
}

/**
 * Format test results for display.
 */
export function formatTestResult(result: TestRunResult): string {
  const status = result.passed ? "\x1b[32m✓ PASSED\x1b[0m" : "\x1b[31m✗ FAILED\x1b[0m";
  const lines: string[] = [`  ${status} in ${result.durationMs}ms`, `  Command: ${result.command}`];

  if (!result.passed && result.stderr) {
    lines.push("");
    lines.push("  Stderr:");
    for (const line of result.stderr.split("\n").slice(0, 10)) {
      lines.push(`    ${line}`);
    }
  }

  return lines.join("\n");
}
