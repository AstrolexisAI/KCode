// KCode - Auto-Test Runner Tests

import { describe, test, expect } from "bun:test";
import { runTests, formatTestResult } from "./runner";

describe("runTests", () => {
  test("runs a successful command", async () => {
    const result = await runTests("echo hello", process.cwd());
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("captures failed command", async () => {
    const result = await runTests("false", process.cwd());
    expect(result.passed).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  test("handles non-existent command gracefully", async () => {
    const result = await runTests("nonexistent_command_xyz_123", process.cwd());
    expect(result.passed).toBe(false);
  });

  test("caps stdout length", async () => {
    const result = await runTests("echo short", process.cwd());
    expect(result.stdout.length).toBeLessThanOrEqual(10_000);
  });
});

describe("formatTestResult", () => {
  test("shows PASSED for successful run", () => {
    const output = formatTestResult({
      command: "bun test foo.test.ts",
      exitCode: 0,
      stdout: "1 pass",
      stderr: "",
      durationMs: 150,
      passed: true,
    });
    expect(output).toContain("PASSED");
    expect(output).toContain("150ms");
  });

  test("shows FAILED with stderr", () => {
    const output = formatTestResult({
      command: "bun test bar.test.ts",
      exitCode: 1,
      stdout: "",
      stderr: "AssertionError: expected 1 to be 2",
      durationMs: 200,
      passed: false,
    });
    expect(output).toContain("FAILED");
    expect(output).toContain("AssertionError");
  });
});
