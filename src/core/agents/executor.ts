// KCode — Agent executor
//
// Runs an agent as a mini-conversation against the active LLM. Each
// agent gets its own single-turn (or short multi-turn) request with
// the role's system-prompt seed and the task description. Tool
// calls are executed inline and emit progress events to the pool.
//
// This is intentionally simpler than the main ConversationManager —
// agents are short-lived, single-purpose sub-tasks, not full
// conversations. For heavier agent workloads (deep audits, multi-
// step refactors) the agent spawns nested Bash tool calls that do
// the real work.

import { log } from "../logger";
import { getModelBaseUrl, getDefaultModel } from "../models";
import { ROLES } from "./roles";
import type { Agent, AgentExecutor, PoolEvent } from "./types";

/**
 * Build a system prompt for an agent by concatenating the role seed
 * with task context (target path, group name, etc).
 */
function buildAgentSystemPrompt(agent: Agent): string {
  const role = ROLES[agent.role];
  const lines: string[] = [];
  lines.push(role.systemPromptSeed);
  lines.push("");
  lines.push(`You are **${agent.name}**, a ${role.displayName}.`);
  if (agent.group) {
    lines.push(`You are part of Group ${agent.group}.`);
  }
  if (agent.targetPath) {
    lines.push(`Your scope is limited to: ${agent.targetPath}`);
  }
  lines.push("");
  lines.push("Respond concisely with your findings or completed work.");
  lines.push("Do not chat — report results, then stop.");
  return lines.join("\n");
}

/**
 * Build the user message for an agent — just the task description
 * plus any scoped context.
 */
function buildAgentUserMessage(agent: Agent): string {
  const parts: string[] = [agent.task];
  if (agent.targetPath) {
    parts.push(`Target: ${agent.targetPath}`);
  }
  return parts.join("\n\n");
}

/**
 * Real LLM executor. Makes a single non-streaming request to the
 * active model with the agent's system prompt and task, then
 * returns the model's response as the agent's result.
 *
 * This is a minimal executor — it does NOT loop through tool calls
 * or handle multi-turn conversations. For agents that need tools
 * (auditor, fixer, tester), use `createSubprocessExecutor()` below
 * which spawns a real kcode subprocess with full tool access.
 */
export async function llmExecutor(
  agent: Agent,
  emit: (event: Extract<PoolEvent, { agentId: string }>) => void,
): Promise<string> {
  emit({ type: "progress", agentId: agent.id, message: `${agent.name} starting up` });

  const modelName = agent.model !== "inherited" ? agent.model : await getDefaultModel();
  const baseUrl = await getModelBaseUrl(modelName);
  const systemPrompt = buildAgentSystemPrompt(agent);
  const userMessage = buildAgentUserMessage(agent);

  emit({ type: "progress", agentId: agent.id, message: `${agent.name} calling LLM` });

  const body = {
    model: modelName,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    max_tokens: 4096,
    stream: false,
  };

  const apiKey = process.env.XAI_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.KCODE_API_KEY ?? "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const url = `${baseUrl}/v1/chat/completions`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Network error calling ${url}: ${msg}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`LLM ${response.status}: ${text.slice(0, 200)}`);
  }

  const json = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  const content = json.choices?.[0]?.message?.content ?? "";
  if (json.usage) {
    agent.tokenUsage.input = json.usage.prompt_tokens;
    agent.tokenUsage.output = json.usage.completion_tokens;
    // Approximate cost via the session pricing table
    try {
      const { getModelPricing, calculateCost } = await import("../pricing.js");
      const pricing = await getModelPricing(modelName);
      if (pricing) {
        agent.costUsd = calculateCost(
          pricing,
          agent.tokenUsage.input,
          agent.tokenUsage.output,
        );
      }
    } catch {
      /* pricing lookup optional */
    }
  }

  emit({
    type: "progress",
    agentId: agent.id,
    message: `${agent.name} done (${agent.tokenUsage.input + agent.tokenUsage.output} tokens)`,
  });

  return content || "(empty response from LLM)";
}

/**
 * Subprocess-based executor: spawns a fresh `kcode --print` subprocess
 * with the role's system prompt and the task as stdin. Useful when
 * the agent needs full tool access (bash, file writes, etc).
 *
 * Returns a closure that can be passed to pool.spawn() as the
 * executor argument. The closure captures cwd so agents run in the
 * right project directory.
 */
export function createSubprocessExecutor(cwd: string): AgentExecutor {
  return async function subprocessExecutor(agent, emit) {
    emit({ type: "progress", agentId: agent.id, message: `${agent.name} spawning subprocess` });

    const { spawn } = await import("node:child_process");
    const systemPrompt = buildAgentSystemPrompt(agent);
    const userMessage = buildAgentUserMessage(agent);

    // Locate the kcode binary — prefer ~/.bun/bin/kcode, fall back to
    // `kcode` on PATH.
    const { existsSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const bunBin = join(homedir(), ".bun", "bin", "kcode");
    const kcodeBin = existsSync(bunBin) ? bunBin : "kcode";

    // Use --print for non-interactive output, and --append-system-prompt
    // to inject the role seed. The task itself goes via stdin so
    // long prompts don't hit argv length limits.
    const args = ["--print", "--append-system-prompt", systemPrompt];

    const modelOverride = agent.model !== "inherited" ? agent.model : undefined;
    if (modelOverride) {
      args.push("--model", modelOverride);
    }

    return new Promise<string>((resolve, reject) => {
      const proc = spawn(kcodeBin, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, KCODE_AGENT_NAME: agent.name, KCODE_AGENT_ROLE: agent.role },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
        // Coarse progress event — the TUI just shows that the agent
        // is producing output. For per-tool visibility we'd need to
        // parse kcode's JSON output format (future work).
        emit({ type: "progress", agentId: agent.id, message: "output received" });
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      proc.on("error", (err) => {
        log.error("agent-executor", `spawn error: ${err.message}`);
        reject(err);
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`kcode exited with code ${code}: ${stderr.slice(0, 500)}`));
        }
      });

      // Send the task via stdin.
      proc.stdin.write(userMessage);
      proc.stdin.end();
    });
  };
}

/**
 * Pick the best executor for an agent based on its role. Simple
 * heuristic: roles that need to RUN things (fixer, tester, linter,
 * migration) get the subprocess executor so they have full tool
 * access. Read-only roles (auditor, reviewer, explorer, docs, scribe)
 * get the lightweight LLM executor.
 */
export function executorForRole(role: string, cwd: string): AgentExecutor {
  const needsTools = ["fixer", "tester", "linter", "migration", "worker", "optimizer"];
  if (needsTools.includes(role)) {
    return createSubprocessExecutor(cwd);
  }
  return llmExecutor;
}
