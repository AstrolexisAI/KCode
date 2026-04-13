// KCode - Streaming Tool Executor
// Ported from Claude Code's pattern: start executing read-only tools while
// the model is still streaming, instead of waiting for the stream to finish.

import { log } from "./logger";
import type { PermissionManager } from "./permissions";
import type { ToolRegistry } from "./tool-registry";
import type { ContentBlock, KCodeConfig, StreamEvent, ToolUseBlock } from "./types";

// ─── Types ──────────────────────────────────────────────────────

interface ToolExecResult {
  toolUseId: string;
  name: string;
  result: string;
  isError: boolean;
  durationMs: number;
}

interface QueuedTool {
  toolCall: ToolUseBlock;
  status: "queued" | "executing" | "done";
  result?: ToolExecResult;
  promise?: Promise<ToolExecResult>;
}

export interface StreamingToolExecutorConfig {
  tools: ToolRegistry;
  permissions: PermissionManager;
  config: KCodeConfig;
  abortSignal?: AbortSignal;
  /**
   * Optional predicate to veto a pending tool call before it is dispatched.
   * Used by the conversation loop to skip tools whose error fingerprint was
   * already burned — otherwise the streaming fast-path would re-execute a
   * known-broken call before the burn check in the post-stream path runs.
   */
  shouldSkip?: (toolCall: ToolUseBlock) => boolean;
}

// ─── StreamingToolExecutor ──────────────────────────────────────

/**
 * Executes read-only tools concurrently with model streaming.
 *
 * When a tool_use block is fully received during streaming, this executor
 * checks if it's read-only (Glob, Grep, Read, LS, etc.) and if permissions
 * allow auto-execution. If so, it starts execution immediately instead of
 * waiting for the stream to finish.
 *
 * Write tools and permission-gated tools are queued but NOT started until
 * the stream completes (to preserve the existing sequential flow).
 */
export class StreamingToolExecutor {
  private queue: QueuedTool[] = [];
  private cfg: StreamingToolExecutorConfig;
  private events: StreamEvent[] = [];

  constructor(cfg: StreamingToolExecutorConfig) {
    this.cfg = cfg;
  }

  /**
   * Add a completed tool call from the stream.
   * If it's read-only and auto-permitted, start executing immediately.
   */
  addTool(toolCall: ToolUseBlock): void {
    // Veto: honor burned-fingerprint guard so retries of already-failed tools
    // never enter the streaming fast-path. The post-stream check would catch
    // them later, but by then the real execution has already happened.
    if (this.cfg.shouldSkip?.(toolCall)) {
      return;
    }

    const queued: QueuedTool = { toolCall, status: "queued" };
    this.queue.push(queued);

    // Only auto-start if: read-only tool + auto permission mode
    const isReadOnly = this.cfg.tools.isParallelSafe(toolCall.name);
    const isAutoMode = this.cfg.permissions.getMode() === "auto";

    if (isReadOnly && isAutoMode && !this.cfg.abortSignal?.aborted) {
      this.startExecution(queued);
    }
  }

  /**
   * Get results that are already completed (non-blocking).
   * Returns in order — only yields consecutive completed results from the front.
   */
  getCompletedResults(): ToolExecResult[] {
    const results: ToolExecResult[] = [];
    for (const item of this.queue) {
      if (item.status === "done" && item.result) {
        results.push(item.result);
      } else {
        break; // Stop at first non-completed to maintain order
      }
    }
    // Remove yielded items from queue
    if (results.length > 0) {
      this.queue.splice(0, results.length);
    }
    return results;
  }

  /**
   * Get accumulated UI events (tool_executing, tool_result) from background executions.
   */
  drainEvents(): StreamEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  /**
   * Wait for all remaining queued/executing tools to complete.
   * Returns results in order.
   */
  async waitForAll(): Promise<ToolExecResult[]> {
    const results: ToolExecResult[] = [];
    for (const item of this.queue) {
      if (item.status === "done" && item.result) {
        results.push(item.result);
      } else if (item.promise) {
        const result = await item.promise;
        results.push(result);
      }
      // "queued" items that were never started are returned as-is (caller handles them)
    }
    this.queue = [];
    return results;
  }

  /**
   * Get tool calls that were queued but never started (write tools, permission-gated).
   * These need to be executed by the normal sequential/parallel flow.
   */
  getUnstartedTools(): ToolUseBlock[] {
    return this.queue
      .filter((item) => item.status === "queued")
      .map((item) => item.toolCall);
  }

  /**
   * Check if any tools are currently executing in the background.
   */
  hasActiveExecutions(): boolean {
    return this.queue.some((item) => item.status === "executing");
  }

  /**
   * Number of tools that were started early (during streaming).
   */
  get earlyStartCount(): number {
    return this.queue.filter((item) => item.status !== "queued").length;
  }

  /**
   * Discard all pending work (on abort or error).
   */
  discard(): void {
    this.queue = [];
    this.events = [];
  }

  // ─── Private ────────────────────────────────────────────────────

  private startExecution(queued: QueuedTool): void {
    queued.status = "executing";
    const { toolCall } = queued;

    this.events.push({
      type: "tool_executing",
      name: toolCall.name,
      toolUseId: toolCall.id,
      input: toolCall.input as Record<string, unknown>,
    });

    queued.promise = this.executeTool(toolCall).then((result) => {
      queued.status = "done";
      queued.result = result;

      this.events.push({
        type: "tool_result",
        name: toolCall.name,
        toolUseId: toolCall.id,
        result: result.result,
        isError: result.isError,
        durationMs: result.durationMs,
      });

      return result;
    });
  }

  private async executeTool(toolCall: ToolUseBlock): Promise<ToolExecResult> {
    const start = Date.now();
    try {
      // ToolRegistry.execute handles the tool lookup + handler invocation;
      // it returns a ToolResult (content + is_error). Older code here
      // incorrectly called `this.cfg.tools.get(name)` which doesn't exist
      // on ToolRegistry, crashing the executor for local models.
      const result = await this.cfg.tools.execute(
        toolCall.name,
        (toolCall.input as Record<string, unknown>) ?? {},
      );
      const resultStr =
        typeof result === "string" ? result : (result.content ?? JSON.stringify(result));
      const isError =
        typeof result === "string" ? false : (result.is_error ?? false);

      log.info("tool", `[streaming] ${toolCall.name} completed in ${Date.now() - start}ms`);

      return {
        toolUseId: toolCall.id,
        name: toolCall.name,
        result: resultStr,
        isError,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        toolUseId: toolCall.id,
        name: toolCall.name,
        result: err instanceof Error ? err.message : String(err),
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  }
}
