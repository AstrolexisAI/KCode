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
 * Resolve API credentials and endpoint shape for a given model/URL.
 * Mirrors the logic in request-builder.ts/resolveApiKey but without
 * requiring a full KCodeConfig — reads env vars directly.
 *
 * Returns:
 *   - headers to use (Authorization vs x-api-key)
 *   - URL path (/v1/chat/completions vs /v1/messages)
 *   - body shape ("openai" or "anthropic" — same fields but system
 *     prompt goes in a top-level `system` field for Anthropic)
 */
function resolveAgentAuth(
  modelName: string,
  baseUrl: string,
): {
  headers: Record<string, string>;
  urlPath: string;
  bodyShape: "openai" | "anthropic";
} {
  const lower = modelName.toLowerCase();
  const urlLower = baseUrl.toLowerCase();

  // Anthropic: needs x-api-key header, not Authorization bearer,
  // and uses /v1/messages with a different body shape.
  if (lower.startsWith("claude") || urlLower.includes("anthropic.com")) {
    const key = process.env.ANTHROPIC_API_KEY ?? "";
    return {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      urlPath: "/v1/messages",
      bodyShape: "anthropic",
    };
  }

  // All other providers use OpenAI-compatible endpoints + Bearer auth.
  // Pick the env var that matches the provider.
  let key = "";
  if (urlLower.includes("x.ai")) key = process.env.XAI_API_KEY ?? "";
  else if (urlLower.includes("groq.com")) key = process.env.GROQ_API_KEY ?? "";
  else if (urlLower.includes("deepseek.com")) key = process.env.DEEPSEEK_API_KEY ?? "";
  else if (urlLower.includes("together.xyz")) key = process.env.TOGETHER_API_KEY ?? "";
  else if (urlLower.includes("googleapis.com") || urlLower.includes("generativelanguage")) {
    key = process.env.GEMINI_API_KEY ?? "";
  } else if (urlLower.includes("openai.com")) {
    key = process.env.OPENAI_API_KEY ?? "";
  } else {
    // Unknown provider — try the generic KCODE_API_KEY fallback.
    key = process.env.KCODE_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;

  return {
    headers,
    urlPath: "/v1/chat/completions",
    bodyShape: "openai",
  };
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
 *
 * Supports both OpenAI-compatible and Anthropic endpoints. Picks
 * the right auth header and body shape via resolveAgentAuth().
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

  const auth = resolveAgentAuth(modelName, baseUrl);

  emit({ type: "progress", agentId: agent.id, message: `${agent.name} calling LLM` });

  // Body shape differs between Anthropic and OpenAI: Anthropic has a
  // top-level `system` field and the messages array only holds user/
  // assistant turns. OpenAI-compatible puts the system prompt as the
  // first message with role="system".
  const body: Record<string, unknown> =
    auth.bodyShape === "anthropic"
      ? {
          model: modelName,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
          max_tokens: 4096,
        }
      : {
          model: modelName,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          max_tokens: 4096,
          stream: false,
        };

  const url = `${baseUrl}${auth.urlPath}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: auth.headers,
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

  // Parse response — Anthropic uses a different shape than OpenAI.
  let content = "";
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    if (auth.bodyShape === "anthropic") {
      const json = (await response.json()) as {
        content: Array<{ type: string; text?: string }>;
        usage?: { input_tokens: number; output_tokens: number };
      };
      content = json.content
        ?.filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text!)
        .join("") ?? "";
      inputTokens = json.usage?.input_tokens ?? 0;
      outputTokens = json.usage?.output_tokens ?? 0;
    } else {
      const json = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };
      content = json.choices?.[0]?.message?.content ?? "";
      inputTokens = json.usage?.prompt_tokens ?? 0;
      outputTokens = json.usage?.completion_tokens ?? 0;
    }
  } catch (err) {
    throw new Error(`Failed to parse LLM response: ${err instanceof Error ? err.message : String(err)}`);
  }

  agent.tokenUsage.input = inputTokens;
  agent.tokenUsage.output = outputTokens;
  // Approximate cost via the session pricing table
  try {
    const { getModelPricing, calculateCost } = await import("../pricing.js");
    const pricing = await getModelPricing(modelName);
    if (pricing) {
      agent.costUsd = calculateCost(pricing, inputTokens, outputTokens);
    }
  } catch {
    /* pricing lookup optional */
  }

  emit({
    type: "progress",
    agentId: agent.id,
    message: `${agent.name} done (${inputTokens + outputTokens} tokens)`,
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

    // 10-minute hard timeout — subprocess agents can't hang forever.
    // If the subprocess exceeds this, SIGTERM is sent, then SIGKILL
    // after a 5-second grace period.
    const TIMEOUT_MS = 10 * 60 * 1000;

    return new Promise<string>((resolve, reject) => {
      const proc = spawn(kcodeBin, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, KCODE_AGENT_NAME: agent.name, KCODE_AGENT_ROLE: agent.role },
      });

      let stdout = "";
      let stderr = "";
      let finished = false;

      // Schedule the kill fallback. Cleared when the subprocess exits
      // normally via close/error.
      const killTimer = setTimeout(() => {
        if (finished) return;
        log.warn("agent-executor", `${agent.name} exceeded ${TIMEOUT_MS}ms — SIGTERM`);
        try {
          proc.kill("SIGTERM");
        } catch {
          /* already dead */
        }
        // If it doesn't die within 5s, SIGKILL and reject hard.
        setTimeout(() => {
          if (finished) return;
          try {
            proc.kill("SIGKILL");
          } catch {
            /* already dead */
          }
          finished = true;
          reject(new Error(`${agent.name} timed out after ${TIMEOUT_MS}ms and was killed`));
        }, 5_000);
      }, TIMEOUT_MS);

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
        emit({ type: "progress", agentId: agent.id, message: "output received" });
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      proc.on("error", (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(killTimer);
        log.error("agent-executor", `spawn error: ${err.message}`);
        reject(err);
      });

      proc.on("close", (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(killTimer);
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
