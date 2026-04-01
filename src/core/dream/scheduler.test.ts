// KCode - Dream Scheduler Tests

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { DreamScheduler } from "./scheduler";
import { DreamEngine } from "./dream-engine";
import type { DreamResult } from "./types";

function makeTask(
  id: string,
  priority: number,
  shouldRun: boolean = true
) {
  return {
    id,
    name: `Task ${id}`,
    priority,
    timeoutMs: 5000,
    interruptible: true,
    shouldRun: () => shouldRun,
    execute: async (): Promise<DreamResult> => ({
      taskName: `Task ${id}`,
      status: "completed" as const,
      durationMs: 1,
    }),
  };
}

describe("DreamScheduler", () => {
  let engine: DreamEngine;
  let scheduler: DreamScheduler;

  beforeEach(() => {
    engine = new DreamEngine();
    scheduler = new DreamScheduler(engine);
  });

  afterEach(() => {
    scheduler.destroy();
  });

  test("onUserActivity resets idle state", () => {
    engine.tickIdle();
    engine.tickIdle();
    engine.tickIdle();
    expect(engine.getState().idleSeconds).toBe(3);

    scheduler.onUserActivity();
    expect(engine.getState().idleSeconds).toBe(0);
    expect(engine.getState().sessionTurnCount).toBe(1);
  });

  test("getNextTaskEstimate returns estimate for upcoming task", () => {
    engine.register(makeTask("a", 10, true));

    const estimate = scheduler.getNextTaskEstimate();
    expect(estimate).not.toBeNull();
    expect(estimate!.taskName).toBe("Task a");
    expect(estimate!.estimatedSeconds).toBe(30); // default idle threshold
  });

  test("getNextTaskEstimate returns reduced estimate after idle ticks", () => {
    engine.register(makeTask("a", 10, true));

    // Simulate some idle time
    for (let i = 0; i < 10; i++) {
      engine.tickIdle();
    }

    const estimate = scheduler.getNextTaskEstimate();
    expect(estimate).not.toBeNull();
    expect(estimate!.estimatedSeconds).toBe(20); // 30 - 10
  });

  test("getNextTaskEstimate returns null when no tasks pending", () => {
    engine.register(makeTask("a", 10, false));

    const estimate = scheduler.getNextTaskEstimate();
    expect(estimate).toBeNull();
  });

  test("getNextTaskEstimate returns null with no tasks", () => {
    const estimate = scheduler.getNextTaskEstimate();
    expect(estimate).toBeNull();
  });

  test("destroy cleans up timers", () => {
    scheduler.startIdleTracking();
    expect(scheduler.isIdle()).toBe(true);

    scheduler.destroy();
    expect(scheduler.isIdle()).toBe(false);
  });

  test("isIdle reflects state correctly", () => {
    // Not idle before tracking starts
    expect(scheduler.isIdle()).toBe(false);

    // Idle once tracking begins
    scheduler.startIdleTracking();
    expect(scheduler.isIdle()).toBe(true);

    // Stop tracking
    scheduler.stopIdleTracking();
    expect(scheduler.isIdle()).toBe(false);
  });

  test("runPendingTasks manually triggers dream tasks", async () => {
    const executeMock = mock(
      async (): Promise<DreamResult> => ({
        taskName: "Manual",
        status: "completed",
        durationMs: 1,
      })
    );

    engine.register({
      id: "manual",
      name: "Manual",
      priority: 10,
      timeoutMs: 5000,
      interruptible: true,
      shouldRun: () => true,
      execute: executeMock,
    });

    const results = await scheduler.runPendingTasks({
      cwd: "/tmp",
      log: () => {},
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("completed");
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  test("onUserActivity restarts idle tracking if active", () => {
    scheduler.startIdleTracking();
    engine.tickIdle();
    engine.tickIdle();

    scheduler.onUserActivity();
    // After activity, idle should be reset but tracking continues
    expect(engine.getState().idleSeconds).toBe(0);
    expect(scheduler.isIdle()).toBe(true);
  });
});
