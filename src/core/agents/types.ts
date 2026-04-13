// KCode — Agent Factory: core types
//
// These types describe the parallel-agent system. KCode can spawn up
// to 10 named agents concurrently, organize them into groups, and
// report their status in natural language. The pool manages
// lifecycles, the factory generates specs from user intent, and the
// TUI panel renders live status.

/**
 * Lifecycle states an agent can be in.
 *
 *   spawning  — constructed but not yet executing
 *   running   — actively working on its task
 *   waiting   — blocked (e.g., waiting for another agent's result,
 *               waiting for user approval on a tool call)
 *   done      — finished successfully
 *   error     — failed with an error message
 *   cancelled — killed by the user or the pool
 */
export type AgentStatus =
  | "spawning"
  | "running"
  | "waiting"
  | "done"
  | "error"
  | "cancelled";

/**
 * Semantic role of an agent. The factory picks a role based on task
 * keywords and project stack; the role determines system prompt,
 * allowed tools, and an emoji icon for the TUI.
 */
export type AgentRole =
  | "auditor"
  | "fixer"
  | "tester"
  | "linter"
  | "reviewer"
  | "architect"
  | "security"
  | "optimizer"
  | "docs"
  | "migration"
  | "explorer"
  | "scribe"
  | "worker";

/** A request to spawn an agent. Created by the factory or by the model directly. */
export interface AgentSpec {
  /** What role this agent plays — drives the system prompt + tool allowlist. */
  role: AgentRole;
  /** Human-readable description of the task — shown in the TUI. */
  task: string;
  /** File or directory the agent is responsible for, if scoped. */
  targetPath?: string;
  /** Optional model override — defaults to the session's active model. */
  model?: string;
  /** Optional tools override — defaults to the role's allowlist. */
  tools?: string[];
  /** Group this agent should join, if any. Groups form work teams. */
  groupName?: string;
  /** Queue priority — high runs first when the pool is saturated. */
  priority?: "high" | "normal" | "low";
}

/**
 * A live or completed agent instance. Pools keep these in a Map
 * indexed by id, and the TUI panel reads them by iterating the Map.
 * Names are human-friendly codenames (Atlas, Orion, Vega, …).
 */
export interface Agent {
  /** Stable unique id (uuid). */
  id: string;
  /** Codename assigned by the name generator (Atlas, Orion, …). */
  name: string;
  /** Role driving the system prompt. */
  role: AgentRole;
  /** Lifecycle state — drives TUI color and the "waiting/done" narrative. */
  status: AgentStatus;
  /** Task description (immutable after spawn). */
  task: string;
  /** Scoped path, if any. */
  targetPath?: string;
  /** Group name, if the agent is part of a group. */
  group?: string;
  /** Tool currently executing (e.g., "Read", "Bash"). Updated by the executor. */
  currentTool?: string;
  /** Epoch ms when the agent started executing. */
  startedAt: number;
  /** Epoch ms when the agent transitioned to done/error/cancelled. */
  finishedAt?: number;
  /** Model used for this agent. */
  model: string;
  /** Running token usage (updated after each LLM turn). */
  tokenUsage: { input: number; output: number };
  /** Running USD cost based on the model's pricing. */
  costUsd: number;
  /** Final output text if the agent finished successfully. */
  result?: string;
  /** Error message if status === "error". */
  error?: string;
}

/**
 * A group of agents working together on a shared mission. Groups are
 * named ("Alfa", "Security Team") and have a human-readable mission
 * statement. The model can say things like "Group Alfa is auditing
 * the backend" and the pool knows which agents that refers to.
 */
export interface AgentGroup {
  /** Human-friendly name. */
  name: string;
  /** What this group is collectively trying to do. */
  mission: string;
  /** IDs of member agents. */
  agentIds: string[];
  /** Epoch ms of creation. */
  createdAt: number;
  /** Derived from member statuses — active if any agent is running. */
  status: "active" | "waiting" | "complete" | "cancelled";
}

/** Snapshot of the entire pool for TUI rendering and persistence. */
export interface PoolStatus {
  /** Agents currently spawning or running. */
  active: Agent[];
  /** Specs in the queue (pool is at max capacity). */
  queued: AgentSpec[];
  /** Finished agents (done, error, cancelled). Kept for history. */
  done: Agent[];
  /** All groups ever created in this session. */
  groups: AgentGroup[];
  /** Configured pool size limit. */
  maxConcurrent: number;
  /** Total spawned since pool start. */
  totalSpawned: number;
  /** Sum of input+output tokens across all agents. */
  totalTokens: number;
  /** Sum of USD cost across all agents. */
  totalCostUsd: number;
}

/**
 * Events emitted by the pool. The TUI panel subscribes to these and
 * re-renders whenever one fires. Also written to the session
 * narrative so the model can mention them in conversation.
 */
export type PoolEvent =
  | { type: "spawn"; agent: Agent }
  | { type: "tool_start"; agentId: string; tool: string }
  | { type: "tool_end"; agentId: string; tool: string }
  | { type: "progress"; agentId: string; message: string }
  | { type: "done"; agent: Agent }
  | { type: "error"; agent: Agent; error: string }
  | { type: "cancelled"; agentId: string }
  | { type: "group_created"; group: AgentGroup }
  | { type: "group_complete"; group: AgentGroup };

/**
 * An executor function that runs the agent's task. Returns the
 * agent's final result string on success. Takes an emit function
 * so the executor can report progress (tool starts/ends, status
 * messages) back to the pool without importing the pool directly.
 */
export type AgentExecutor = (
  agent: Agent,
  emit: (event: Extract<PoolEvent, { agentId: string }>) => void,
) => Promise<string>;
