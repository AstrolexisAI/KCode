// KCode - Dream Tasks Tests

import { describe, expect, mock, test } from "bun:test";
import {
  analyzeUsageTask,
  builtinDreamTasks,
  maintenanceTask,
  preloadContextTask,
  reindexTask,
} from "./dream-tasks";
import type { DreamContext, DreamState } from "./types";

function makeState(overrides: Partial<DreamState> = {}): DreamState {
  return {
    sessionTurnCount: 0,
    idleSeconds: 0,
    ...overrides,
  };
}

function makeCtx(aborted = false): DreamContext {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    cwd: "/tmp",
    signal: controller.signal,
    log: mock(() => {}),
  };
}

// ─── reindexTask ───────────────────────────────────────────────────

describe("reindexTask", () => {
  test("shouldRun returns true when no lastIndexTime", () => {
    expect(reindexTask.shouldRun(makeState())).toBe(true);
  });

  test("shouldRun returns true when lastIndexTime is old", () => {
    const tenMinAgo = Date.now() - 11 * 60 * 1000;
    expect(reindexTask.shouldRun(makeState({ lastIndexTime: tenMinAgo }))).toBe(true);
  });

  test("shouldRun returns false when lastIndexTime is recent", () => {
    expect(reindexTask.shouldRun(makeState({ lastIndexTime: Date.now() }))).toBe(false);
  });

  test("execute returns completed result", async () => {
    const ctx = makeCtx();
    const result = await reindexTask.execute(ctx);
    expect(result.status).toBe("completed");
    expect(result.taskName).toBe("Reindex Codebase");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("execute respects abort signal", async () => {
    const ctx = makeCtx(true);
    const result = await reindexTask.execute(ctx);
    expect(result.status).toBe("interrupted");
  });

  test("has correct metadata", () => {
    expect(reindexTask.id).toBe("reindex");
    expect(reindexTask.priority).toBe(10);
    expect(reindexTask.timeoutMs).toBe(60_000);
    expect(reindexTask.interruptible).toBe(true);
  });
});

// ─── preloadContextTask ────────────────────────────────────────────

describe("preloadContextTask", () => {
  test("shouldRun returns false when turnCount is low", () => {
    expect(preloadContextTask.shouldRun(makeState({ sessionTurnCount: 2, idleSeconds: 60 }))).toBe(
      false,
    );
  });

  test("shouldRun returns false when idle is low", () => {
    expect(preloadContextTask.shouldRun(makeState({ sessionTurnCount: 5, idleSeconds: 10 }))).toBe(
      false,
    );
  });

  test("shouldRun returns true when turnCount > 3 and idle > 30", () => {
    expect(preloadContextTask.shouldRun(makeState({ sessionTurnCount: 5, idleSeconds: 35 }))).toBe(
      true,
    );
  });

  test("execute returns completed result", async () => {
    const ctx = makeCtx();
    const result = await preloadContextTask.execute(ctx);
    expect(result.status).toBe("completed");
    expect(result.taskName).toBe("Preload Context");
  });

  test("execute respects abort signal", async () => {
    const ctx = makeCtx(true);
    const result = await preloadContextTask.execute(ctx);
    expect(result.status).toBe("interrupted");
  });

  test("has correct metadata", () => {
    expect(preloadContextTask.id).toBe("preload-context");
    expect(preloadContextTask.priority).toBe(20);
    expect(preloadContextTask.timeoutMs).toBe(30_000);
    expect(preloadContextTask.interruptible).toBe(true);
  });
});

// ─── analyzeUsageTask ──────────────────────────────────────────────

describe("analyzeUsageTask", () => {
  test("shouldRun returns false when turnCount is low", () => {
    expect(analyzeUsageTask.shouldRun(makeState({ sessionTurnCount: 5 }))).toBe(false);
  });

  test("shouldRun returns true when turnCount > 10 and no lastAnalysisTime", () => {
    expect(analyzeUsageTask.shouldRun(makeState({ sessionTurnCount: 15 }))).toBe(true);
  });

  test("shouldRun returns true when lastAnalysisTime is old", () => {
    const sixteenMinAgo = Date.now() - 16 * 60 * 1000;
    expect(
      analyzeUsageTask.shouldRun(
        makeState({
          sessionTurnCount: 15,
          lastAnalysisTime: sixteenMinAgo,
        }),
      ),
    ).toBe(true);
  });

  test("shouldRun returns false when lastAnalysisTime is recent", () => {
    expect(
      analyzeUsageTask.shouldRun(
        makeState({
          sessionTurnCount: 15,
          lastAnalysisTime: Date.now(),
        }),
      ),
    ).toBe(false);
  });

  test("execute returns completed result", async () => {
    const ctx = makeCtx();
    const result = await analyzeUsageTask.execute(ctx);
    expect(result.status).toBe("completed");
    expect(result.taskName).toBe("Analyze Usage");
  });

  test("execute respects abort signal", async () => {
    const ctx = makeCtx(true);
    const result = await analyzeUsageTask.execute(ctx);
    expect(result.status).toBe("interrupted");
  });

  test("has correct metadata", () => {
    expect(analyzeUsageTask.id).toBe("analyze-usage");
    expect(analyzeUsageTask.priority).toBe(40);
    expect(analyzeUsageTask.timeoutMs).toBe(20_000);
    expect(analyzeUsageTask.interruptible).toBe(true);
  });
});

// ─── maintenanceTask ───────────────────────────────────────────────

describe("maintenanceTask", () => {
  test("shouldRun requires 120s idle", () => {
    expect(maintenanceTask.shouldRun(makeState({ idleSeconds: 60 }))).toBe(false);
    expect(maintenanceTask.shouldRun(makeState({ idleSeconds: 121 }))).toBe(true);
  });

  test("shouldRun returns false when lastMaintenanceTime is recent", () => {
    expect(
      maintenanceTask.shouldRun(
        makeState({
          idleSeconds: 200,
          lastMaintenanceTime: Date.now(),
        }),
      ),
    ).toBe(false);
  });

  test("shouldRun returns true when lastMaintenanceTime is old", () => {
    const thirtyOneMinAgo = Date.now() - 31 * 60 * 1000;
    expect(
      maintenanceTask.shouldRun(
        makeState({
          idleSeconds: 200,
          lastMaintenanceTime: thirtyOneMinAgo,
        }),
      ),
    ).toBe(true);
  });

  test("execute returns completed result", async () => {
    const ctx = makeCtx();
    const result = await maintenanceTask.execute(ctx);
    expect(result.status).toBe("completed");
    expect(result.taskName).toBe("Maintenance");
  });

  test("execute respects abort signal", async () => {
    const ctx = makeCtx(true);
    const result = await maintenanceTask.execute(ctx);
    expect(result.status).toBe("interrupted");
  });

  test("has correct metadata", () => {
    expect(maintenanceTask.id).toBe("maintenance");
    expect(maintenanceTask.priority).toBe(50);
    expect(maintenanceTask.timeoutMs).toBe(15_000);
    expect(maintenanceTask.interruptible).toBe(false);
  });
});

// ─── builtinDreamTasks ─────────────────────────────────────────────

describe("builtinDreamTasks", () => {
  test("contains all four tasks", () => {
    expect(builtinDreamTasks).toHaveLength(4);
    const ids = builtinDreamTasks.map((t) => t.id);
    expect(ids).toContain("reindex");
    expect(ids).toContain("preload-context");
    expect(ids).toContain("analyze-usage");
    expect(ids).toContain("maintenance");
  });

  test("tasks are sorted by priority", () => {
    for (let i = 1; i < builtinDreamTasks.length; i++) {
      expect(builtinDreamTasks[i]!.priority).toBeGreaterThanOrEqual(
        builtinDreamTasks[i - 1]!.priority,
      );
    }
  });

  test("priority order is reindex < preload < analyze < maintenance", () => {
    expect(builtinDreamTasks[0]!.id).toBe("reindex");
    expect(builtinDreamTasks[1]!.id).toBe("preload-context");
    expect(builtinDreamTasks[2]!.id).toBe("analyze-usage");
    expect(builtinDreamTasks[3]!.id).toBe("maintenance");
  });
});
