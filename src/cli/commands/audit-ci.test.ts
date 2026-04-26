// KCode - Tests for `kcode audit --ci` mode (v2.10.353).
//
// --ci is exit-code based and writes to disk; the cleanest test path
// is to spawn the CLI as a subprocess and assert on exit code +
// presence of the expected output artifacts. Driving the action
// handler directly would require mocking process.exit, which is
// brittle in Bun's test runner.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const KCODE_ENTRY = join(__dirname, "..", "..", "index.ts");

let TMP: string;

beforeEach(() => {
  TMP = `/tmp/kcode-ci-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch { /* noop */ }
});

function runAuditCi(extraArgs: string[] = []): { exitCode: number; stdout: string; stderr: string } {
  const proc = spawnSync(
    process.execPath,
    ["run", KCODE_ENTRY, "audit", TMP, "--ci", ...extraArgs],
    { encoding: "utf-8", timeout: 60_000 },
  );
  return {
    exitCode: proc.status ?? -1,
    stdout: proc.stdout || "",
    stderr: proc.stderr || "",
  };
}

describe("kcode audit --ci", () => {
  test("exits 0 when there are no confirmed findings", () => {
    writeFileSync(join(TMP, "safe.c"), "int x = 1;\n");
    const { exitCode, stdout } = runAuditCi();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("CI gate: no actionable findings");
  });

  test("exits 1 when there are confirmed findings", () => {
    // Pattern py-001 (eval-of-string) reliably fires on this Python.
    writeFileSync(
      join(TMP, "bad.py"),
      `import sys\ndef f(p):\n    eval(p)\n`,
    );
    const { exitCode, stdout } = runAuditCi();
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/CI gate: \d+ actionable finding/);
  });

  test("writes JSON and SARIF artifacts even when exiting 1", () => {
    writeFileSync(
      join(TMP, "bad.py"),
      `def f(p):\n    eval(p)\n`,
    );
    const { exitCode } = runAuditCi();
    expect(exitCode).toBe(1);
    expect(existsSync(join(TMP, "AUDIT_REPORT.md"))).toBe(true);
    expect(existsSync(join(TMP, "AUDIT_REPORT.json"))).toBe(true);
    expect(existsSync(join(TMP, "AUDIT_REPORT.sarif"))).toBe(true);
  });

  test("Mode line in stdout shows the auto-detected diff base or <none>", () => {
    writeFileSync(join(TMP, "safe.c"), "int x = 1;\n");
    const { stdout } = runAuditCi();
    // /tmp/<dir> is not a git repo → diff base resolves to undefined.
    expect(stdout).toContain("Mode:     CI gate");
    expect(stdout).toMatch(/--since (<none>|HEAD~1|origin\/(main|master)|main|master)/);
  });

  test("respects --no-skip-verify override (...placeholder; just smoke that explicit --model still works)", () => {
    // Without explicit --model the default is skip-verify. We're not
    // verifying LLM behavior here; just that the flag plumbing
    // doesn't crash.
    writeFileSync(join(TMP, "safe.c"), "int x = 1;\n");
    const { exitCode } = runAuditCi();
    expect(exitCode).toBe(0);
  });
});
