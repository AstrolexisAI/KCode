// KCode - Remote Trigger Executor
// Executes triggers locally by spawning KCode in print mode.

import type { RemoteTrigger, TriggerRunResult } from "./types";

export interface TriggerExecutorConfig {
  /** Path to the KCode entry point. Defaults to "src/index.ts". */
  entryPoint?: string;
  /** Timeout in milliseconds for each trigger run. Defaults to 300000 (5 min). */
  timeoutMs?: number;
  /** Custom spawn function for testing. */
  spawnFn?: (args: string[], options: SpawnOptions) => Promise<SpawnResult>;
}

export interface SpawnOptions {
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_ENTRY_POINT = "src/index.ts";
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Default spawn function using Bun.spawn.
 */
async function defaultSpawn(args: string[], options: SpawnOptions): Promise<SpawnResult> {
  const proc = Bun.spawn(["bun", "run", ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (options.timeout) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, options.timeout);
  }

  const exitCode = await proc.exited;

  if (timer) {
    clearTimeout(timer);
  }

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (timedOut) {
    return {
      exitCode: 124, // conventional timeout exit code
      stdout,
      stderr: `Trigger timed out after ${options.timeout}ms`,
    };
  }

  return { exitCode, stdout, stderr };
}

/**
 * Executes remote triggers locally by spawning KCode subprocess.
 */
export class TriggerExecutor {
  private entryPoint: string;
  private timeoutMs: number;
  private spawnFn: (args: string[], options: SpawnOptions) => Promise<SpawnResult>;

  constructor(config?: TriggerExecutorConfig) {
    this.entryPoint = config?.entryPoint ?? DEFAULT_ENTRY_POINT;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawnFn = config?.spawnFn ?? defaultSpawn;
  }

  /**
   * Execute a single trigger's prompt as a KCode agent in print mode.
   */
  async execute(trigger: RemoteTrigger, cwd: string): Promise<TriggerRunResult> {
    const startTime = Date.now();

    const args: string[] = [this.entryPoint, "--print"];

    if (trigger.maxTurns) {
      args.push("--max-turns", String(trigger.maxTurns));
    }

    if (trigger.model) {
      args.push("--model", trigger.model);
    }

    args.push(trigger.prompt);

    const spawnOptions: SpawnOptions = {
      cwd: trigger.workingDirectory ?? cwd,
      env: trigger.env,
      timeout: this.timeoutMs,
    };

    let result: SpawnResult;
    try {
      result = await this.spawnFn(args, spawnOptions);
    } catch (err) {
      const durationMs = Date.now() - startTime;
      return {
        triggerId: trigger.id,
        status: "error",
        summary: `Execution failed: ${err instanceof Error ? err.message : String(err)}`,
        messagesCount: 0,
        tokensUsed: 0,
        costUsd: 0,
        durationMs,
      };
    }

    const durationMs = Date.now() - startTime;

    if (result.exitCode === 124) {
      return {
        triggerId: trigger.id,
        status: "error",
        summary: `Trigger timed out after ${this.timeoutMs}ms`,
        messagesCount: 0,
        tokensUsed: 0,
        costUsd: 0,
        durationMs,
      };
    }

    const isSuccess = result.exitCode === 0;
    const output = result.stdout.trim();
    const summary = isSuccess
      ? output.slice(0, 500) || "Completed successfully"
      : `Exit code ${result.exitCode}: ${(result.stderr || output).slice(0, 500)}`;

    return {
      triggerId: trigger.id,
      status: isSuccess ? "success" : "error",
      summary,
      messagesCount: 0, // not available in print mode
      tokensUsed: 0,
      costUsd: 0,
      durationMs,
    };
  }

  /**
   * Execute multiple triggers sequentially.
   */
  async executeAll(triggers: RemoteTrigger[], cwd: string): Promise<TriggerRunResult[]> {
    const results: TriggerRunResult[] = [];

    for (const trigger of triggers) {
      const result = await this.execute(trigger, cwd);
      results.push(result);
    }

    return results;
  }

  /**
   * Format a trigger run result as human-readable text.
   */
  formatResult(result: TriggerRunResult): string {
    const statusLabel = result.status === "success" ? "OK" : "ERROR";
    const duration = (result.durationMs / 1000).toFixed(1);

    const lines: string[] = [
      `Trigger: ${result.triggerId}`,
      `Status:  ${statusLabel}`,
      `Duration: ${duration}s`,
      `Summary: ${result.summary}`,
    ];

    if (result.tokensUsed > 0) {
      lines.push(`Tokens:  ${result.tokensUsed}`);
    }

    if (result.costUsd > 0) {
      lines.push(`Cost:    $${result.costUsd.toFixed(4)}`);
    }

    if (result.artifacts && result.artifacts.length > 0) {
      lines.push("Artifacts:");
      for (const artifact of result.artifacts) {
        lines.push(`  ${artifact.action}: ${artifact.path}`);
      }
    }

    return lines.join("\n");
  }
}
