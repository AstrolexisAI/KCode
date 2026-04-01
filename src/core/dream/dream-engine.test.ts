// KCode - Dream Engine Tests

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { DreamEngine } from "./dream-engine";
import type { DreamTask, DreamContext, DreamResult, DreamState } from "./types";

function makeMockTask(overrides: Partial<DreamTask> = {}): DreamTask {
  return {
    id: overrides.id || "test-task",
    name: overrides.name || "Test Task",
    priority: overrides.priority ?? 10,
    timeoutMs: overrides.timeoutMs ?? 5000,
    interruptible: overrides.interruptible ?? true,
    shouldRun: overrides.shouldRun || (() => true),
    execute:
      overrides.execute ||
      (async (ctx: DreamContext): Promise<DreamResult> => ({
        taskName: overrides.name || "Test Task",
        status: "completed",
        durationMs: 1,
      })),
  };
}

function makeCtx(): Omit<DreamContext, "signal"> {
  return {
    cwd: "/tmp",
    log: mock(() => {}),
  };
}

describe("DreamEngine", () => {
  let engine: DreamEngine;

  beforeEach(() => {
    engine = new DreamEngine();
  });

  test("register adds tasks sorted by priority", () => {
    engine.register(makeMockTask({ id: "low", name: "Low", priority: 50 }));
    engine.register(makeMockTask({ id: "high", name: "High", priority: 5 }));
    engine.register(makeMockTask({ id: "mid", name: "Mid", priority: 25 }));

    const tasks = engine.getRegisteredTasks();
    expect(tasks).toHaveLength(3);
    expect(tasks[0].id).toBe("high");
    expect(tasks[1].id).toBe("mid");
    expect(tasks[2].id).toBe("low");
  });

  test("unregister removes tasks", () => {
    engine.register(makeMockTask({ id: "a" }));
    engine.register(makeMockTask({ id: "b" }));
    expect(engine.getRegisteredTasks()).toHaveLength(2);

    engine.unregister("a");
    const tasks = engine.getRegisteredTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("b");
  });

  test("startDreaming runs tasks that shouldRun", async () => {
    const executeMock = mock(
      async (): Promise<DreamResult> => ({
        taskName: "Runner",
        status: "completed",
        durationMs: 1,
      })
    );

    engine.register(
      makeMockTask({
        id: "runner",
        name: "Runner",
        shouldRun: () => true,
        execute: executeMock,
      })
    );

    const results = await engine.startDreaming(makeCtx());
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("completed");
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  test("startDreaming skips tasks where shouldRun returns false", async () => {
    const executeMock = mock(
      async (): Promise<DreamResult> => ({
        taskName: "Skipped",
        status: "completed",
        durationMs: 1,
      })
    );

    engine.register(
      makeMockTask({
        id: "skipped",
        name: "Skipped",
        shouldRun: () => false,
        execute: executeMock,
      })
    );

    const results = await engine.startDreaming(makeCtx());
    expect(results).toHaveLength(0);
    expect(executeMock).not.toHaveBeenCalled();
  });

  test("wake aborts running tasks", async () => {
    let resolveTask: (() => void) | undefined;

    engine.register(
      makeMockTask({
        id: "slow",
        name: "Slow Task",
        execute: async (ctx: DreamContext): Promise<DreamResult> => {
          return new Promise((resolve, reject) => {
            resolveTask = () =>
              resolve({
                taskName: "Slow Task",
                status: "completed",
                durationMs: 1,
              });
            ctx.signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true }
            );
          });
        },
      })
    );

    const resultPromise = engine.startDreaming(makeCtx());

    // Give the task time to start
    await new Promise((r) => setTimeout(r, 10));
    expect(engine.isRunning()).toBe(true);

    engine.wake();

    const results = await resultPromise;
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("interrupted");
  });

  test("wake resets idleSeconds and increments turnCount", () => {
    engine.tickIdle();
    engine.tickIdle();
    engine.tickIdle();
    expect(engine.getState().idleSeconds).toBe(3);
    expect(engine.getState().sessionTurnCount).toBe(0);

    engine.wake();
    expect(engine.getState().idleSeconds).toBe(0);
    expect(engine.getState().sessionTurnCount).toBe(1);
  });

  test("tickIdle increments idleSeconds", () => {
    expect(engine.getState().idleSeconds).toBe(0);
    engine.tickIdle();
    expect(engine.getState().idleSeconds).toBe(1);
    engine.tickIdle();
    expect(engine.getState().idleSeconds).toBe(2);
  });

  test("timeout produces error result", async () => {
    engine.register(
      makeMockTask({
        id: "timeout-task",
        name: "Timeout Task",
        timeoutMs: 50,
        execute: async (ctx: DreamContext): Promise<DreamResult> => {
          // Never resolves unless aborted
          return new Promise((resolve, reject) => {
            ctx.signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true }
            );
          });
        },
      })
    );

    const results = await engine.startDreaming(makeCtx());
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("error");
    expect(results[0].details).toContain("timed out");
  });

  test("aborted signal produces interrupted result", async () => {
    let taskStarted = false;

    engine.register(
      makeMockTask({
        id: "abort-task",
        name: "Abort Task",
        execute: async (ctx: DreamContext): Promise<DreamResult> => {
          taskStarted = true;
          return new Promise((resolve, reject) => {
            ctx.signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true }
            );
          });
        },
      })
    );

    const resultPromise = engine.startDreaming(makeCtx());
    await new Promise((r) => setTimeout(r, 10));
    expect(taskStarted).toBe(true);

    engine.wake();
    const results = await resultPromise;
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("interrupted");
  });

  test("tasks run in priority order", async () => {
    const order: string[] = [];

    for (const [id, priority] of [
      ["c", 30],
      ["a", 10],
      ["b", 20],
    ] as const) {
      engine.register(
        makeMockTask({
          id,
          name: id,
          priority,
          execute: async (): Promise<DreamResult> => {
            order.push(id);
            return { taskName: id, status: "completed", durationMs: 1 };
          },
        })
      );
    }

    await engine.startDreaming(makeCtx());
    expect(order).toEqual(["a", "b", "c"]);
  });

  test("double startDreaming returns empty if already running", async () => {
    engine.register(
      makeMockTask({
        id: "blocker",
        name: "Blocker",
        execute: async (ctx: DreamContext): Promise<DreamResult> => {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(
              () =>
                resolve({
                  taskName: "Blocker",
                  status: "completed",
                  durationMs: 100,
                }),
              100
            );
            ctx.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error("aborted"));
              },
              { once: true }
            );
          });
        },
      })
    );

    const ctx = makeCtx();
    const first = engine.startDreaming(ctx);

    // Second call while first is running
    await new Promise((r) => setTimeout(r, 10));
    const second = await engine.startDreaming(ctx);
    expect(second).toEqual([]);

    // Clean up the first
    engine.wake();
    await first;
  });

  test("getStatus returns correct state", () => {
    engine.register(makeMockTask({ id: "x" }));
    engine.register(makeMockTask({ id: "y" }));
    engine.tickIdle();

    const status = engine.getStatus();
    expect(status.running).toBe(false);
    expect(status.tasksCount).toBe(2);
    expect(status.state.idleSeconds).toBe(1);
    expect(status.state.sessionTurnCount).toBe(0);
  });

  test("updateState merges partial state", () => {
    engine.updateState({ lastIndexTime: 12345, sessionTurnCount: 5 });
    const state = engine.getState();
    expect(state.lastIndexTime).toBe(12345);
    expect(state.sessionTurnCount).toBe(5);
    expect(state.idleSeconds).toBe(0);
  });
});
