// KCode - Dream Scheduler
// Priority scheduler that triggers dream tasks during idle periods

import type { DreamContext, DreamEngineConfig, DreamResult } from "./types";
import { DEFAULT_DREAM_CONFIG } from "./types";
import { DreamEngine } from "./dream-engine";

export class DreamScheduler {
  private engine: DreamEngine;
  private config: DreamEngineConfig;
  private timer: Timer | null = null;
  private idleTimer: Timer | null = null;
  private dreamingCtx: Omit<DreamContext, "signal"> | null = null;

  constructor(engine: DreamEngine, config?: Partial<DreamEngineConfig>) {
    this.engine = engine;
    this.config = { ...DEFAULT_DREAM_CONFIG, ...config };
  }

  /**
   * Start tracking idle time. Every second, increments idle counter.
   * When idle threshold is reached, triggers dream tasks automatically.
   */
  startIdleTracking(ctx?: Omit<DreamContext, "signal">): void {
    this.stopIdleTracking();

    this.dreamingCtx = ctx || { cwd: process.cwd(), log: () => {} };

    this.idleTimer = setInterval(() => {
      this.engine.tickIdle();

      const state = this.engine.getState();
      if (
        state.idleSeconds >= this.config.idleThresholdSeconds &&
        !this.engine.isRunning() &&
        this.config.enabled
      ) {
        this.startDreaming();
      }
    }, 1000);
  }

  /**
   * Stop tracking idle time.
   */
  stopIdleTracking(): void {
    if (this.idleTimer !== null) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * Signal user activity: wake the engine and restart idle tracking.
   */
  onUserActivity(): void {
    this.engine.wake();
    const ctx = this.dreamingCtx;
    if (this.idleTimer !== null) {
      this.stopIdleTracking();
      this.startIdleTracking(ctx || undefined);
    }
  }

  /**
   * Manually trigger dream tasks.
   */
  async runPendingTasks(
    ctx: Omit<DreamContext, "signal">
  ): Promise<DreamResult[]> {
    return this.engine.startDreaming(ctx);
  }

  /**
   * Estimate when the next task will be eligible to run.
   * Returns null if no tasks are pending.
   */
  getNextTaskEstimate(): {
    taskName: string;
    estimatedSeconds: number;
  } | null {
    const state = this.engine.getState();
    const tasks = this.engine.getRegisteredTasks();

    for (const task of tasks) {
      if (task.shouldRun(state)) {
        // Task is ready now, estimate is based on idle threshold
        const remaining = Math.max(
          0,
          this.config.idleThresholdSeconds - state.idleSeconds
        );
        return {
          taskName: task.name,
          estimatedSeconds: remaining,
        };
      }
    }

    // No tasks currently eligible
    return null;
  }

  /**
   * Whether the engine is in idle state (not running tasks and tracking idle).
   */
  isIdle(): boolean {
    return !this.engine.isRunning() && this.idleTimer !== null;
  }

  /**
   * Clean up all timers and resources.
   */
  destroy(): void {
    this.stopIdleTracking();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.engine.wake();
    this.dreamingCtx = null;
  }

  /**
   * Internal: trigger dream task execution.
   */
  private async startDreaming(): Promise<void> {
    if (!this.dreamingCtx) return;
    await this.engine.startDreaming(this.dreamingCtx);
  }
}
