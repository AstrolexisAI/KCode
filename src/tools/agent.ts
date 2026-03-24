// KCode - Agent Tool
// Spawns subagent processes for parallel/background task execution

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ToolDefinition, ToolResult } from "../core/types";
import { findCustomAgent, getAgentMemoryPath, type CustomAgentDef, type AgentHookEntry, type AgentHookAction } from "../core/custom-agents";
import { HookManager, isWorkspaceTrusted } from "../core/hooks";
import { log } from "../core/logger";

// ─── Agent Hook Helpers ──────────────────────────────────────────

/** Validate that a webhook URL is safe (no SSRF to private IPs/metadata). */
function isHookUrlSafe(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    // Block internal/metadata hostnames
    if (hostname === "localhost" || hostname === "metadata.google.internal" || hostname === "metadata.google") return false;
    // Block private IP ranges
    if (/^127\./.test(hostname)) return false;
    if (/^10\./.test(hostname)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;
    if (/^192\.168\./.test(hostname)) return false;
    if (/^169\.254\./.test(hostname)) return false;
    if (/^0\./.test(hostname) || hostname === "0.0.0.0") return false;
    if (hostname === "::1" || hostname === "[::1]") return false;
    if (/^fe80:/i.test(hostname) || /^fd/i.test(hostname) || /^fc/i.test(hostname)) return false;
    const v4mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (v4mapped) return isHookUrlSafe(`http://${v4mapped[1]}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute agent-scoped hooks safely with URL validation and error logging.
 * Only runs hooks from user-level agents (~/.kcode/agents/) or trusted workspaces.
 */
function executeAgentScopedHooks(
  hooks: AgentHookEntry[],
  eventName: string,
  context: Record<string, unknown>,
  cwd: string,
  agentSourcePath: string,
): void {
  // Workspace trust: if agent loaded from project .kcode/agents/, require trust
  const isProjectAgent = !agentSourcePath.startsWith(homedir()) && agentSourcePath !== "(inline)";
  if (isProjectAgent && !isWorkspaceTrusted(cwd)) {
    log.warn("agent-hooks", `Skipping agent hooks: workspace ${cwd} is not trusted`);
    return;
  }

  // Map aliases: "start" → "SubagentStart", "stop" → "SubagentStop"
  const aliases: Record<string, string> = { start: "SubagentStart", stop: "SubagentStop" };

  for (const hook of hooks) {
    const normalizedEvent = aliases[hook.event] ?? hook.event;
    if (normalizedEvent !== eventName) continue;
    for (const action of hook.actions) {
      if (action.type === "command" && action.command) {
        const env: Record<string, string | undefined> = { ...process.env };
        for (const [k, v] of Object.entries(context)) {
          if (typeof v === "string" || typeof v === "number") {
            env[`KCODE_HOOK_${k.toUpperCase()}`] = String(v);
          }
        }
        spawn("sh", ["-c", action.command], {
          cwd,
          stdio: "ignore",
          env,
          timeout: action.timeout ?? 10_000,
        });
      }
      if (action.type === "http" && action.url) {
        if (!isHookUrlSafe(action.url)) {
          log.warn("agent-hooks", `Blocked agent hook URL (SSRF): ${action.url}`);
          continue;
        }
        fetch(action.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event: eventName, ...context }),
          signal: AbortSignal.timeout(action.timeout ?? 10_000),
        }).catch((err) => {
          log.warn("agent-hooks", `Agent HTTP hook failed: ${err instanceof Error ? err.message : err}`);
        });
      }
    }
  }
}

// ─── Tmux Mode ──────────────────────────────────────────────────

let tmuxEnabled = false;

/** Enable or disable tmux mode for worktree agents. */
export function setTmuxMode(enabled: boolean): void {
  tmuxEnabled = enabled;
}

/** Check if we are inside a tmux session. */
function isTmuxAvailable(): boolean {
  return !!process.env.TMUX;
}

export interface AgentInput {
  task: string;
  type?: string; // "general" | "explore" | "plan" | custom agent name
  run_in_background?: boolean;
  resume?: string;
  isolation?: "none" | "worktree";
  teamId?: string; // Group agents into a team
  agentName?: string; // Human-readable name for this agent
  shareResults?: boolean; // Share results with team members
}

interface AgentRecord {
  id: string;
  process: ChildProcess;
  status: "running" | "completed" | "failed";
  content: string;
  startTime: number;
  durationMs?: number;
  totalTokens?: number;
  teamId?: string;
  agentName?: string;
  shareResults?: boolean;
  isLeadAgent?: boolean;
}

const runningAgents = new Map<string, AgentRecord>();

/** Time in ms after which completed agent entries are eligible for cleanup. */
const COMPLETED_AGENT_TTL = 5 * 60 * 1000; // 5 minutes

/** Kill all running child processes and clear the map. Called on process exit. */
function cleanupAgents(): void {
  for (const agent of runningAgents.values()) {
    if (agent.status === "running" && agent.process && !agent.process.killed) {
      try {
        agent.process.kill();
      } catch {
        // Best effort — process may already be dead
      }
    }
  }
  runningAgents.clear();
}

/** Remove completed/failed entries older than COMPLETED_AGENT_TTL. */
function pruneCompletedAgents(): void {
  const now = Date.now();
  for (const [id, agent] of runningAgents) {
    if (
      agent.status !== "running" &&
      agent.durationMs !== undefined &&
      now - (agent.startTime + agent.durationMs) > COMPLETED_AGENT_TTL
    ) {
      runningAgents.delete(id);
    }
  }
}

// Register cleanup handler (exit only — SIGINT is handled by the main TUI)
process.on("exit", cleanupAgents);

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
      teamId: {
        type: "string",
        description:
          "Group agents into a team. The first agent spawned with a given teamId becomes the lead agent. Subsequent agents in the same team can access completed results from teammates.",
      },
      agentName: {
        type: "string",
        description:
          "Human-readable name for this agent (e.g., 'edit-auth-files'). Used in team status reports.",
      },
      shareResults: {
        type: "boolean",
        description:
          "When true, this agent's results are shared with other agents in the same team. Defaults to false.",
      },
    },
    required: ["task"],
  },
};

export async function executeAgent(input: Record<string, unknown>): Promise<ToolResult> {
  const opts = input as AgentInput;

  // Prune completed agent entries older than 5 minutes to prevent unbounded growth
  pruneCompletedAgents();

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

  // Team mode: determine if this is the lead agent
  let isLeadAgent = false;
  if (opts.teamId) {
    const existingTeamMembers = getTeamAgentRecords(opts.teamId);
    isLeadAgent = existingTeamMembers.length === 0;
  }

  // Check for custom agent definition
  let customAgent: CustomAgentDef | null = null;
  if (agentType !== "general" && agentType !== "explore" && agentType !== "plan") {
    customAgent = findCustomAgent(agentType, process.cwd());
  }

  // Build the subagent command
  // The subagent runs the same CLI with a special flag
  const args: string[] = ["run", "src/index.ts", "--agent"];

  if (customAgent) {
    // Apply custom agent config — CLI flags
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
      args.push("--allowed-tools", customAgent.tools.join(","));
    }
    if (customAgent.disallowedTools && customAgent.disallowedTools.length > 0) {
      args.push("--disallowed-tools", customAgent.disallowedTools.join(","));
    }
    if (customAgent.effort) {
      args.push("--effort", customAgent.effort);
    }
    // MCP config: write to temp file and pass via --mcp-config
    if (customAgent.mcpServers && Object.keys(customAgent.mcpServers).length > 0) {
      const mcpConfigPath = `/tmp/kcode-agent-mcp-${agentId}.json`;
      writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: customAgent.mcpServers }), { mode: 0o600 });
      args.push("--mcp-config", mcpConfigPath);
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
      execFileSync("git", ["worktree", "add", "-b", branch, worktreeDir, "HEAD"], {
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

  // Tmux mode: open worktree agent in a new tmux pane instead of background
  if (tmuxEnabled && worktreePath && isTmuxAvailable()) {
    // Write task and launcher script to temp files to avoid shell injection
    const taskFile = join(worktreePath, ".kcode-task.txt");
    const launcherFile = join(worktreePath, ".kcode-launcher.sh");
    writeFileSync(taskFile, opts.task, { mode: 0o600 });
    // Build launcher script with properly quoted arguments
    const quotedArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    writeFileSync(launcherFile, `#!/bin/sh\nbun ${quotedArgs} < .kcode-task.txt\nrm -f .kcode-task.txt .kcode-launcher.sh\n`, { mode: 0o700 });
    try {
      execFileSync("tmux", ["split-window", "-h", "-c", worktreePath, "sh", ".kcode-launcher.sh"], {
        cwd: worktreePath,
        stdio: "pipe",
      });
      return {
        tool_use_id: "",
        content: JSON.stringify({
          agentId,
          status: "tmux",
          content: `Agent spawned in tmux pane (worktree: ${worktreePath}, branch: kcode-agent-${agentId})`,
        }),
      };
    } catch (err) {
      // Fall through to normal spawn if tmux fails
      console.error(`[Agent] tmux spawn failed, falling back to normal: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Build environment — overlay agent-specific API credentials and memory path
  // apiKey and apiBase are already validated by custom-agents.ts (no newlines/nulls, valid URL)
  const agentEnv: Record<string, string | undefined> = { ...process.env };
  if (customAgent?.apiKey) {
    agentEnv.KCODE_API_KEY = customAgent.apiKey;
  }
  if (customAgent?.apiBase) {
    agentEnv.KCODE_API_BASE = customAgent.apiBase;
  }
  const memoryDir = customAgent ? getAgentMemoryPath(customAgent) : null;
  if (memoryDir) {
    agentEnv.KCODE_AGENT_MEMORY_DIR = memoryDir;
  }
  if (customAgent?.name) {
    agentEnv.KCODE_AGENT_NAME = customAgent.name;
  }

  let proc: ChildProcess;
  try {
    proc = spawn("bun", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: agentEnv,
    });
  } catch (spawnError) {
    // Clean up worktree if spawn fails synchronously
    if (worktreePath) {
      try {
        execFileSync("git", ["worktree", "remove", worktreePath, "--force"], { cwd: process.cwd(), stdio: "pipe", timeout: 10000 });
        execFileSync("git", ["branch", "-D", `kcode-agent-${agentId}`], { cwd: process.cwd(), stdio: "pipe", timeout: 5000 });
      } catch { /* best effort */ }
    }
    return {
      tool_use_id: "",
      content: `Error spawning agent: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`,
      is_error: true,
    };
  }

  // Send the task to the subagent via stdin
  // Build rich context block from agent definition
  let taskPayload = "";
  if (customAgent) {
    const contextParts: string[] = [];
    if (customAgent.systemPrompt) {
      contextParts.push(customAgent.systemPrompt);
    }
    if (customAgent.skills && customAgent.skills.length > 0) {
      contextParts.push(`[Allowed Skills: ${customAgent.skills.join(", ")}]`);
    }
    if (customAgent.hooks && customAgent.hooks.length > 0) {
      contextParts.push(`[Agent Hooks: ${customAgent.hooks.length} hook(s) configured]`);
    }
    if (customAgent.memory) {
      contextParts.push(`[Agent Memory: enabled — stored at ${memoryDir}]`);
    }
    if (contextParts.length > 0) {
      taskPayload = `[Agent Context]\n${contextParts.join("\n")}\n\n[Task]\n${opts.task}`;
    } else {
      taskPayload = opts.task;
    }
  } else {
    taskPayload = opts.task;
  }

  // Inject shared team context from completed teammates
  if (opts.teamId) {
    const teamResults = getTeamResults(opts.teamId);
    if (teamResults.length > 0) {
      const contextBlock = teamResults
        .map((r) => `### ${r.agentName ?? r.agentId} (${r.status})\n${r.content}`)
        .join("\n\n");
      taskPayload = `[Team Context — results from completed teammates]\n${contextBlock}\n\n${taskPayload}`;
    }
  }
  proc.stdin.write(taskPayload + "\n");
  proc.stdin.end();

  const record: AgentRecord = {
    id: agentId,
    process: proc,
    status: "running",
    content: "",
    startTime,
    teamId: opts.teamId,
    agentName: opts.agentName,
    shareResults: opts.shareResults ?? false,
    isLeadAgent,
  };
  runningAgents.set(agentId, record);

  // Fire SubagentStart hook
  const hookManager = new HookManager(cwd);
  hookManager.fireAndForget("SubagentStart", {
    agent_id: agentId,
    agent_type: agentType,
    agent_name: customAgent?.name ?? agentType,
    task: opts.task.slice(0, 200),
    background: !!opts.run_in_background,
    team_id: opts.teamId,
  });

  // Execute agent-scoped hooks (from custom agent definition)
  if (customAgent?.hooks) {
    executeAgentScopedHooks(customAgent.hooks, "SubagentStart", {
      agent_id: agentId, agent_type: agentType, agent_name: customAgent.name,
    }, cwd, customAgent.sourcePath);
  }

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

      // Fire SubagentStop hook
      hookManager.fireAndForget("SubagentStop", {
        agent_id: agentId,
        agent_type: agentType,
        agent_name: customAgent?.name ?? agentType,
        status: record.status,
        duration_ms: record.durationMs,
        exit_code: code ?? 1,
      });

      // Execute agent-scoped stop hooks
      if (customAgent?.hooks) {
        executeAgentScopedHooks(customAgent.hooks, "SubagentStop", {
          agent_id: agentId, agent_type: agentType, agent_name: customAgent.name,
          status: record.status, duration_ms: record.durationMs, exit_code: code ?? 1,
        }, cwd, customAgent.sourcePath);
      }

      // Clean up temp MCP config file
      const mcpConfigPath = `/tmp/kcode-agent-mcp-${agentId}.json`;
      try { unlinkSync(mcpConfigPath); } catch { /* may not exist */ }

      // Handle worktree cleanup — check for changes first
      if (worktreePath) {
        try {
          // Check if agent made changes
          const diffStat = execFileSync("git", ["diff", "--stat", "HEAD"], {
            cwd: worktreePath,
            stdio: "pipe",
            timeout: 5000,
          }).toString().trim();

          if (diffStat) {
            // Agent made changes — commit them and report the branch
            try {
              execFileSync("git", ["add", "-A"], { cwd: worktreePath, stdio: "pipe", timeout: 5000 });
              execFileSync("git", ["commit", "-m", `Agent ${agentId} changes`], { cwd: worktreePath, stdio: "pipe", timeout: 10000 });
            } catch {}
            const branch = `kcode-agent-${agentId}`;
            record.content += `\n\n[Worktree: changes on branch "${branch}" at ${worktreePath}. Merge with: git merge ${branch}]`;
          } else {
            // No changes — clean up completely
            execFileSync("git", ["worktree", "remove", worktreePath, "--force"], {
              cwd: process.cwd(),
              stdio: "pipe",
              timeout: 10000,
            });
            try {
              execFileSync("git", ["branch", "-D", `kcode-agent-${agentId}`], {
                cwd: process.cwd(),
                stdio: "pipe",
                timeout: 5000,
              });
            } catch {}
          }
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
    const response: Record<string, unknown> = {
      agentId,
      status: "running",
      content: `Agent started in background. Use resume="${agentId}" to check status.`,
    };
    if (opts.teamId) {
      response.teamId = opts.teamId;
      response.agentName = opts.agentName;
      response.isLeadAgent = isLeadAgent;
    }
    return {
      tool_use_id: "",
      content: JSON.stringify(response),
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

/** Get the number of currently running agents. */
export function getRunningAgentCount(): number {
  let count = 0;
  for (const agent of runningAgents.values()) {
    if (agent.status === "running") count++;
  }
  return count;
}

/** Get summary info for all running agents. */
export function getRunningAgentsSummary(): Array<{ id: string; elapsed: number }> {
  const result: Array<{ id: string; elapsed: number }> = [];
  const now = Date.now();
  for (const agent of runningAgents.values()) {
    if (agent.status === "running") {
      result.push({ id: agent.id.slice(0, 8), elapsed: now - agent.startTime });
    }
  }
  return result;
}

// --- Team Functions ---

/** Internal helper: get all AgentRecords belonging to a team. */
function getTeamAgentRecords(teamId: string): AgentRecord[] {
  const members: AgentRecord[] = [];
  for (const agent of runningAgents.values()) {
    if (agent.teamId === teamId) {
      members.push(agent);
    }
  }
  return members;
}

export interface TeamAgentStatus {
  agentId: string;
  agentName?: string;
  status: "running" | "completed" | "failed";
  isLeadAgent: boolean;
  durationMs?: number;
  elapsed: number;
}

export interface TeamStatus {
  teamId: string;
  totalAgents: number;
  running: number;
  completed: number;
  failed: number;
  agents: TeamAgentStatus[];
}

/** Get status of all agents in a team. */
export function getTeamStatus(teamId: string): TeamStatus {
  const members = getTeamAgentRecords(teamId);
  const now = Date.now();

  const agents: TeamAgentStatus[] = members.map((a) => ({
    agentId: a.id,
    agentName: a.agentName,
    status: a.status,
    isLeadAgent: a.isLeadAgent ?? false,
    durationMs: a.durationMs,
    elapsed: now - a.startTime,
  }));

  return {
    teamId,
    totalAgents: members.length,
    running: members.filter((a) => a.status === "running").length,
    completed: members.filter((a) => a.status === "completed").length,
    failed: members.filter((a) => a.status === "failed").length,
    agents,
  };
}

export interface TeamResult {
  agentId: string;
  agentName?: string;
  status: "completed" | "failed";
  content: string;
  durationMs?: number;
}

/** Get completed results from agents in a team (for context injection into running agents). */
export function getTeamResults(teamId: string): TeamResult[] {
  const results: TeamResult[] = [];
  for (const agent of runningAgents.values()) {
    if (
      agent.teamId === teamId &&
      agent.shareResults &&
      (agent.status === "completed" || agent.status === "failed")
    ) {
      results.push({
        agentId: agent.id,
        agentName: agent.agentName,
        status: agent.status,
        content: agent.content,
        durationMs: agent.durationMs,
      });
    }
  }
  return results;
}
