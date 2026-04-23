// Tests for plan widget reconciliation from TaskScope state.
// Issue #111 v274 repro: UI widget showed 0/4 while grounded
// closeout showed 4/4 — two sources of truth. reconcilePlanFromScope
// overlays scope-derived completion onto the widget.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearActivePlan,
  getActivePlan,
  reconcilePlanFromScope,
  setActivePlanForTesting,
  type Plan,
} from "../tools/plan";
import { getTaskScopeManager } from "./task-scope";

function makePlan(steps: string[]): Plan {
  return {
    id: "test-plan",
    title: "Create Bitcoin TUI Dashboard",
    steps: steps.map((title, i) => ({
      id: String(i + 1),
      title,
      status: "pending",
    })),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("reconcilePlanFromScope", () => {
  beforeEach(() => {
    clearActivePlan();
    getTaskScopeManager().reset();
  });

  test("flips createProject to done once projectRoot.verified", () => {
    setActivePlanForTesting(
      makePlan([
        "Create project directory and initialize Python project",
        "Install dependencies",
      ]),
    );
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordDirectoryVerified("/proj/foo");

    const flipped = reconcilePlanFromScope();
    expect(flipped).toBe(1);
    const plan = getActivePlan()!;
    expect(plan.steps[0]!.status).toBe("done");
    expect(plan.steps[1]!.status).toBe("pending");
  });

  test("v274 EXACT repro: 3 files + started_unverified runtime → 3 done + 1 in_progress", () => {
    setActivePlanForTesting(
      makePlan([
        "Create project directory and initialize Python project",
        "Install dependencies (rich, bitcoinrpc)",
        "Write the main TUI application script with real-time blockchain analysis",
        "Test connection to Bitcoin node and run the dashboard",
      ]),
    );
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordDirectoryVerified("/proj/bitcoin-tui-dashboard");
    mgr.recordMutation({
      tool: "Write",
      path: "/proj/bitcoin-tui-dashboard/requirements.txt",
      at: Date.now(),
    });
    mgr.recordMutation({
      tool: "Write",
      path: "/proj/bitcoin-tui-dashboard/main.py",
      at: Date.now(),
    });
    mgr.recordRuntimeCommand({
      command: "timeout 5 python3 main.py",
      exitCode: 0,
      output: "Error: Request-sent",
      runtimeFailed: false,
      status: "started_unverified",
      timestamp: Date.now(),
    });

    reconcilePlanFromScope();
    const plan = getActivePlan()!;
    expect(plan.steps[0]!.status).toBe("done"); // create
    expect(plan.steps[1]!.status).toBe("done"); // install (requirements.txt)
    expect(plan.steps[2]!.status).toBe("done"); // write (main.py)
    expect(plan.steps[3]!.status).toBe("in_progress"); // runtime ran, not verified
  });

  test("verified runtime marks test step as done", () => {
    setActivePlanForTesting(
      makePlan([
        "Create project directory",
        "Test connection and run dashboard",
      ]),
    );
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordDirectoryVerified("/proj/foo");
    mgr.recordRuntimeCommand({
      command: "python test.py",
      exitCode: 0,
      output: "ok",
      runtimeFailed: false,
      status: "verified",
      timestamp: Date.now(),
    });
    reconcilePlanFromScope();
    expect(getActivePlan()!.steps[1]!.status).toBe("done");
  });

  test("failed_auth runtime does NOT flip test step to done", () => {
    setActivePlanForTesting(
      makePlan([
        "Create project directory",
        "Test connection to Bitcoin node",
      ]),
    );
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordDirectoryVerified("/proj/foo");
    mgr.recordRuntimeCommand({
      command: "python test.py",
      exitCode: 0,
      output: "401 Unauthorized",
      runtimeFailed: true,
      status: "failed_auth",
      timestamp: Date.now(),
    });
    reconcilePlanFromScope();
    expect(getActivePlan()!.steps[1]!.status).toBe("in_progress");
  });

  test("does not touch already-done or skipped steps", () => {
    const plan = makePlan(["Create project"]);
    plan.steps[0]!.status = "skipped";
    setActivePlanForTesting(plan);
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordDirectoryVerified("/proj/foo");
    const flipped = reconcilePlanFromScope();
    expect(flipped).toBe(0);
    expect(getActivePlan()!.steps[0]!.status).toBe("skipped");
  });

  test("no active plan → returns 0, does not throw", () => {
    expect(reconcilePlanFromScope()).toBe(0);
  });

  test("no scope → returns 0, does not throw", () => {
    setActivePlanForTesting(makePlan(["Create project"]));
    // No beginNewScope called — mgr.current() is null.
    expect(reconcilePlanFromScope()).toBe(0);
  });
});
