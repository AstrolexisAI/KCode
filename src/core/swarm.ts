// KCode - Agent Swarm
// Run N agents in parallel with task delegation, message bus, and result merging.
// Usage: /swarm "analyze all test files for coverage gaps" --agents 4

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface SwarmTask {
  id: number;
  prompt: string;
  files?: string[];
  status: "pending" | "running" | "done" | "error";
  result?: string;
  durationMs?: number;
  error?: string;
}

export interface SwarmResult {
  tasks: SwarmTask[];
  totalDurationMs: number;
  successCount: number;
  errorCount: number;
  merged: string;
}

const MAX_AGENTS = 8;
const AGENT_TIMEOUT = 120_000; // 2 minutes per agent

/**
 * Split a list of files into N roughly equal chunks.
 */
export function chunkFiles(files: string[], n: number): string[][] {
  if (n <= 0 || files.length === 0) return [];
  const count = Math.min(n, files.length);
  const chunks: string[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < files.length; i++) {
    chunks[i % count]!.push(files[i]!);
  }
  return chunks.filter(c => c.length > 0);
}

/**
 * Run a single agent task using kcode subprocess.
 * Returns the agent's text output.
 */
function runAgent(
  prompt: string,
  cwd: string,
  model?: string,
): Promise<{ output: string; durationMs: number }> {
  const start = Date.now();
  const args = ["--print", "--permission", "deny", prompt];
  if (model) {
    args.unshift("-m", model);
  }
  const kcodebin = findKCodeBinary();

  return new Promise((resolve, reject) => {
    execFile(kcodebin, args, {
      cwd,
      timeout: AGENT_TIMEOUT,
      maxBuffer: 512 * 1024,
      env: { ...process.env },
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr || err.message;
        // Non-zero exit code means the agent failed — reject so runSwarm catches it
        reject(new Error(msg.slice(0, 500)));
      } else {
        resolve({ output: stdout.trim(), durationMs: Date.now() - start });
      }
    });
  });
}

/**
 * Find the kcode binary path.
 */
function findKCodeBinary(): string {
  const candidates = [
    join(process.env.HOME ?? "/home", ".local", "bin", "kcode"),
    join(process.env.HOME ?? "/home", "KCode", "dist", "kcode"),
    "/usr/local/bin/kcode",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "kcode"; // fall back to PATH
}

/**
 * Run a swarm of agents in parallel.
 *
 * @param masterPrompt - The overall task description
 * @param tasks - Individual task prompts for each agent
 * @param cwd - Working directory
 * @param model - Optional model to use
 */
export async function runSwarm(
  masterPrompt: string,
  tasks: string[],
  cwd: string,
  model?: string,
): Promise<SwarmResult> {
  const { getMaxSwarmAgents } = await import("./pro.js");
  const maxAgents = await getMaxSwarmAgents();
  const agentCount = Math.min(tasks.length, maxAgents);
  const start = Date.now();

  const swarmTasks: SwarmTask[] = tasks.slice(0, agentCount).map((prompt, i) => ({
    id: i + 1,
    prompt,
    status: "pending" as const,
  }));

  // Run all agents in parallel
  const promises = swarmTasks.map(async (task) => {
    task.status = "running";
    try {
      const { output, durationMs } = await runAgent(task.prompt, cwd, model);
      task.status = "done";
      task.result = output;
      task.durationMs = durationMs;
    } catch (err) {
      task.status = "error";
      task.error = err instanceof Error ? err.message : String(err);
    }
  });

  await Promise.all(promises);

  const successCount = swarmTasks.filter(t => t.status === "done").length;
  const errorCount = swarmTasks.filter(t => t.status === "error").length;

  // Merge results
  const mergedParts: string[] = [];
  for (const task of swarmTasks) {
    mergedParts.push(`── Agent ${task.id} (${task.durationMs ?? 0}ms) ──`);
    mergedParts.push(task.result ?? task.error ?? "(no output)");
    mergedParts.push("");
  }

  return {
    tasks: swarmTasks,
    totalDurationMs: Date.now() - start,
    successCount,
    errorCount,
    merged: mergedParts.join("\n"),
  };
}

/**
 * Auto-split a task across files and run swarm.
 * Given a prompt and list of files, distributes files among N agents.
 */
export async function runSwarmOnFiles(
  prompt: string,
  files: string[],
  cwd: string,
  agentCount: number = 4,
  model?: string,
): Promise<SwarmResult> {
  const { getMaxSwarmAgents } = await import("./pro.js");
  const maxAgents = await getMaxSwarmAgents();
  const effectiveAgentCount = Math.min(agentCount, maxAgents);

  const chunks = chunkFiles(files, effectiveAgentCount);

  const tasks = chunks.map((fileGroup, i) => {
    const fileList = fileGroup.join("\n  ");
    return `${prompt}\n\nYou are agent ${i + 1}/${chunks.length}. Focus ONLY on these files:\n  ${fileList}`;
  });

  return runSwarm(prompt, tasks, cwd, model);
}

/**
 * Format swarm results for display.
 */
export function formatSwarmResult(result: SwarmResult): string {
  const lines: string[] = [
    `  Swarm Results\n`,
    `  Agents: ${result.tasks.length}  Success: ${result.successCount}  Errors: ${result.errorCount}`,
    `  Total time: ${(result.totalDurationMs / 1000).toFixed(1)}s\n`,
  ];

  for (const task of result.tasks) {
    const icon = task.status === "done" ? "\u2713" : "\u2717";
    const dur = task.durationMs ? `${(task.durationMs / 1000).toFixed(1)}s` : "?";
    lines.push(`  ${icon} Agent ${task.id} (${dur})`);

    const output = task.result ?? task.error ?? "(no output)";
    const preview = output.split("\n").slice(0, 5);
    for (const line of preview) {
      lines.push(`    ${line.slice(0, 120)}`);
    }
    if (output.split("\n").length > 5) {
      lines.push(`    ... (${output.split("\n").length - 5} more lines)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
