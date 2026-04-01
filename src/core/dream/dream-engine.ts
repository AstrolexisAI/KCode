// KCode - Dream Engine
// Core engine for running background tasks during idle periods

import type { DreamContext, DreamEngineConfig, DreamResult, DreamState, DreamTask } from "./types";
import { DEFAULT_DREAM_CONFIG } from "./types";

export class DreamEngine {
  private tasks: DreamTask[] = [];
  private running = false;
  private abortController?: AbortController;
  private state: DreamState = {
    sessionTurnCount: 0,
    idleSeconds: 0,
  };
  private config: DreamEngineConfig;

  constructor(config?: Partial<DreamEngineConfig>) {
    this.config = { ...DEFAULT_DREAM_CONFIG, ...config };
  }

  /**
   * Register a dream task. Tasks are kept sorted by priority (lower = more urgent).
   */
  register(task: DreamTask): void {
    this.tasks.push(task);
    this.tasks.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Remove a registered task by id.
   */
  unregister(taskId: string): void {
    this.tasks = this.tasks.filter((t) => t.id !== taskId);
  }

  /**
   * Run all eligible dream tasks in priority order.
   * Returns results for each task that was attempted.
   * If already running, returns an empty array.
   */
  async startDreaming(ctx: Omit<DreamContext, "signal">): Promise<DreamResult[]> {
    if (this.running) {
      return [];
    }

    this.running = true;
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    const results: DreamResult[] = [];

    const fullCtx: DreamContext = { ...ctx, signal };

    try {
      for (const task of this.tasks) {
        // Check if we've been aborted before starting next task
        if (signal.aborted) {
          break;
        }

        if (!task.shouldRun(this.state)) {
          continue;
        }

        const start = Date.now();
        const result = await this.executeTask(task, fullCtx, start);
        results.push(result);

        // If aborted during execution, don't continue to next task
        if (signal.aborted) {
          break;
        }
      }
    } finally {
      this.running = false;
      this.abortController = undefined;
    }

    return results;
  }

  /**
   * Execute a single task with timeout handling.
   */
  private async executeTask(
    task: DreamTask,
    ctx: DreamContext,
    startTime: number,
  ): Promise<DreamResult> {
    const { signal } = ctx;

    try {
      const result = await Promise.race([
        task.execute(ctx),
        this.createTimeout(task.timeoutMs, task.name),
        this.createAbortPromise(signal, task.name),
      ]);

      return result;
    } catch (err) {
      const durationMs = Date.now() - startTime;

      if (signal.aborted) {
        return {
          taskName: task.name,
          status: "interrupted",
          durationMs,
          details: "Task was interrupted by wake signal",
        };
      }

      return {
        taskName: task.name,
        status: "error",
        durationMs,
        details: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Create a promise that rejects after the given timeout.
   */
  private createTimeout(ms: number, taskName: string): Promise<DreamResult> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Dream task "${taskName}" timed out after ${ms}ms`));
      }, ms);
    });
  }

  /**
   * Create a promise that rejects when the abort signal fires.
   */
  private createAbortPromise(signal: AbortSignal, taskName: string): Promise<DreamResult> {
    return new Promise((_, reject) => {
      if (signal.aborted) {
        reject(new Error(`Dream task "${taskName}" was aborted`));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          reject(new Error(`Dream task "${taskName}" was aborted`));
        },
        { once: true },
      );
    });
  }

  /**
   * Wake the engine: abort any running tasks, reset idle, increment turn count.
   */
  wake(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.state.idleSeconds = 0;
    this.state.sessionTurnCount++;
  }

  /**
   * Increment the idle seconds counter.
   */
  tickIdle(): void {
    this.state.idleSeconds++;
  }

  /**
   * Whether the engine is currently running tasks.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get a copy of the current dream state.
   */
  getState(): DreamState {
    return { ...this.state };
  }

  /**
   * Merge partial state updates into the current state.
   */
  updateState(partial: Partial<DreamState>): void {
    Object.assign(this.state, partial);
  }

  /**
   * Get the list of registered tasks (sorted by priority).
   */
  getRegisteredTasks(): DreamTask[] {
    return [...this.tasks];
  }

  /**
   * Get a summary of the engine status.
   */
  getStatus(): { running: boolean; tasksCount: number; state: DreamState } {
    return {
      running: this.running,
      tasksCount: this.tasks.length,
      state: this.getState(),
    };
  }
}
