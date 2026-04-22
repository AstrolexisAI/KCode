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
import type { KCodeConfig } from "./types";
import type { ConductorPlan, SubTask } from "./router-conductor";
import { resolveModelForSubTask } from "./router-conductor";

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
): Promise<OrchestrationResult> {
  const start = Date.now();
  const results = new Map<string, SubTaskResult>();
  let waveNum = 0;

  // Topological execution: repeatedly find tasks whose deps are all complete
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

    const promises = ready.map((task) => executeSubTask(task, config, defaultModel, results, onProgress));
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
    const { output, inputTokens, outputTokens } = await callModel(
      model,
      baseUrl,
      apiKey ?? "",
      prompt,
    );
    const elapsedMs = Date.now() - start;
    onProgress?.({
      type: "task-done",
      id: task.id,
      model,
      elapsedMs,
      tokens: (inputTokens ?? 0) + (outputTokens ?? 0),
    });
    return { id: task.id, intent: task.intent, model, output, elapsedMs, inputTokens, outputTokens };
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
