// KCode - Built-in Dream Tasks
// Background tasks that run during idle periods

import type { DreamContext, DreamResult, DreamState, DreamTask } from "./types";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

/**
 * Helper to create a DreamResult with timing.
 */
function makeResult(
  taskName: string,
  status: DreamResult["status"],
  startTime: number,
  details?: string,
): DreamResult {
  return {
    taskName,
    status,
    durationMs: Date.now() - startTime,
    details,
  };
}

/**
 * Helper to check if enough time has passed since a timestamp.
 */
function timeSince(timestamp: number | undefined, thresholdMs: number): boolean {
  if (timestamp === undefined) return true;
  return Date.now() - timestamp >= thresholdMs;
}

/**
 * Reindex task - refreshes the codebase index.
 * Priority 10 (highest urgency among dream tasks).
 * Runs when no index exists or index is older than 10 minutes.
 */
export const reindexTask: DreamTask = {
  id: "reindex",
  name: "Reindex Codebase",
  priority: 10,
  timeoutMs: 60_000,
  interruptible: true,

  shouldRun(state: DreamState): boolean {
    return timeSince(state.lastIndexTime, TEN_MINUTES_MS);
  },

  async execute(ctx: DreamContext): Promise<DreamResult> {
    const start = Date.now();

    if (ctx.signal.aborted) {
      return makeResult(this.name, "interrupted", start, "Aborted before start");
    }

    ctx.log("reindexing...");

    // Simulate indexing work
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 50);
      ctx.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });

    if (ctx.signal.aborted) {
      return makeResult(this.name, "interrupted", start, "Aborted during execution");
    }

    return makeResult(this.name, "completed", start, "Codebase reindex completed");
  },
};

/**
 * Preload context task - preloads likely-needed files into context.
 * Priority 20.
 * Runs when the session has more than 3 turns and has been idle for 30+ seconds.
 */
export const preloadContextTask: DreamTask = {
  id: "preload-context",
  name: "Preload Context",
  priority: 20,
  timeoutMs: 30_000,
  interruptible: true,

  shouldRun(state: DreamState): boolean {
    return state.sessionTurnCount > 3 && state.idleSeconds > 30;
  },

  async execute(ctx: DreamContext): Promise<DreamResult> {
    const start = Date.now();

    if (ctx.signal.aborted) {
      return makeResult(this.name, "interrupted", start, "Aborted before start");
    }

    ctx.log("preloading context...");

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 30);
      ctx.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });

    if (ctx.signal.aborted) {
      return makeResult(this.name, "interrupted", start, "Aborted during execution");
    }

    return makeResult(this.name, "completed", start, "Context preloading completed");
  },
};

/**
 * Analyze usage task - analyzes usage patterns for insights.
 * Priority 40.
 * Runs when session has 10+ turns and no recent analysis (15 min threshold).
 */
export const analyzeUsageTask: DreamTask = {
  id: "analyze-usage",
  name: "Analyze Usage",
  priority: 40,
  timeoutMs: 20_000,
  interruptible: true,

  shouldRun(state: DreamState): boolean {
    return state.sessionTurnCount > 10 && timeSince(state.lastAnalysisTime, FIFTEEN_MINUTES_MS);
  },

  async execute(ctx: DreamContext): Promise<DreamResult> {
    const start = Date.now();

    if (ctx.signal.aborted) {
      return makeResult(this.name, "interrupted", start, "Aborted before start");
    }

    ctx.log("analyzing usage patterns...");

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 30);
      ctx.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });

    if (ctx.signal.aborted) {
      return makeResult(this.name, "interrupted", start, "Aborted during execution");
    }

    return makeResult(this.name, "completed", start, "Usage analysis completed");
  },
};

/**
 * Maintenance task - performs cleanup and optimization.
 * Priority 50 (lowest urgency).
 * Runs when idle for 120+ seconds and no recent maintenance (30 min threshold).
 * Not interruptible - should complete once started.
 */
export const maintenanceTask: DreamTask = {
  id: "maintenance",
  name: "Maintenance",
  priority: 50,
  timeoutMs: 15_000,
  interruptible: false,

  shouldRun(state: DreamState): boolean {
    return state.idleSeconds > 120 && timeSince(state.lastMaintenanceTime, THIRTY_MINUTES_MS);
  },

  async execute(ctx: DreamContext): Promise<DreamResult> {
    const start = Date.now();

    if (ctx.signal.aborted) {
      return makeResult(this.name, "interrupted", start, "Aborted before start");
    }

    ctx.log("running maintenance...");

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 30);
      ctx.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });

    if (ctx.signal.aborted) {
      return makeResult(this.name, "interrupted", start, "Aborted during execution");
    }

    return makeResult(this.name, "completed", start, "Maintenance completed");
  },
};

/**
 * All built-in dream tasks, sorted by priority.
 */
export const builtinDreamTasks: DreamTask[] = [
  reindexTask,
  preloadContextTask,
  analyzeUsageTask,
  maintenanceTask,
].sort((a, b) => a.priority - b.priority);
