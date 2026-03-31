// KCode - Coordinator Worker Logic
// Tool restrictions and worker spawning for coordinator mode

import type { WorkerConfig, WorkerMode, WorkerHandle, WorkerSpawnConfig } from "./types";
import { log } from "../logger";

// ─── Tool Restriction Tables ───────────────────────────────────

/** Tools permitted per worker mode */
export const WORKER_TOOLS: Record<WorkerMode, string[]> = {
  simple: [
    "Bash",
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
  ],
  complex: [
    "Bash",
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    "GrepReplace",
    "Rename",
    "WebFetch",
    "WebSearch",
    "GitStatus",
    "GitCommit",
    "GitLog",
    "TestRunner",
    "DiffViewer",
  ],
};

/** Tools NEVER allowed for workers (reserved for coordinator) */
export const COORDINATOR_ONLY_TOOLS: string[] = [
  "Agent",
  "SendMessage",
  "Skill",
  "Plan",
];

/**
 * Compute the effective tool list for a worker based on mode, extras, and blocks.
 *
 * @param config - Worker configuration
 * @param mcpTools - Available MCP tool names (only included for complex mode)
 * @returns Deduplicated list of allowed tool names
 */
export function getWorkerTools(config: WorkerConfig, mcpTools: string[] = []): string[] {
  let tools = [...WORKER_TOOLS[config.mode]];

  // Add extra tools (excluding coordinator-only)
  if (config.extraTools) {
    const allowed = config.extraTools.filter(t => !COORDINATOR_ONLY_TOOLS.includes(t));
    tools.push(...allowed);
  }

  // In complex mode, add MCP tools (also excluding coordinator-only)
  if (config.mode === "complex") {
    const safeMcp = mcpTools.filter(t => !COORDINATOR_ONLY_TOOLS.includes(t));
    tools.push(...safeMcp);
  }

  // Remove blocked tools
  if (config.blockedTools) {
    const blocked = new Set(config.blockedTools);
    tools = tools.filter(t => !blocked.has(t));
  }

  // Deduplicate
  return [...new Set(tools)];
}

/**
 * Build the worker prompt including scratchpad instructions.
 */
export function buildWorkerPrompt(config: WorkerSpawnConfig): string {
  const parts: string[] = [
    config.task,
    "",
    "## Scratchpad",
    `You have access to a shared workspace at: ${config.scratchpadDir}`,
    "- Read plan.md for the overall plan",
    `- Write your output to worker-${config.id}.md`,
    "- You can read files from other workers for context",
    "",
    "## Restrictions",
    `- You may only use these tools: ${config.allowedTools.join(", ")}`,
    "- Do not attempt to use unlisted tools",
    "- When finished, write your result to the scratchpad and stop",
  ];

  if (config.files && config.files.length > 0) {
    parts.push("");
    parts.push("## Focus Files");
    for (const f of config.files) {
      parts.push(`- ${f}`);
    }
  }

  return parts.join("\n");
}

/**
 * Build CLI arguments for spawning a worker subprocess.
 */
export function buildWorkerArgs(config: WorkerSpawnConfig): string[] {
  const args: string[] = [
    "run",
    "src/index.ts",
    "--print",
    "--permission", "deny",
    "--allowed-tools", config.allowedTools.join(","),
  ];

  if (config.model) {
    args.push("-m", config.model);
  }

  return args;
}

/**
 * Build environment variables for a worker subprocess.
 */
export function buildWorkerEnv(config: WorkerSpawnConfig): Record<string, string | undefined> {
  return {
    ...process.env,
    KCODE_WORKER_ID: config.id,
    KCODE_COORDINATOR_MODE: "worker",
    KCODE_SCRATCHPAD_DIR: config.scratchpadDir,
    KCODE_MESSAGE_BUS_DIR: config.messageBusDir,
  };
}

/**
 * Create a WorkerHandle from a spawn config and optional process.
 */
export function createWorkerHandle(
  config: WorkerSpawnConfig,
  proc: import("node:child_process").ChildProcess | null = null,
): WorkerHandle {
  return {
    id: config.id,
    process: proc,
    status: "running",
    startedAt: Date.now(),
  };
}
