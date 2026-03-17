// KCode - Agent Tool
// Spawns subagent processes for parallel/background task execution

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ToolDefinition, ToolResult } from "../core/types";
import { findCustomAgent, type CustomAgentDef } from "../core/custom-agents";

export interface AgentInput {
  task: string;
  type?: string; // "general" | "explore" | "plan" | custom agent name
  run_in_background?: boolean;
  resume?: string;
  isolation?: "none" | "worktree";
}

interface AgentRecord {
  id: string;
  process: ChildProcess;
  status: "running" | "completed" | "failed";
  content: string;
  startTime: number;
  durationMs?: number;
  totalTokens?: number;
}

const runningAgents = new Map<string, AgentRecord>();

export const agentDefinition: ToolDefinition = {
  name: "Agent",
  description:
    "Spawn a subagent to work on a task. Supports background execution, resuming, and isolation via git worktrees.",
  input_schema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "The task description for the subagent to execute",
      },
      type: {
        type: "string",
        description:
          "Agent type: general (all tools), explore (read-only), plan (read-only + plan output), or a custom agent name from ~/.kcode/agents/. Default: general",
      },
      run_in_background: {
        type: "boolean",
        description: "Run the agent in the background and return immediately with an agentId",
      },
      resume: {
        type: "string",
        description: "Resume a previously started agent by its agentId",
      },
      isolation: {
        type: "string",
        enum: ["none", "worktree"],
        description: "Isolation mode. worktree creates a git worktree for the agent",
      },
    },
    required: ["task"],
  },
};

export async function executeAgent(input: Record<string, unknown>): Promise<ToolResult> {
  const opts = input as AgentInput;

  // Resume an existing agent
  if (opts.resume) {
    const agent = runningAgents.get(opts.resume);
    if (!agent) {
      return {
        tool_use_id: "",
        content: `Error: No agent found with id "${opts.resume}"`,
        is_error: true,
      };
    }

    if (agent.status === "running") {
      return {
        tool_use_id: "",
        content: JSON.stringify({
          agentId: agent.id,
          status: "running",
          content: "Agent is still running...",
          durationMs: Date.now() - agent.startTime,
        }),
      };
    }

    return {
      tool_use_id: "",
      content: JSON.stringify({
        agentId: agent.id,
        status: agent.status,
        content: agent.content,
        durationMs: agent.durationMs,
        totalTokens: agent.totalTokens,
      }),
    };
  }

  const agentId = randomUUID().slice(0, 8);
  const agentType = opts.type ?? "general";
  const startTime = Date.now();

  // Check for custom agent definition
  let customAgent: CustomAgentDef | null = null;
  if (agentType !== "general" && agentType !== "explore" && agentType !== "plan") {
    customAgent = findCustomAgent(agentType, process.cwd());
  }

  // Build the subagent command
  // The subagent runs the same CLI with a special flag
  const args: string[] = ["run", "src/index.ts", "--agent"];

  if (customAgent) {
    // Apply custom agent config
    if (customAgent.permissionMode) {
      args.push("--permission", customAgent.permissionMode);
    }
    if (customAgent.model) {
      args.push("-m", customAgent.model);
    }
    if (customAgent.maxTurns) {
      args.push("--max-turns", String(customAgent.maxTurns));
    }
    if (customAgent.tools && customAgent.tools.length > 0) {
      args.push("--tools", customAgent.tools.join(","));
    }
  } else if (agentType === "explore") {
    args.push("--read-only");
  } else if (agentType === "plan") {
    args.push("--read-only", "--plan");
  }

  // Set up isolation via git worktree
  let worktreePath: string | undefined;
  if (opts.isolation === "worktree") {
    try {
      const worktreeDir = `/tmp/kcode-worktree-${agentId}`;
      const branch = `kcode-agent-${agentId}`;
      const { execSync } = await import("node:child_process");
      execSync(`git worktree add -b ${branch} ${worktreeDir} HEAD`, {
        cwd: process.cwd(),
        stdio: "pipe",
      });
      worktreePath = worktreeDir;
    } catch (error) {
      return {
        tool_use_id: "",
        content: `Error creating git worktree: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true,
      };
    }
  }

  const cwd = worktreePath ?? process.cwd();

  const proc = spawn("bun", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  // Send the task to the subagent via stdin
  // Prepend custom agent system prompt if defined
  const taskPayload = customAgent?.systemPrompt
    ? `[Agent Context]\n${customAgent.systemPrompt}\n\n[Task]\n${opts.task}`
    : opts.task;
  proc.stdin.write(taskPayload + "\n");
  proc.stdin.end();

  const record: AgentRecord = {
    id: agentId,
    process: proc,
    status: "running",
    content: "",
    startTime,
  };
  runningAgents.set(agentId, record);

  const chunks: Buffer[] = [];
  const errChunks: Buffer[] = [];

  proc.stdout.on("data", (data: Buffer) => chunks.push(data));
  proc.stderr.on("data", (data: Buffer) => errChunks.push(data));

  const completionPromise = new Promise<void>((resolve) => {
    proc.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf-8");
      const stderr = Buffer.concat(errChunks).toString("utf-8");

      record.status = code === 0 ? "completed" : "failed";
      record.content = stdout || stderr || `(exit code ${code})`;
      record.durationMs = Date.now() - startTime;

      // Clean up worktree if used
      if (worktreePath) {
        try {
          const { execSync } = require("node:child_process");
          execSync(`git worktree remove ${worktreePath} --force`, {
            cwd: process.cwd(),
            stdio: "pipe",
          });
        } catch {
          // Best effort cleanup
        }
      }

      resolve();
    });

    proc.on("error", (err) => {
      record.status = "failed";
      record.content = `Error: ${err.message}`;
      record.durationMs = Date.now() - startTime;
      resolve();
    });
  });

  // Background mode: return immediately with agentId
  if (opts.run_in_background) {
    return {
      tool_use_id: "",
      content: JSON.stringify({
        agentId,
        status: "running",
        content: `Agent started in background. Use resume="${agentId}" to check status.`,
      }),
    };
  }

  // Foreground mode: wait for completion
  await completionPromise;

  return {
    tool_use_id: "",
    content: JSON.stringify({
      agentId: record.id,
      status: record.status,
      content: record.content,
      durationMs: record.durationMs,
      totalTokens: record.totalTokens,
    }),
    is_error: record.status === "failed",
  };
}
