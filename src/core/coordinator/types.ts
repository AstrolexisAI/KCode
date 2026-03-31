// KCode - Coordinator Mode Types
// Interfaces for coordinator orchestration with restricted workers and shared scratchpad

import type { ChildProcess } from "node:child_process";

// ─── Coordinator Config ────────────────────────────────────────

export interface CoordinatorConfig {
  /** Activate coordinator mode */
  enabled: boolean;
  /** Max simultaneous workers */
  maxWorkers: number;
  /** Default worker mode */
  defaultWorkerMode: WorkerMode;
  /** Per-worker timeout in ms */
  workerTimeoutMs: number;
  /** Enable scratchpad */
  scratchpadEnabled: boolean;
  /** Preserve scratchpad on exit (for session resume) */
  preserveScratchpadOnExit: boolean;
}

export const DEFAULT_COORDINATOR_CONFIG: CoordinatorConfig = {
  enabled: false,
  maxWorkers: 4,
  defaultWorkerMode: "simple",
  workerTimeoutMs: 120_000,
  scratchpadEnabled: true,
  preserveScratchpadOnExit: true,
};

// ─── Worker Types ──────────────────────────────────────────────

export type WorkerMode = "simple" | "complex";

export interface WorkerConfig {
  /** Unique worker ID */
  id: string;
  /** Mode: determines available tools */
  mode: WorkerMode;
  /** Assigned task prompt */
  task: string;
  /** Relevant files (optional) */
  files?: string[];
  /** Additional tools allowed (beyond mode defaults) */
  extraTools?: string[];
  /** Explicitly blocked tools */
  blockedTools?: string[];
  /** Model override (inherits from coordinator by default) */
  model?: string;
}

export interface WorkerSpawnConfig extends WorkerConfig {
  allowedTools: string[];
  scratchpadDir: string;
  messageBusDir: string;
  coordinatorId: string;
}

export interface WorkerHandle {
  id: string;
  process: ChildProcess | null;
  status: "running" | "completed" | "failed" | "timeout";
  startedAt: number;
  output?: string;
  filesModified?: string[];
  durationMs?: number;
  tokensUsed?: { input: number; output: number };
  error?: string;
}

export interface WorkerResult {
  id: string;
  status: "completed" | "failed" | "timeout";
  output: string;
  filesModified: string[];
  durationMs: number;
  tokensUsed: { input: number; output: number };
  error?: string;
}

// ─── Scratchpad Types ──────────────────────────────────────────

export interface ScratchpadEntry {
  /** File name in scratchpad */
  file: string;
  /** File content */
  content: string;
  /** Author: 'coordinator' | 'worker-{id}' */
  author: string;
  /** Unix timestamp (ms) */
  timestamp: number;
}

export interface ScratchpadLogEntry {
  file: string;
  author: string;
  action: "write" | "read" | "delete";
  timestamp: number;
}

// ─── Message Bus Types ─────────────────────────────────────────

export type CoordinatorMessageType = "task" | "progress" | "result" | "cancel" | "query";

export interface CoordinatorMessage {
  type: CoordinatorMessageType;
  from: string;
  to: string;
  payload: Record<string, unknown>;
  timestamp: number;
}
