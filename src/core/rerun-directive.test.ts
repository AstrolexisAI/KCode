import { beforeEach, describe, expect, test } from "bun:test";
import {
  buildRerunDirective,
  deriveRerunCommand,
  extractRelevantPaths,
  isRelevantPatch,
} from "./rerun-directive";
import { getTaskScopeManager } from "./task-scope";

describe("rerun-directive", () => {
  beforeEach(() => {
    getTaskScopeManager().reset();
  });

  test("extractRelevantPaths pulls filename from failing command", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordRuntimeCommand({
      command: "python test_connection.py",
      exitCode: null,
      output: "Traceback (most recent call last):\n  File \"test_connection.py\", line 2\nModuleNotFoundError: No module named 'bitcoinrpc'",
      runtimeFailed: true,
      timestamp: Date.now(),
    });
    const relevant = extractRelevantPaths(mgr.current()!);
    expect(relevant.has("test_connection.py")).toBe(true);
  });

  test("isRelevantPatch hits for named file, misses for unrelated README", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordRuntimeCommand({
      command: "python3 main.py",
      exitCode: null,
      output: "  File \"main.py\", line 5\nImportError: cannot import name 'foo'",
      runtimeFailed: true,
      timestamp: Date.now(),
    });
    const scope = mgr.current()!;
    expect(isRelevantPatch("/proj/main.py", scope)).toBe(true);
    expect(isRelevantPatch("/proj/README.md", scope)).toBe(false);
    expect(isRelevantPatch("/proj/test_connection.py", scope)).toBe(false);
  });

  test("deriveRerunCommand prefers test_connection.py sanity check", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordMutation({ tool: "Write", path: "/proj/main.py", at: Date.now() });
    mgr.recordMutation({ tool: "Write", path: "/proj/test_connection.py", at: Date.now() });
    mgr.recordRuntimeCommand({
      command: "python main.py",
      exitCode: null,
      output: "Traceback: ImportError",
      runtimeFailed: true,
      timestamp: Date.now(),
    });
    // Apply a patch AFTER failure so the scope arms
    mgr.recordMutation({ tool: "Edit", path: "/proj/main.py", at: Date.now() });
    const cmd = deriveRerunCommand(mgr.current()!);
    expect(cmd).toBe("python3 /proj/test_connection.py");
  });

  test("deriveRerunCommand wraps TUI runners in timeout", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordRuntimeCommand({
      command: "python main.py",
      exitCode: null,
      output: "Traceback: crash",
      runtimeFailed: true,
      timestamp: Date.now(),
    });
    const cmd = deriveRerunCommand(mgr.current()!);
    expect(cmd).toBe("timeout 15 python main.py");
  });

  test("deriveRerunCommand does not double-wrap if timeout already present", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordRuntimeCommand({
      command: "timeout 10 python main.py",
      exitCode: null,
      output: "Traceback",
      runtimeFailed: true,
      timestamp: Date.now(),
    });
    const cmd = deriveRerunCommand(mgr.current()!);
    expect(cmd).toBe("timeout 10 python main.py");
  });

  test("buildRerunDirective mentions patched file and rerun command", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordRuntimeCommand({
      command: "python3 test_connection.py",
      exitCode: null,
      output: "ModuleNotFoundError",
      runtimeFailed: true,
      timestamp: Date.now(),
    });
    mgr.recordMutation({ tool: "Edit", path: "/proj/test_connection.py", at: Date.now() });
    const directive = buildRerunDirective(mgr.current()!);
    expect(directive).not.toBeNull();
    expect(directive!).toContain("test_connection.py");
    expect(directive!).toMatch(/Your next action MUST be a Bash call/);
    expect(directive!).toMatch(/python3 .*test_connection\.py/);
  });

  test("runtime failure + relevant edit arms patchAppliedAfterFailure", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordRuntimeCommand({
      command: "python main.py",
      exitCode: null,
      output: "  File \"main.py\"\nImportError",
      runtimeFailed: true,
      timestamp: Date.now(),
    });
    mgr.recordMutation({ tool: "Edit", path: "/proj/main.py", at: Date.now() });
    const scope = mgr.current()!;
    expect(scope.verification.patchAppliedAfterFailure).toBe(true);
    expect(scope.verification.rerunPassedAfterPatch).toBe(false);
  });

  test("runtime failure + UNRELATED edit does NOT arm gate", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordRuntimeCommand({
      command: "python main.py",
      exitCode: null,
      output: "  File \"main.py\"\nImportError",
      runtimeFailed: true,
      timestamp: Date.now(),
    });
    mgr.recordMutation({ tool: "Write", path: "/proj/README.md", at: Date.now() });
    const scope = mgr.current()!;
    expect(scope.verification.patchAppliedAfterFailure).toBe(false);
  });

  test("successful rerun clears the gate and resets attempts", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordRuntimeCommand({
      command: "python main.py",
      exitCode: null,
      output: "File \"main.py\"\nImportError",
      runtimeFailed: true,
      timestamp: Date.now(),
    });
    mgr.recordMutation({ tool: "Edit", path: "/proj/main.py", at: Date.now() });
    mgr.update({ verification: { rerunAttempts: 1 } });
    mgr.recordRuntimeCommand({
      command: "python main.py",
      exitCode: 0,
      output: "ok",
      runtimeFailed: false,
      timestamp: Date.now(),
    });
    const scope = mgr.current()!;
    expect(scope.verification.patchAppliedAfterFailure).toBe(false);
    expect(scope.verification.rerunPassedAfterPatch).toBe(true);
    expect(scope.verification.rerunAttempts).toBe(0);
  });

  test("new failure resets rerun counter", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordRuntimeCommand({
      command: "python main.py",
      exitCode: null,
      output: "File \"main.py\"\nImportError A",
      runtimeFailed: true,
      timestamp: Date.now(),
    });
    mgr.update({ verification: { rerunAttempts: 2 } });
    // A brand new failure (different command) should reset attempts
    mgr.recordRuntimeCommand({
      command: "python test_connection.py",
      exitCode: null,
      output: "File \"test_connection.py\"\nConnectionError B",
      runtimeFailed: true,
      timestamp: Date.now(),
    });
    const scope = mgr.current()!;
    expect(scope.verification.rerunAttempts).toBe(0);
  });

  test("no failure → deriveRerunCommand returns null", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    expect(deriveRerunCommand(mgr.current()!)).toBeNull();
    expect(buildRerunDirective(mgr.current()!)).toBeNull();
  });
});
