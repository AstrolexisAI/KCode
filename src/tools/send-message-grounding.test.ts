import { beforeEach, describe, expect, test } from "bun:test";
import { getTaskScopeManager } from "../core/task-scope";
import { executeSendMessage } from "./send-message";

describe("SendMessage grounding gate (v278 #111)", () => {
  beforeEach(() => getTaskScopeManager().reset());

  test("blocks operational guidance when scope phase is failed", async () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordRuntimeCommand({
      command: "bun run index.ts",
      exitCode: 1,
      output: "SyntaxError: Export named 'Client' not found",
      runtimeFailed: true,
      status: "failed_traceback",
      timestamp: Date.now(),
    });

    const result = await executeSendMessage({
      message:
        "Proyecto creado y listo. Start: cd /proj && bun run index.ts. Stop: Ctrl+C. Health: ps aux | grep 'bun run'. F1 para bloques, F2/F3 para transacciones.",
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
    expect(result.content).toContain("SendMessage refused");
  });

  test("blocks when patchAppliedAfterFailure && !rerunPassedAfterPatch (v277 EXACT)", async () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordRuntimeCommand({
      command: "bun run --check index.ts",
      exitCode: 1,
      output: "SyntaxError: Export named 'Client' not found",
      runtimeFailed: true,
      status: "failed_traceback",
      timestamp: Date.now(),
    });
    // Model patches rpc.ts (indirect fix — new isRelevantPatch logic arms gate)
    mgr.recordMutation({ tool: "Edit", path: "/proj/rpc.ts", at: Date.now() });
    const scope = mgr.current()!;
    expect(scope.verification.patchAppliedAfterFailure).toBe(true);

    const result = await executeSendMessage({
      message: "Start: cd /proj && bun run index.ts\nStop: Ctrl+C",
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/patch was applied.*re-run/i);
  });

  test("blocks when phase is blocked (configure/auth)", async () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordRuntimeCommand({
      command: "python test.py",
      exitCode: 0,
      output: "401 Unauthorized",
      runtimeFailed: true,
      status: "failed_auth",
      timestamp: Date.now(),
    });
    expect(mgr.current()!.phase).toBe("blocked");
    const result = await executeSendMessage({
      message: "Ready to run. Start: python main.py. Press Ctrl+C to stop.",
    });
    expect(result.is_error).toBe(true);
  });

  test("allows plain status update when scope is failed (no operational markers)", async () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordRuntimeCommand({
      command: "python main.py",
      exitCode: 1,
      output: "Traceback\nSyntaxError",
      runtimeFailed: true,
      status: "failed_traceback",
      timestamp: Date.now(),
    });
    const result = await executeSendMessage({
      message: "Analyzing the error output now.",
    });
    expect(result.is_error).toBeFalsy();
  });

  test("allows operational guidance when scope is verified/done", async () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordDirectoryVerified("/proj");
    mgr.recordRuntimeCommand({
      command: "python main.py",
      exitCode: 0,
      output: "ok, listening",
      runtimeFailed: false,
      status: "verified",
      timestamp: Date.now(),
    });
    // scope.completion.mayClaimReady default is true in empty scope
    const result = await executeSendMessage({
      message: "Start: python main.py\nStop: Ctrl+C\nHealth: ps aux | grep python",
    });
    expect(result.is_error).toBeFalsy();
  });

  test("empty / missing message rejected (preserves legacy behavior)", async () => {
    const result = await executeSendMessage({ message: "" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("message is required");
  });

  test("no active scope — falls through (no scope manager wiring)", async () => {
    // No beginNewScope called — getTaskScopeManager().current() is null
    const result = await executeSendMessage({
      message: "Start: python main.py\nStop: Ctrl+C",
    });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("[INFO]");
  });
});
