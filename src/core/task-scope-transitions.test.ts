// Transition tests for TaskScope — covers the failed_auth → configure/blocked
// flip and the plan progress derivation from verification state.

import { beforeEach, describe, expect, test } from "bun:test";
import { countDerivedCompletedSteps, renderCloseoutFromScope } from "./closeout-renderer";
import { getTaskScopeManager } from "./task-scope";

function newScaffoldScope() {
  const mgr = getTaskScopeManager();
  mgr.beginNewScope({
    type: "scaffold",
    userPrompt: "quiero un dashboard de TUI de bitcoin",
  });
  return mgr;
}

describe("task-scope: failed_auth → configure/blocked transition", () => {
  beforeEach(() => getTaskScopeManager().reset());

  test("scaffold scope flips to configure/blocked on failed_auth runtime", () => {
    const mgr = newScaffoldScope();
    mgr.recordDirectoryVerified("/home/curly/proyectos/bitcoin-tui-dashboard");
    mgr.recordMutation({
      tool: "Write",
      path: "/home/curly/proyectos/bitcoin-tui-dashboard/main.py",
      at: Date.now(),
    });
    mgr.recordRuntimeCommand({
      command: "python test_connection.py",
      exitCode: 0,
      output:
        "❌ RPC Error: -342: non-JSON HTTP response with '401 Unauthorized' from server",
      runtimeFailed: true,
      status: "failed_auth",
      timestamp: Date.now(),
    });
    const scope = mgr.current()!;
    expect(scope.type).toBe("configure");
    expect(scope.phase).toBe("blocked");
    expect(scope.completion.mayClaimReady).toBe(false);
    expect(scope.completion.reasons).toContain(
      "RPC authentication failed — credentials required",
    );
  });

  test("scaffold scope stays scaffold on failed_traceback (NOT auth)", () => {
    const mgr = newScaffoldScope();
    mgr.recordRuntimeCommand({
      command: "python main.py",
      exitCode: 1,
      output: "Traceback ...\nSyntaxError: invalid syntax",
      runtimeFailed: true,
      status: "failed_traceback",
      timestamp: Date.now(),
    });
    const scope = mgr.current()!;
    expect(scope.type).toBe("scaffold");
    expect(scope.phase).toBe("failed");
  });

  test("runner_misfire → phase=partial, NOT failed (v275 EXACT repro)", () => {
    const mgr = newScaffoldScope();
    mgr.recordDirectoryVerified("/proj/bitcoin-tui-dashboard");
    mgr.recordMutation({
      tool: "Write",
      path: "/proj/bitcoin-tui-dashboard/index.ts",
      at: Date.now(),
    });
    mgr.recordRuntimeCommand({
      command: "bun run index.ts",
      exitCode: null,
      output:
        "✗ Port 3000 is already in use.\n  Spawning bun-direct on this port would race and fail.",
      // runner_misfire is a runner-level issue — the app never ran,
      // so runtimeFailed is FALSE. The scope still transitions to
      // partial via the pre-runtimeFailed branch in recordRuntimeCommand.
      runtimeFailed: false,
      status: "runner_misfire",
      timestamp: Date.now(),
    });
    const scope = mgr.current()!;
    expect(scope.phase).toBe("partial");
    expect(scope.type).toBe("scaffold"); // NOT flipped to configure
    expect(scope.completion.reasons.some((r) => /wrong execution mode/i.test(r))).toBe(
      true,
    );
  });

  test("closeout for runner_misfire renders next-step text and suppresses generic verdict", () => {
    const mgr = newScaffoldScope();
    mgr.recordDirectoryVerified("/proj/bitcoin-tui-dashboard");
    mgr.recordMutation({
      tool: "Write",
      path: "/proj/bitcoin-tui-dashboard/index.ts",
      at: Date.now(),
    });
    mgr.recordRuntimeCommand({
      command: "bun run index.ts",
      exitCode: null,
      output:
        "Port 3000 is already in use. Spawning bun-direct on this port would race and fail.",
      runtimeFailed: false,
      status: "runner_misfire",
      timestamp: Date.now(),
    });
    const out = renderCloseoutFromScope(mgr.current()!);
    expect(out!).toContain("runner_misfire");
    expect(out!).toContain("verification runner");
    expect(out!).toMatch(/Next required step/i);
    expect(out!).toMatch(/bun index\.ts|bun run index\.ts/);
    // generic partial verdict should NOT also render — the misfire branch returns early
    expect(out!).not.toMatch(/Initial scaffold \/ MVP is in place/);
  });

  test("audit scope does NOT transition on failed_auth (stays audit)", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "audit", userPrompt: "audita el proyecto" });
    mgr.recordRuntimeCommand({
      command: "curl api",
      exitCode: 0,
      output: "HTTP 401 Unauthorized",
      runtimeFailed: true,
      status: "failed_auth",
      timestamp: Date.now(),
    });
    const scope = mgr.current()!;
    expect(scope.type).toBe("audit");
    expect(scope.phase).toBe("failed");
  });
});

describe("closeout: failed_auth renders configure/blocked next step", () => {
  beforeEach(() => getTaskScopeManager().reset());

  test("renders 'Runtime: failed_auth' line and credentials next step", () => {
    const mgr = newScaffoldScope();
    mgr.recordDirectoryVerified("/proj/bitcoin-tui-dashboard");
    mgr.recordMutation({ tool: "Write", path: "/proj/bitcoin-tui-dashboard/main.py", at: Date.now() });
    mgr.recordRuntimeCommand({
      command: "python test_connection.py",
      exitCode: 0,
      output: "❌ RPC Error: -342: non-JSON HTTP response with '401 Unauthorized'",
      runtimeFailed: true,
      status: "failed_auth",
      timestamp: Date.now(),
    });
    const out = renderCloseoutFromScope(mgr.current()!);
    expect(out).not.toBeNull();
    expect(out!).toContain("failed_auth");
    expect(out!).toContain("401");
    expect(out!).toContain("blocked by configuration");
    expect(out!).toMatch(/BITCOIN_RPC_USER|rpcuser/);
    expect(out!).toMatch(/Next required step/i);
  });

  test("renders 'Runtime: failed_dependency' line for ModuleNotFoundError", () => {
    const mgr = newScaffoldScope();
    mgr.recordRuntimeCommand({
      command: "python test_connection.py",
      exitCode: 1,
      output: "ModuleNotFoundError: No module named 'bitcoinrpc'",
      runtimeFailed: true,
      status: "failed_dependency",
      timestamp: Date.now(),
    });
    const out = renderCloseoutFromScope(mgr.current()!);
    expect(out!).toContain("failed_dependency");
    expect(out!).toContain("ModuleNotFound");
  });
});

describe("closeout: plan progress derived from verification state", () => {
  beforeEach(() => getTaskScopeManager().reset());

  test("counts createProject from projectRoot.verified", () => {
    const mgr = newScaffoldScope();
    mgr.update({
      progress: {
        plannedSteps: [
          "Create project directory",
          "Install dependencies",
          "Write main script",
          "Test connection",
        ],
      },
    });
    mgr.recordDirectoryVerified("/proj/foo");
    expect(countDerivedCompletedSteps(mgr.current()!)).toBe(1);
  });

  test("counts install/write/verify from filesWritten + runtime success", () => {
    const mgr = newScaffoldScope();
    mgr.update({
      progress: {
        plannedSteps: [
          "Create project directory",
          "Install dependencies",
          "Write the main TUI application script",
          "Test connection to Bitcoin node and run the dashboard",
        ],
      },
    });
    mgr.recordDirectoryVerified("/proj/foo");
    mgr.recordMutation({ tool: "Write", path: "/proj/foo/requirements.txt", at: Date.now() });
    mgr.recordMutation({ tool: "Write", path: "/proj/foo/main.py", at: Date.now() });
    mgr.recordRuntimeCommand({
      command: "python main.py",
      exitCode: 0,
      output: "ok",
      runtimeFailed: false,
      status: "verified",
      timestamp: Date.now(),
    });
    // create + install + write + verify = 4
    expect(countDerivedCompletedSteps(mgr.current()!)).toBe(4);
  });

  test("EXACT v273 state: 3 files written + failed_auth runtime → derived >= 3", () => {
    // Matches: create verified, install (requirements.txt touched),
    // write (main.py + test_connection.py), verify (FAILED → not counted)
    const mgr = newScaffoldScope();
    mgr.update({
      progress: {
        plannedSteps: [
          "Create project directory and initialize Python project",
          "Install dependencies (rich, bitcoinrpc)",
          "Write the main TUI application script",
          "Test connection to Bitcoin node",
        ],
      },
    });
    mgr.recordDirectoryVerified("/proj/bitcoin-tui-dashboard");
    mgr.recordMutation({ tool: "Write", path: "/proj/bitcoin-tui-dashboard/requirements.txt", at: Date.now() });
    mgr.recordMutation({ tool: "Write", path: "/proj/bitcoin-tui-dashboard/main.py", at: Date.now() });
    mgr.recordMutation({ tool: "Write", path: "/proj/bitcoin-tui-dashboard/test_connection.py", at: Date.now() });
    mgr.recordRuntimeCommand({
      command: "python test_connection.py",
      exitCode: 0,
      output: "401 Unauthorized",
      runtimeFailed: true,
      status: "failed_auth",
      timestamp: Date.now(),
    });
    // create verified + install (requirements.txt) + write (main.py) = 3
    // verify failed, not counted
    expect(countDerivedCompletedSteps(mgr.current()!)).toBe(3);
    const out = renderCloseoutFromScope(mgr.current()!);
    expect(out!).toMatch(/Plan progress: 3\/4/);
    expect(out!).toContain("(derived from verification)");
  });

  test("no Plan → no Plan progress line in closeout", () => {
    const mgr = newScaffoldScope();
    mgr.recordRuntimeCommand({
      command: "python m.py",
      exitCode: 1,
      output: "SyntaxError",
      runtimeFailed: true,
      status: "failed_traceback",
      timestamp: Date.now(),
    });
    const out = renderCloseoutFromScope(mgr.current()!);
    expect(out!).not.toContain("Plan progress:");
  });
});
