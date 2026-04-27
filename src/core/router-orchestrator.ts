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

const MAX_SUB_TASK_TURNS = 12;
const SUMMARY_WARN_TURN = 10; // inject "wrap up" prompt at this turn
// For complex-edit: after this many read-only tool calls with no write,
// inject a "stop exploring, edit now" nudge. grok-code-fast-1 regressed
// into 12-turn reconnaissance loops without this.
const RECON_NUDGE_THRESHOLD = 5;
const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch"]);
const WRITE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "Bash"]);

function intentDirective(intent: string): string | null {
  switch (intent) {
    case "complex-edit":
    case "simple-edit":
      return "YOUR ROLE: make the code change. Use Read once to confirm the target, then Edit/Write. Do not do extensive exploration — the analysis is already given to you above. End with a 1-2 sentence description of what you changed.";
    case "analysis":
      return "YOUR ROLE: analyze the specified files and produce a written analysis. Read the relevant files, then write the analysis as text output. Do NOT attempt to edit or fix code — that's a separate sub-task.";
    case "chat":
      return "YOUR ROLE: answer the question as plain text. Do NOT use tools unless absolutely necessary. The context from other sub-tasks is given above — use it directly.";
    default:
      return null;
  }
}

export interface SubTaskResult {
  id: string;
  intent: string;
  model: string;
  output: string;
  error?: string;
  elapsedMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** True if the sub-task performed at least one successful write (Edit/Write/MultiEdit).
   *  Downstream sub-tasks check this to avoid describing work that didn't happen. */
  hadSuccessfulWrite?: boolean;
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
  fileLocks?: Map<string, Promise<unknown>>,
): Promise<OrchestrationResult> {
  const start = Date.now();
  const results = new Map<string, SubTaskResult>();
  // Always have a lock map even if caller didn't pass one — otherwise
  // parallel sub-tasks editing the same file would race with no protection.
  const sharedFileLocks = fileLocks ?? new Map<string, Promise<unknown>>();
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

    const promises = ready.map((task) => executeSubTask(task, config, defaultModel, results, onProgress, manager, sharedFileLocks));
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
  fileLocks?: Map<string, Promise<unknown>>,
): Promise<SubTaskResult> {
  const start = Date.now();

  let prompt = task.prompt;
  if (task.depends_on.length > 0) {
    const contextParts: string[] = [];
    const failedEditDeps: string[] = [];
    for (const depId of task.depends_on) {
      const depResult = completedResults.get(depId);
      if (!depResult) continue;
      if (depResult.output) {
        contextParts.push(`=== Output of task ${depId} (${depResult.intent}) ===\n${depResult.output}`);
      }
      // Flag edit-intent deps that made no successful writes — downstream
      // needs to know there's no actual change to describe, otherwise it
      // hallucinates (e.g., c inventing a "Plan tool fix" that never happened).
      if ((depResult.intent === "complex-edit" || depResult.intent === "simple-edit")
          && depResult.hadSuccessfulWrite === false) {
        failedEditDeps.push(depId);
      }
    }
    if (contextParts.length > 0) {
      prompt = `${contextParts.join("\n\n")}\n\n=== Your task (${task.id}) ===\n${task.prompt}`;
    }
    if (failedEditDeps.length > 0) {
      prompt += `\n\n---\nIMPORTANT: Task(s) ${failedEditDeps.join(", ")} did NOT perform any successful edits. If your task asks you to describe or explain "what was fixed", say explicitly that NO FIX WAS MADE and describe what was attempted instead. Do not invent a fix that didn't happen.`;
    }
  }

  // Intent-specific directive: anchor the model on its actual job so it
  // doesn't drift into reconnaissance loops (complex-edit) or fabrication
  // (chat) when the context is heavy.
  const directive = intentDirective(task.intent);
  if (directive) prompt = `${prompt}\n\n---\n${directive}`;

  const route = await resolveModelForSubTask(task, defaultModel);
  const model = route?.model ?? defaultModel;
  const baseUrl = route?.baseUrl ?? config.apiBase;
  const apiKey = route?.apiKey ?? config.apiKey;

  onProgress?.({ type: "task-start", id: task.id, intent: task.intent, model });

  try {
    const result = manager
      ? await runAgentLoopForSubTask(task, model, baseUrl, apiKey ?? "", prompt, config, manager, fileLocks)
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
      hadSuccessfulWrite: (result as { hadSuccessfulWrite?: boolean }).hadSuccessfulWrite,
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
  fileLocks?: Map<string, Promise<unknown>>,
): Promise<{ output: string; inputTokens?: number; outputTokens?: number; hadSuccessfulWrite?: boolean }> {
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
  const systemPrompt = parentConfig.systemPrompt as string | undefined;

  // Exclude tools that create persistent multi-turn state. Sub-tasks are
  // isolated and turn-limited; if they call Plan or TaskCreate, the state
  // gets left orphaned in the main session (plan stuck at 0/3 after b
  // exhausts turns, no one to mark steps done).
  const SUBTASK_EXCLUDED_TOOLS = new Set(["Plan", "TaskCreate", "TaskUpdate", "TaskStop"]);
  const tools = manager.getTools().filterOut(SUBTASK_EXCLUDED_TOOLS);
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
  // Track actions for synthetic summary if the sub-task runs out of turns
  // without producing text output (e.g. stuck in tool-call loop).
  const toolActionLog: Array<{ name: string; target: string; success: boolean }> = [];
  // Reconnaissance counter: read-only calls since the last write. Reset
  // whenever Edit/Write/Bash fires. Used to inject a "stop exploring" nudge
  // for edit sub-tasks that drift into pure exploration.
  let readOnlySinceWrite = 0;
  let reconNudgeFired = false;

  for (let turn = 0; turn < MAX_SUB_TASK_TURNS; turn++) {
    // Anti-reconnaissance nudge: for edit sub-tasks, if the model has only
    // read/grep/glob/ls for N calls, snap it out of exploration mode.
    const isEditIntent = task.intent === "complex-edit" || task.intent === "simple-edit";
    if (
      isEditIntent &&
      !reconNudgeFired &&
      readOnlySinceWrite >= RECON_NUDGE_THRESHOLD &&
      messages[messages.length - 1]?.role !== "user"
    ) {
      messages.push({
        role: "user",
        content: `You've done ${readOnlySinceWrite} read-only tool calls but no edit. The analysis is already provided above. Call Edit/Write NOW with your best available understanding, or say "[cannot edit: <reason>]" and stop. Do not call more Read/Grep/Glob/LS tools.`,
      });
      reconNudgeFired = true;
    }
    // At the warn turn, inject a "wrap up" user message so the model knows
    // to stop making tool calls and summarize what it did.
    if (turn === SUMMARY_WARN_TURN && messages[messages.length - 1]?.role !== "user") {
      messages.push({
        role: "user",
        content: `You have ${MAX_SUB_TASK_TURNS - turn} turn(s) left. Stop making tool calls now and write a short final summary of what you did and the result. Do NOT call any more tools.`,
      });
    }

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
      fileLocks,
    };
    const toolGen = executeToolsSequential(toolCalls as ToolUseBlock[], toolCtx, guardState);
    let toolGenResult = await toolGen.next();
    while (!toolGenResult.done) {
      toolGenResult = await toolGen.next();
    }
    const toolResult = toolGenResult.value;
    toolUseCount += toolCalls.length;

    // Record what tools did for potential synthetic summary, and update
    // the reconnaissance counter. Only reset on SUCCESSFUL writes — a
    // failed Edit (permission denied, bad old_string) shouldn't count as
    // progress; the model is still effectively exploring.
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]!;
      const resultBlock = toolResult.toolResultBlocks[i];
      const target = extractToolTarget(call.name, call.input as Record<string, unknown>);
      const success = !(resultBlock && (resultBlock as { is_error?: boolean }).is_error);
      toolActionLog.push({ name: call.name, target, success });
      if (WRITE_TOOLS.has(call.name) && success) {
        readOnlySinceWrite = 0;
      } else if (READ_ONLY_TOOLS.has(call.name) || (WRITE_TOOLS.has(call.name) && !success)) {
        // Failed writes count as exploration (model didn't produce a change)
        readOnlySinceWrite++;
      }
    }

    messages.push({ role: "user", content: toolResult.toolResultBlocks });
  }

  // If no text was produced but tools were executed, synthesize a summary from
  // the action log so downstream sub-tasks (c depends on b) have real context
  // instead of nothing (which causes hallucination).
  if (!finalText.trim() && toolActionLog.length > 0) {
    finalText = synthesizeActionSummary(toolActionLog);
  }

  // Compute whether any successful write happened — downstream sub-tasks use
  // this to avoid hallucinating "here's what was fixed" when nothing was fixed.
  const hadSuccessfulWrite = toolActionLog.some(
    (a) => WRITE_TOOLS.has(a.name) && a.success && a.name !== "Bash",
  );

  return {
    output: finalText || "[sub-task completed with no output]",
    inputTokens: totalInput,
    outputTokens: totalOutput,
    hadSuccessfulWrite,
  };
}

function extractToolTarget(name: string, input: Record<string, unknown>): string {
  if (name === "Read" || name === "Write" || name === "Edit" || name === "MultiEdit") {
    return String(input.file_path ?? "");
  }
  if (name === "Bash") return String(input.command ?? "").slice(0, 80);
  if (name === "Grep") return String(input.pattern ?? "");
  if (name === "Glob") return String(input.pattern ?? "");
  return "";
}

function synthesizeActionSummary(log: Array<{ name: string; target: string; success: boolean }>): string {
  const byName = new Map<string, { success: number; fail: number; targets: Set<string> }>();
  for (const a of log) {
    const entry = byName.get(a.name) ?? { success: 0, fail: 0, targets: new Set() };
    if (a.success) entry.success++;
    else entry.fail++;
    if (a.target) entry.targets.add(a.target);
    byName.set(a.name, entry);
  }
  const lines: string[] = ["[auto-generated summary — sub-task exhausted turns without explicit output]"];
  for (const [name, entry] of byName.entries()) {
    const total = entry.success + entry.fail;
    const targets = [...entry.targets].slice(0, 5).join(", ");
    lines.push(`- ${name}: ${total} call${total === 1 ? "" : "s"} (${entry.success} ok, ${entry.fail} fail)${targets ? ` on ${targets}` : ""}`);
  }
  // Highlight file modifications specifically (most important for downstream)
  const edits = log.filter((a) => ["Edit", "MultiEdit", "Write"].includes(a.name) && a.success);
  if (edits.length > 0) {
    lines.push(`\nFiles modified: ${[...new Set(edits.map((e) => e.target))].join(", ")}`);
  } else if (log.some((a) => ["Edit", "MultiEdit", "Write"].includes(a.name))) {
    lines.push(`\nNo files were modified (edits attempted but failed).`);
  }
  return lines.join("\n");
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
