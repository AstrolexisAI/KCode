// KCode — Agent pool
//
// Manages up to N concurrent agents, each with a unique codename and
// a task. Spawns specs via an executor callback, tracks lifecycle
// events, persists a snapshot to ~/.kcode/agents/active.json, and
// exposes a PoolStatus for the TUI to render.
//
// The pool is event-driven: consumers subscribe via onEvent(cb) and
// receive PoolEvent objects as agents spawn, run tools, and finish.
// The TUI panel uses this to live-update.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { NameGenerator } from "./names";
import { ROLES } from "./roles";
import type {
  Agent,
  AgentExecutor,
  AgentGroup,
  AgentSpec,
  AgentStatus,
  PoolEvent,
  PoolStatus,
} from "./types";

/** Default max concurrent agents. User-configurable via settings. */
const DEFAULT_MAX_CONCURRENT = 10;

/** Where we snapshot pool state to disk for crash recovery. */
const SNAPSHOT_PATH = join(
  process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
  ".kcode",
  "agents",
  "active.json",
);

export class AgentPool {
  /** Map of id → live agent (spawning/running/waiting). */
  private active: Map<string, Agent> = new Map();
  /** Queue of specs waiting for a free slot. */
  private queue: AgentSpec[] = [];
  /** Completed agents retained for history and the "done" TUI section. */
  private history: Agent[] = [];
  /** Map of name → group (stable across agent churn). */
  private groups: Map<string, AgentGroup> = new Map();
  /** Name generator — issues and releases codenames. */
  private names = new NameGenerator();
  /** Concurrency limit. */
  readonly maxConcurrent: number;
  /** EventEmitter for TUI subscribers. */
  private emitter = new EventEmitter();
  /** Set of resolvers waiting on waitFor(id/name). */
  private waiters: Map<string, Array<(agent: Agent) => void>> = new Map();
  /** Running counters for the PoolStatus summary. */
  private totalSpawned = 0;
  /** Default executor used when spawn() is called without one. */
  private defaultExecutor?: AgentExecutor;

  constructor(opts: { maxConcurrent?: number; defaultExecutor?: AgentExecutor } = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.defaultExecutor = opts.defaultExecutor;
    // Allow many subscribers (TUI, narrative, logger, …)
    this.emitter.setMaxListeners(50);
  }

  /**
   * Subscribe to pool events. Returns an unsubscribe function.
   * The TUI panel calls this and re-renders on every event.
   */
  onEvent(cb: (event: PoolEvent) => void): () => void {
    this.emitter.on("event", cb);
    return () => this.emitter.off("event", cb);
  }

  /** Emit a typed pool event to all subscribers. */
  private emit(event: PoolEvent): void {
    this.emitter.emit("event", event);
  }

  /**
   * Spawn a new agent from a spec. If the pool is at capacity, the
   * spec is queued and the returned agent is in "spawning" state —
   * it will transition to "running" when a slot frees up. If an
   * executor is supplied (or a default was set on construction),
   * the agent's task is executed asynchronously via that executor.
   *
   * Callers don't need to await the executor — it runs in the
   * background. Use `waitFor(id|name)` or `onEvent("done")` to
   * observe completion.
   */
  spawn(spec: AgentSpec, executor?: AgentExecutor): Agent {
    const role = ROLES[spec.role];
    const id = randomUUID();
    const name = this.names.reserve();
    const agent: Agent = {
      id,
      name,
      role: spec.role,
      status: "spawning",
      task: spec.task,
      targetPath: spec.targetPath,
      group: spec.groupName,
      startedAt: Date.now(),
      model: spec.model ?? "inherited",
      tokenUsage: { input: 0, output: 0 },
      costUsd: 0,
    };
    this.totalSpawned++;

    // If the spec names a group we don't know about yet, create it
    // on-demand with an empty mission (can be updated later).
    if (spec.groupName && !this.groups.has(spec.groupName)) {
      this.createGroup(spec.groupName, "", []);
    }
    if (spec.groupName) {
      const group = this.groups.get(spec.groupName)!;
      group.agentIds.push(id);
    }

    if (this.active.size >= this.maxConcurrent) {
      // Pool is saturated — queue the spec and keep the agent in
      // "spawning" state until drainQueue picks it up.
      this.queue.push(spec);
      this.emit({ type: "spawn", agent });
      return agent;
    }

    this.active.set(id, agent);
    this.emit({ type: "spawn", agent });

    // Run the executor asynchronously. We don't await — the caller
    // observes completion via events.
    const exec = executor ?? this.defaultExecutor;
    if (exec) {
      void this.runAgent(agent, exec, role.defaultMaxTurns);
    } else {
      // No executor provided — the agent is "alive" in the pool but
      // won't actually execute. Useful for tests and dry-runs.
      agent.status = "running";
    }

    return agent;
  }

  /**
   * Inner runner that invokes the executor and manages lifecycle
   * transitions. Any thrown error becomes an "error" event.
   */
  private async runAgent(
    agent: Agent,
    executor: AgentExecutor,
    _maxTurns: number,
  ): Promise<void> {
    agent.status = "running";
    try {
      const result = await executor(agent, (event) => {
        // Forward tool-start/tool-end/progress events from the executor.
        this.emit(event);
        if (event.type === "tool_start") {
          agent.currentTool = event.tool;
        } else if (event.type === "tool_end") {
          agent.currentTool = undefined;
        }
      });
      agent.status = "done";
      agent.result = result;
      agent.finishedAt = Date.now();
      this.emit({ type: "done", agent });
    } catch (err) {
      agent.status = "error";
      agent.error = err instanceof Error ? err.message : String(err);
      agent.finishedAt = Date.now();
      this.emit({ type: "error", agent, error: agent.error });
    } finally {
      this.retire(agent);
    }
  }

  /**
   * Move a finished agent from active → history, release its name,
   * and pull a new spec from the queue if any are waiting.
   */
  private retire(agent: Agent): void {
    this.active.delete(agent.id);
    this.history.push(agent);
    this.names.release(agent.name);
    // Resolve any waiters blocked on this agent.
    const byId = this.waiters.get(agent.id);
    if (byId) {
      for (const r of byId) r(agent);
      this.waiters.delete(agent.id);
    }
    const byName = this.waiters.get(agent.name);
    if (byName) {
      for (const r of byName) r(agent);
      this.waiters.delete(agent.name);
    }
    // Update any groups the agent belonged to.
    if (agent.group && this.groups.has(agent.group)) {
      const group = this.groups.get(agent.group)!;
      const allDone = group.agentIds.every((id) => {
        const a = this.active.get(id) ?? this.history.find((h) => h.id === id);
        return a && (a.status === "done" || a.status === "error" || a.status === "cancelled");
      });
      if (allDone) {
        group.status = "complete";
        this.emit({ type: "group_complete", group });
      }
    }
    this.drainQueue();
    this.snapshot();
  }

  /** Pull queued specs into the active pool until capacity is reached. */
  private drainQueue(): void {
    while (this.queue.length > 0 && this.active.size < this.maxConcurrent) {
      const next = this.queue.shift()!;
      this.spawn(next);
    }
  }

  /**
   * Wait for an agent by id or codename. Resolves when the agent
   * transitions to done/error/cancelled. Returns immediately if the
   * agent is already finished.
   *
   * Throws if no agent with that id/name exists anywhere.
   */
  async waitFor(idOrName: string, timeoutMs = 300_000): Promise<Agent> {
    // Already finished?
    const finished = this.history.find((a) => a.id === idOrName || a.name === idOrName);
    if (finished) return finished;
    // Live?
    const live = Array.from(this.active.values()).find(
      (a) => a.id === idOrName || a.name === idOrName,
    );
    if (!live) {
      throw new Error(`No agent found with id or name: ${idOrName}`);
    }
    return new Promise<Agent>((resolve, reject) => {
      const key = live.id;
      const arr = this.waiters.get(key) ?? [];
      arr.push(resolve);
      this.waiters.set(key, arr);
      if (timeoutMs > 0) {
        setTimeout(() => {
          reject(new Error(`Timeout waiting for agent ${idOrName}`));
        }, timeoutMs);
      }
    });
  }

  /** Wait for every agent in a group to finish. */
  async waitForGroup(groupName: string): Promise<Agent[]> {
    const group = this.groups.get(groupName);
    if (!group) throw new Error(`No group named: ${groupName}`);
    const results = await Promise.all(group.agentIds.map((id) => this.waitFor(id)));
    return results;
  }

  /**
   * Create a named group with a mission statement. Existing agent
   * ids may be attached; the factory typically uses this to label
   * a set of just-spawned agents.
   */
  createGroup(name: string, mission: string, agentIds: string[]): AgentGroup {
    const existing = this.groups.get(name);
    if (existing) {
      // Merge new ids into the existing group instead of replacing.
      for (const id of agentIds) {
        if (!existing.agentIds.includes(id)) existing.agentIds.push(id);
      }
      if (mission) existing.mission = mission;
      return existing;
    }
    const group: AgentGroup = {
      name,
      mission,
      agentIds: [...agentIds],
      createdAt: Date.now(),
      status: "active",
    };
    this.groups.set(name, group);
    this.emit({ type: "group_created", group });
    return group;
  }

  /**
   * Cancel a single agent by id or codename. Marks it as cancelled,
   * releases the name, and triggers queue drain. Does NOT abort an
   * in-flight executor — real cancellation requires the executor
   * to observe agent.status and bail out.
   */
  cancel(idOrName: string): boolean {
    const agent = Array.from(this.active.values()).find(
      (a) => a.id === idOrName || a.name === idOrName,
    );
    if (!agent) return false;
    agent.status = "cancelled";
    agent.finishedAt = Date.now();
    this.emit({ type: "cancelled", agentId: agent.id });
    this.retire(agent);
    return true;
  }

  /** Cancel every live agent and clear the queue. */
  cancelAll(): void {
    for (const agent of Array.from(this.active.values())) {
      agent.status = "cancelled";
      agent.finishedAt = Date.now();
      this.emit({ type: "cancelled", agentId: agent.id });
      this.retire(agent);
    }
    this.queue = [];
  }

  /** Snapshot the pool state for the TUI and for persistence. */
  getStatus(): PoolStatus {
    const active = Array.from(this.active.values());
    const allAgents = [...active, ...this.history];
    const totalTokens = allAgents.reduce(
      (sum, a) => sum + a.tokenUsage.input + a.tokenUsage.output,
      0,
    );
    const totalCostUsd = allAgents.reduce((sum, a) => sum + a.costUsd, 0);
    return {
      active,
      queued: [...this.queue],
      done: [...this.history],
      groups: Array.from(this.groups.values()),
      maxConcurrent: this.maxConcurrent,
      totalSpawned: this.totalSpawned,
      totalTokens,
      totalCostUsd,
    };
  }

  /**
   * Write the current pool state to ~/.kcode/agents/active.json.
   * Used for crash recovery and the /agents command. Non-fatal on
   * write errors (snapshots are best-effort).
   *
   * WARNING: the snapshot serializes agent.task and agent.result
   * verbatim. If users put secrets (API keys, passwords, tokens)
   * into their agent tasks, those secrets will appear in the
   * snapshot in plaintext. The file is owner-only (chmod 600) but
   * still — don't paste credentials into agent tasks. The snapshot
   * is also readable by anyone with access to the user account.
   *
   * File permissions: we write with 0600 so even other users on a
   * multi-user system can't read the snapshot.
   */
  snapshot(): void {
    try {
      const dir = dirname(SNAPSHOT_PATH);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data = this.getStatus();
      writeFileSync(SNAPSHOT_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch {
      // Best-effort — snapshot failures should never break the pool.
    }
  }

  /**
   * Load a previous snapshot from disk. Returns the raw PoolStatus
   * if the file exists, or null otherwise. The pool does NOT
   * auto-load on startup — callers choose when to resume.
   */
  loadSnapshot(): PoolStatus | null {
    try {
      if (!existsSync(SNAPSHOT_PATH)) return null;
      const raw = readFileSync(SNAPSHOT_PATH, "utf-8");
      return JSON.parse(raw) as PoolStatus;
    } catch {
      return null;
    }
  }

  /**
   * Reset the pool completely — used at session start or manual clear.
   *
   * Note: event subscribers (e.g. the mounted AgentPanel React
   * component) are intentionally NOT cleared. Subscribers are bound
   * to the pool singleton lifetime, and clearing them would orphan
   * the panel until it re-mounts. Tests that need a pool with no
   * history AND no subscribers should call `_resetAgentPoolForTests()`
   * instead — that nulls the singleton entirely, so the next
   * getAgentPool() builds a fresh instance from scratch.
   */
  reset(): void {
    this.cancelAll();
    this.history = [];
    this.groups.clear();
    this.names.reset();
    this.totalSpawned = 0;
  }
}

/** Process-wide singleton so TUI and conversation share one pool. */
let _poolSingleton: AgentPool | null = null;

/**
 * Get or create the process-wide pool singleton. The first call may
 * supply options; subsequent calls ignore them and return the
 * existing instance.
 */
export function getAgentPool(opts?: {
  maxConcurrent?: number;
  defaultExecutor?: AgentExecutor;
}): AgentPool {
  if (!_poolSingleton) {
    _poolSingleton = new AgentPool(opts);
  }
  return _poolSingleton;
}

/** Test helper: reset the singleton. */
export function _resetAgentPoolForTests(): void {
  _poolSingleton = null;
}

// Re-export types from a single place for convenient imports
export type { Agent, AgentSpec, AgentGroup, AgentStatus, PoolEvent, PoolStatus };
