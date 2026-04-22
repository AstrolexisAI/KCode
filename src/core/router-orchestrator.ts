// KCode - Multi-model DAG orchestrator
//
// Executes a ConductorPlan by running independent sub-tasks in parallel
// on their specialized models. Dependent sub-tasks wait for their
// predecessors and receive their outputs as context.
//
// Token efficiency rationale: instead of one generalist model processing
// the full mixed prompt, each sub-task gets ONLY its relevant portion,
// routed to the cheapest/fastest model that can handle it. Parallel
// execution means independent sub-tasks don't serialize wall-clock.

import { log } from "./logger";
import type { KCodeConfig, ContentBlock, Message, ToolUseBlock } from "./types";
import type { ConductorPlan, SubTask } from "./router-conductor";
import { resolveModelForSubTask } from "./router-conductor";
import type { ConversationManager } from "./conversation";

const MAX_SUB_TASK_TURNS = 8;

export interface SubTaskResult {
  id: string;
  intent: string;
  model: string;
  output: string;
  error?: string;
  elapsedMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface OrchestrationResult {
  results: SubTaskResult[];
  totalElapsedMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export type OrchestratorProgressEvent =
  | { type: "wave-start"; wave: number; taskIds: string[] }
  | { type: "task-start"; id: string; intent: string; model: string }
  | { type: "task-done"; id: string; model: string; elapsedMs: number; tokens: number }
  | { type: "task-error"; id: string; model: string; error: string };

/**
 * Execute the DAG. Independent sub-tasks run in parallel via Promise.all;
 * dependent ones wait for their predecessors and inject prior outputs
 * as context in their own prompt.
 */
export async function orchestratePlan(
  plan: ConductorPlan,
  config: KCodeConfig,
  defaultModel: string,
  onProgress?: (event: OrchestratorProgressEvent) => void,
  manager?: ConversationManager,
): Promise<OrchestrationResult> {
  const start = Date.now();
  const results = new Map<string, SubTaskResult>();
  let waveNum = 0;

  const pending = new Set(plan.sub_tasks.map((t) => t.id));
  const taskById = new Map(plan.sub_tasks.map((t) => [t.id, t]));

  while (pending.size > 0) {
    const ready: SubTask[] = [];
    for (const id of pending) {
      const task = taskById.get(id)!;
      if (task.depends_on.every((dep) => results.has(dep))) {
        ready.push(task);
      }
    }

    if (ready.length === 0) {
      log.error("router/orchestrator", `Deadlock in DAG — no tasks ready but ${pending.size} pending`);
      break;
    }

    waveNum++;
    log.info(
      "router/orchestrator",
      `Wave: ${ready.length} task(s) in parallel: ${ready.map((t) => t.id).join(",")}`,
    );
    onProgress?.({ type: "wave-start", wave: waveNum, taskIds: ready.map((t) => t.id) });

    const promises = ready.map((task) => executeSubTask(task, config, defaultModel, results, onProgress, manager));
    const batchResults = await Promise.all(promises);

    for (const r of batchResults) {
      results.set(r.id, r);
      pending.delete(r.id);
    }
  }

  const totalElapsedMs = Date.now() - start;
  const allResults = plan.sub_tasks
    .map((t) => results.get(t.id))
    .filter((r): r is SubTaskResult => r !== undefined);

  return {
    results: allResults,
    totalElapsedMs,
    totalInputTokens: allResults.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
    totalOutputTokens: allResults.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
  };
}

async function executeSubTask(
  task: SubTask,
  config: KCodeConfig,
  defaultModel: string,
  completedResults: Map<string, SubTaskResult>,
  onProgress?: (event: OrchestratorProgressEvent) => void,
  manager?: ConversationManager,
): Promise<SubTaskResult> {
  const start = Date.now();

  let prompt = task.prompt;
  if (task.depends_on.length > 0) {
    const contextParts: string[] = [];
    for (const depId of task.depends_on) {
      const depResult = completedResults.get(depId);
      if (depResult && depResult.output) {
        contextParts.push(`=== Output of task ${depId} (${depResult.intent}) ===\n${depResult.output}`);
      }
    }
    if (contextParts.length > 0) {
      prompt = `${contextParts.join("\n\n")}\n\n=== Your task (${task.id}) ===\n${task.prompt}`;
    }
  }

  const route = await resolveModelForSubTask(task, defaultModel);
  const model = route?.model ?? defaultModel;
  const baseUrl = route?.baseUrl ?? config.apiBase;
  const apiKey = route?.apiKey ?? config.apiKey;

  onProgress?.({ type: "task-start", id: task.id, intent: task.intent, model });

  try {
    const result = manager
      ? await runAgentLoopForSubTask(task, model, baseUrl, apiKey ?? "", prompt, config, manager)
      : await callModel(model, baseUrl, apiKey ?? "", prompt);
    const elapsedMs = Date.now() - start;
    onProgress?.({
      type: "task-done",
      id: task.id,
      model,
      elapsedMs,
      tokens: (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
    });
    return {
      id: task.id,
      intent: task.intent,
      model,
      output: result.output,
      elapsedMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("router/orchestrator", `Sub-task ${task.id} (${task.intent} → ${model}) failed: ${msg}`);
    onProgress?.({ type: "task-error", id: task.id, model, error: msg });
    return {
      id: task.id,
      intent: task.intent,
      model,
      output: `[task failed: ${msg}]`,
      error: msg,
      elapsedMs: Date.now() - start,
    };
  }
}

/**
 * Mini agent loop for a sub-task: stream → tool execution → feed back → repeat.
 * Uses the shared tool registry/permissions/hooks from the parent ConversationManager
 * so tool calls honor the same permission model and fire the same hooks.
 */
async function runAgentLoopForSubTask(
  task: SubTask,
  model: string,
  baseUrl: string,
  apiKey: string,
  initialPrompt: string,
  parentConfig: KCodeConfig,
  manager: ConversationManager,
): Promise<{ output: string; inputTokens?: number; outputTokens?: number }> {
  const { executeModelRequest } = await import("./request-builder");
  const { processSSEStream } = await import("./conversation-streaming");
  const { executeToolsSequential } = await import("./tool-executor");
  const { getModelContextSize } = await import("./models");
  const { LoopGuardState } = await import("./agent-loop-guards");

  // Clone config with this sub-task's model/url/key, preserving systemPrompt + flags
  const subConfig: KCodeConfig = {
    ...parentConfig,
    model,
    apiBase: baseUrl,
    apiKey,
    contextWindowSize: (await getModelContextSize(model)) ?? parentConfig.contextWindowSize,
  };

  const messages: Message[] = [
    { role: "user", content: initialPrompt },
  ];
  const systemPrompt = parentConfig._systemPrompt as string | undefined;

  const tools = manager.getTools();
  const permissions = manager.getPermissions();
  const hooks = manager.getHooks();
  const undoManager = manager.getUndo();
  const sessionId = manager.getSessionId();
  const abortController = new AbortController();
  const guardState = new LoopGuardState();

  let totalInput = 0;
  let totalOutput = 0;
  let finalText = "";
  let toolUseCount = 0;

  for (let turn = 0; turn < MAX_SUB_TASK_TURNS; turn++) {
    const sseStream = await executeModelRequest(
      model,
      subConfig,
      systemPrompt ?? "",
      messages,
      tools,
      abortController,
    );

    const cumulativeUsage = { inputTokens: 0, outputTokens: 0 };
    const streamGen = processSSEStream({
      sseStream,
      tools,
      accumulateUsage: (u) => {
        cumulativeUsage.inputTokens += u.inputTokens;
        cumulativeUsage.outputTokens += u.outputTokens;
      },
      cumulativeUsage,
      abortSignal: abortController.signal,
    });

    let genResult = await streamGen.next();
    while (!genResult.done) {
      genResult = await streamGen.next();
    }
    const { assistantContent, toolCalls, stopReason, textChunks, turnInputTokens, turnOutputTokens } =
      genResult.value;

    totalInput += turnInputTokens;
    totalOutput += turnOutputTokens;
    finalText = textChunks.join("");

    // Append assistant message (with potential tool calls) to history
    // Guard against undefined/null assistantContent (e.g. when stream
    // aborts mid-turn from a reasoning loop detection). Without this,
    // content=null lands in history and gets stripped by the global
    // sanitizer every subsequent turn, polluting the warn log.
    const safeContent = Array.isArray(assistantContent) && assistantContent.length > 0
      ? assistantContent
      : (textChunks.join("").trim()
        ? [{ type: "text" as const, text: textChunks.join("") }]
        : [{ type: "text" as const, text: stopReason === "repetition_aborted"
              ? "[sub-task response aborted due to repetition loop]"
              : "[sub-task produced no content]" }]);
    messages.push({ role: "assistant", content: safeContent });

    if (toolCalls.length === 0 || stopReason === "end_turn" || stopReason === "stop") {
      break;
    }

    // Execute tool calls and append results
    const toolCtx = {
      config: subConfig,
      tools,
      permissions,
      hooks,
      undoManager,
      sessionId,
      contextWindowSize: subConfig.contextWindowSize ?? 32_000,
      abortController,
      toolUseCount,
    };
    const toolGen = executeToolsSequential(toolCalls as ToolUseBlock[], toolCtx, guardState);
    let toolGenResult = await toolGen.next();
    while (!toolGenResult.done) {
      toolGenResult = await toolGen.next();
    }
    const toolResult = toolGenResult.value;
    toolUseCount += toolCalls.length;

    messages.push({ role: "user", content: toolResult.toolResultBlocks });
  }

  return {
    output: finalText || "[sub-task completed with no text output]",
    inputTokens: totalInput,
    outputTokens: totalOutput,
  };
}

async function callModel(
  modelName: string,
  baseUrl: string,
  apiKey: string,
  prompt: string,
): Promise<{ output: string; inputTokens?: number; outputTokens?: number }> {
  const url = baseUrl.toLowerCase();
  const isAnthropic = url.includes("anthropic.com");
  const endpoint = isAnthropic
    ? `${baseUrl}/v1/messages`
    : `${baseUrl}/v1/chat/completions`;

  const body = isAnthropic
    ? {
        model: modelName,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }
    : {
        model: modelName,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (isAnthropic) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json = (await res.json()) as Record<string, unknown>;

  let output = "";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  if (isAnthropic) {
    const content = json.content as Array<{ type: string; text?: string }> | undefined;
    output = content?.find((b) => b.type === "text")?.text ?? "";
    const usage = json.usage as Record<string, number> | undefined;
    inputTokens = usage?.input_tokens;
    outputTokens = usage?.output_tokens;
  } else {
    const choices = json.choices as Array<{ message: { content: string } }> | undefined;
    output = choices?.[0]?.message?.content ?? "";
    const usage = json.usage as Record<string, number> | undefined;
    inputTokens = usage?.prompt_tokens;
    outputTokens = usage?.completion_tokens;
  }

  return { output, inputTokens, outputTokens };
}

/**
 * Format the combined output for display as a single assistant message.
 * Each sub-task's output is shown with its model label.
 */
export function formatOrchestrationOutput(result: OrchestrationResult): string {
  if (result.results.length === 1) {
    // Single sub-task: return output directly, no header
    return result.results[0]!.output;
  }

  const lines: string[] = [];
  for (const r of result.results) {
    lines.push(`### Task ${r.id} — ${r.intent} (${r.model}, ${Math.round(r.elapsedMs / 100) / 10}s)`);
    lines.push("");
    lines.push(r.output);
    lines.push("");
  }
  const totalSec = Math.round(result.totalElapsedMs / 100) / 10;
  lines.push(`---`);
  lines.push(
    `Orchestration: ${result.results.length} sub-tasks, ${totalSec}s total (parallel saves vs. serial), ${result.totalInputTokens} in / ${result.totalOutputTokens} out tokens`,
  );
  return lines.join("\n");
}
