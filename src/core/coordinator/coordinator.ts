// KCode - Coordinator Mode
// Orchestrates multiple workers with restricted tools, shared scratchpad, and message bus

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger";
import { MessageBus } from "./message-bus";
import { Scratchpad } from "./scratchpad";
import type {
  CoordinatorConfig,
  CoordinatorMessage,
  WorkerConfig,
  WorkerHandle,
  WorkerResult,
  WorkerSpawnConfig,
} from "./types";
import { DEFAULT_COORDINATOR_CONFIG } from "./types";
import {
  buildWorkerArgs,
  buildWorkerEnv,
  buildWorkerPrompt,
  createWorkerHandle,
  getWorkerTools,
} from "./worker";

export class Coordinator {
  private scratchpad: Scratchpad;
  private messageBus: MessageBus;
  private workers: Map<string, WorkerHandle> = new Map();
  private config: CoordinatorConfig;
  private sessionId: string;
  private started: boolean = false;

  constructor(sessionId: string, config?: Partial<CoordinatorConfig>) {
    this.sessionId = sessionId;
    this.config = { ...DEFAULT_COORDINATOR_CONFIG, ...config };
    this.scratchpad = new Scratchpad(sessionId);
    this.messageBus = new MessageBus(this.scratchpad.getPath());
  }

  /** Start coordinator mode */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Initialize scratchpad with default files
    if (this.config.scratchpadEnabled) {
      this.scratchpad.write("plan.md", "# Plan\n\n(Pending definition)", "coordinator");
      this.scratchpad.write("progress.md", "# Progress\n\n- Coordinator started", "coordinator");
    }

    // Start message bus polling
    this.messageBus.startPolling("coordinator", this.handleWorkerMessages.bind(this));

    log.info("coordinator", `Coordinator started for session ${this.sessionId}`);
  }

  /** Assign a task to a worker */
  async assignTask(workerConfig: WorkerConfig): Promise<string> {
    if (this.workers.size >= this.config.maxWorkers) {
      throw new Error(`Max workers (${this.config.maxWorkers}) reached`);
    }

    // Validate worker ID is unique
    if (this.workers.has(workerConfig.id)) {
      throw new Error(`Worker "${workerConfig.id}" already exists`);
    }

    // Compute allowed tools for this worker
    const tools = getWorkerTools(workerConfig, this.getMcpTools());

    // Build full spawn config
    const spawnConfig: WorkerSpawnConfig = {
      ...workerConfig,
      allowedTools: tools,
      scratchpadDir: this.scratchpad.getPath(),
      messageBusDir: join(this.scratchpad.getPath(), ".messages"),
      coordinatorId: "coordinator",
    };

    // Create worker handle (actual process spawn is done externally or via spawnWorkerProcess)
    const handle = createWorkerHandle(spawnConfig);
    this.workers.set(workerConfig.id, handle);

    // Update progress
    this.updateProgress(`Worker ${workerConfig.id} assigned: ${workerConfig.task.slice(0, 100)}`);

    // Send task via message bus
    this.messageBus.send({
      type: "task",
      from: "coordinator",
      to: workerConfig.id,
      payload: { task: workerConfig.task, files: workerConfig.files ?? [] },
      timestamp: Date.now(),
    });

    return workerConfig.id;
  }

  /** Spawn and assign a task, creating the actual subprocess */
  async spawnAndAssign(workerConfig: WorkerConfig, cwd: string = process.cwd()): Promise<string> {
    const id = await this.assignTask(workerConfig);
    const handle = this.workers.get(id)!;

    const tools = getWorkerTools(workerConfig, this.getMcpTools());
    const spawnConfig: WorkerSpawnConfig = {
      ...workerConfig,
      allowedTools: tools,
      scratchpadDir: this.scratchpad.getPath(),
      messageBusDir: join(this.scratchpad.getPath(), ".messages"),
      coordinatorId: "coordinator",
    };

    const { cmd, args } = buildWorkerArgs(spawnConfig);
    const env = buildWorkerEnv(spawnConfig);
    const prompt = buildWorkerPrompt(spawnConfig);

    try {
      const proc = spawn(cmd, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });

      handle.process = proc;

      // Send task via stdin
      proc.stdin!.write(prompt + "\n");
      proc.stdin!.end();

      // Set up timeout
      const timeoutId = setTimeout(() => {
        if (handle.status === "running") {
          handle.status = "timeout";
          handle.durationMs = Date.now() - handle.startedAt;
          handle.error = `Worker timed out after ${this.config.workerTimeoutMs}ms`;
          try {
            proc.kill();
          } catch {
            /* best effort */
          }
          this.updateProgress(`Worker ${id} timed out`);
        }
      }, this.config.workerTimeoutMs);

      // Collect output
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      proc.stdout!.on("data", (data: Buffer) => chunks.push(data));
      proc.stderr!.on("data", (data: Buffer) => errChunks.push(data));

      proc.on("close", (code) => {
        clearTimeout(timeoutId);
        if (handle.status === "timeout") return; // Already handled

        const stdout = Buffer.concat(chunks).toString("utf-8");
        const stderr = Buffer.concat(errChunks).toString("utf-8");

        handle.status = code === 0 ? "completed" : "failed";
        handle.output = stdout || stderr || `(exit code ${code})`;
        handle.durationMs = Date.now() - handle.startedAt;

        if (handle.status === "failed") {
          handle.error = stderr || `Exit code ${code}`;
        }

        this.updateProgress(`Worker ${id} ${handle.status} (${handle.durationMs}ms)`);
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutId);
        handle.status = "failed";
        handle.error = err.message;
        handle.durationMs = Date.now() - handle.startedAt;
        this.updateProgress(`Worker ${id} error: ${err.message}`);
      });
    } catch (err) {
      handle.status = "failed";
      handle.error = err instanceof Error ? err.message : String(err);
      handle.durationMs = Date.now() - handle.startedAt;
    }

    return id;
  }

  /** Collect results from completed/failed workers */
  collectResults(): WorkerResult[] {
    const results: WorkerResult[] = [];

    for (const [id, handle] of this.workers) {
      if (
        handle.status === "completed" ||
        handle.status === "failed" ||
        handle.status === "timeout"
      ) {
        const scratchpadOutput = this.scratchpad.read(`worker-${id}.md`);
        results.push({
          id,
          status: handle.status,
          output: scratchpadOutput || handle.output || "",
          filesModified: handle.filesModified || [],
          durationMs: handle.durationMs || 0,
          tokensUsed: handle.tokensUsed || { input: 0, output: 0 },
          error: handle.error,
        });
      }
    }

    return results;
  }

  /** Get current worker statuses */
  getWorkerStatuses(): Array<{ id: string; status: string; durationMs?: number }> {
    return Array.from(this.workers.entries()).map(([id, handle]) => ({
      id,
      status: handle.status,
      durationMs: handle.status === "running" ? Date.now() - handle.startedAt : handle.durationMs,
    }));
  }

  /** Get number of running workers */
  getRunningCount(): number {
    let count = 0;
    for (const h of this.workers.values()) {
      if (h.status === "running") count++;
    }
    return count;
  }

  /** Get total worker count */
  getWorkerCount(): number {
    return this.workers.size;
  }

  /** Cancel a specific worker */
  async cancelWorker(id: string): Promise<boolean> {
    const handle = this.workers.get(id);
    if (!handle || handle.status !== "running") return false;

    // Send cancel message
    this.messageBus.send({
      type: "cancel",
      from: "coordinator",
      to: id,
      payload: {},
      timestamp: Date.now(),
    });

    // Kill process
    if (handle.process && !handle.process.killed) {
      try {
        handle.process.kill();
      } catch {
        /* best effort */
      }
    }

    handle.status = "failed";
    handle.error = "Cancelled by coordinator";
    handle.durationMs = Date.now() - handle.startedAt;
    this.updateProgress(`Worker ${id} cancelled`);

    return true;
  }

  /** Cancel all running workers */
  async cancelAll(): Promise<void> {
    for (const [id, handle] of this.workers) {
      if (handle.status === "running") {
        await this.cancelWorker(id);
      }
    }
  }

  /** Clean up coordinator resources */
  async cleanup(): Promise<void> {
    this.messageBus.stopPolling();
    await this.cancelAll();

    if (!this.config.preserveScratchpadOnExit) {
      this.scratchpad.cleanup();
    }

    this.started = false;
    log.info("coordinator", `Coordinator cleaned up for session ${this.sessionId}`);
  }

  /** Get the scratchpad instance */
  getScratchpad(): Scratchpad {
    return this.scratchpad;
  }

  /** Get the message bus instance */
  getMessageBus(): MessageBus {
    return this.messageBus;
  }

  /** Get the session ID */
  getSessionId(): string {
    return this.sessionId;
  }

  /** Check if coordinator is started */
  isStarted(): boolean {
    return this.started;
  }

  /** Get coordinator config */
  getConfig(): CoordinatorConfig {
    return { ...this.config };
  }

  // ─── Private Helpers ─────────────────────────────────────────

  /** Update progress in scratchpad */
  private updateProgress(entry: string): void {
    if (!this.config.scratchpadEnabled) return;
    const current = this.scratchpad.read("progress.md") || "# Progress\n";
    const timestamp = new Date().toISOString().slice(11, 19);
    this.scratchpad.write("progress.md", `${current}\n- [${timestamp}] ${entry}`, "coordinator");
  }

  /** Handle incoming messages from workers */
  private handleWorkerMessages(messages: CoordinatorMessage[]): void {
    for (const msg of messages) {
      switch (msg.type) {
        case "progress":
          this.updateProgress(`[${msg.from}] ${msg.payload.message ?? ""}`);
          break;
        case "result": {
          const handle = this.workers.get(msg.from);
          if (handle) {
            handle.status = "completed";
            handle.output = (msg.payload.output as string) ?? "";
            handle.filesModified = (msg.payload.filesModified as string[]) ?? [];
            handle.durationMs = Date.now() - handle.startedAt;
          }
          break;
        }
        case "query":
          // Worker asks coordinator something — logged for now
          this.updateProgress(`[${msg.from}] query: ${msg.payload.question ?? ""}`);
          break;
      }
    }
  }

  /** Get available MCP tools (placeholder — actual integration via mcp.ts) */
  private getMcpTools(): string[] {
    // In a real integration, this would query getMcpManager().getToolNames()
    // For now return empty; MCP tools are dynamically merged at runtime
    return [];
  }
}

// ─── Session Resume Helpers ────────────────────────────────────

/**
 * Detect if a previous session was in coordinator mode
 * by checking for a scratchpad directory.
 */
export function detectCoordinatorSession(sessionId: string): boolean {
  const scratchpadDir = join(homedir(), ".kcode", "scratchpad", sessionId);
  return existsSync(scratchpadDir);
}

/**
 * Load progress from a previous coordinator session's scratchpad.
 */
export function loadCoordinatorProgress(sessionId: string): string | null {
  const progressPath = join(homedir(), ".kcode", "scratchpad", sessionId, "progress.md");
  if (!existsSync(progressPath)) return null;
  try {
    return readFileSync(progressPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Parse coordinator config from settings.
 */
export function parseCoordinatorConfig(raw: unknown): Partial<CoordinatorConfig> {
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  const config: Partial<CoordinatorConfig> = {};

  if (typeof obj.enabled === "boolean") config.enabled = obj.enabled;
  if (typeof obj.maxWorkers === "number" && obj.maxWorkers > 0) config.maxWorkers = obj.maxWorkers;
  if (obj.defaultWorkerMode === "simple" || obj.defaultWorkerMode === "complex") {
    config.defaultWorkerMode = obj.defaultWorkerMode;
  }
  if (typeof obj.workerTimeoutMs === "number" && obj.workerTimeoutMs > 0) {
    config.workerTimeoutMs = obj.workerTimeoutMs;
  }
  if (typeof obj.scratchpadEnabled === "boolean") config.scratchpadEnabled = obj.scratchpadEnabled;
  if (typeof obj.preserveScratchpadOnExit === "boolean") {
    config.preserveScratchpadOnExit = obj.preserveScratchpadOnExit;
  }

  return config;
}
