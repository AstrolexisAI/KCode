// KCode - Multi-intent conductor + DAG planner for router
//
// When a user prompt mixes multiple task types (e.g. "analizá X, arreglá
// los bugs, y explicame qué hace"), the regex classifier picks only ONE
// intent and routes to a single model that may not cover all the work.
//
// This module runs a fast/cheap model as a "conductor" that decomposes
// the prompt into a DAG of sub-tasks — each with its intent, the portion
// of the prompt that applies to it, and its dependencies on other tasks.
//
// The orchestrator then runs independent sub-tasks in PARALLEL on their
// specialized models (cheaper and faster than one generalist doing all),
// and serializes only the dependent ones.

import { log } from "./logger";
import { listModels } from "./models";
import type { BenchmarkTaskType } from "./router";

// Per-candidate timeouts: local models can take 5-15s on complex decomposition
// (no GPU streaming to worry about), while cloud providers should respond in
// 3-5s. If local is slow but the prompt clearly has multiple intents, we'd
// rather wait for the plan than fall through to single-intent.
const CONDUCTOR_TIMEOUT_MS_LOCAL = 20_000;
const CONDUCTOR_TIMEOUT_MS_CLOUD = 8_000;

export interface SubTask {
  /** Stable id: "a", "b", "c", ... */
  id: string;
  /** Task type — drives model selection */
  intent: BenchmarkTaskType;
  /** The portion of the user prompt that applies to this sub-task */
  prompt: string;
  /** Ids of sub-tasks whose output this one depends on */
  depends_on: string[];
}

export interface ConductorPlan {
  /** All sub-tasks in the DAG */
  sub_tasks: SubTask[];
  /** True if the plan was produced by the conductor, false on fallback */
  from_conductor: boolean;
}

/** Intent → tags that model should have */
export const INTENT_TAGS: Record<BenchmarkTaskType, string[]> = {
  "analysis":     ["analysis", "reasoning"],
  "complex-edit": ["coding"],
  "simple-edit":  ["coding", "fast"],
  "multi-step":   ["structured", "coding"],
  "chat":         ["fast", "cheap"],
  "vision":       ["vision"],
  "general":      ["coding"],
};

const SYSTEM_PROMPT = `You are a task decomposer for a coding assistant. The user's prompt may contain one task or multiple distinct tasks. Your job is to break it into a DAG of sub-tasks.

Valid intents:
- analysis    (audit, review, debug, investigate, explain why code does X)
- complex-edit (modify/add/remove code without exact line given)
- simple-edit  (edit with exact line or old_string)
- chat         (explain concept, greeting, question)
- vision       (image/screenshot input)

Rules:
1. Each sub-task gets a short "prompt" that is ONLY its portion of work
2. "depends_on" lists ids of sub-tasks whose OUTPUT this one needs
3. Edit tasks that modify code based on analysis MUST depend on the analysis
4. Pure chat/explain of a concept has NO dependencies
5. Give each sub-task a single-letter id starting from "a"

Return ONLY JSON, no markdown. Format:
{"sub_tasks":[{"id":"a","intent":"analysis","prompt":"...","depends_on":[]}]}

Examples:

Input: "qué es un mutex?"
Output: {"sub_tasks":[{"id":"a","intent":"chat","prompt":"qué es un mutex?","depends_on":[]}]}

Input: "analizá router.ts y arreglá los bugs que encuentres"
Output: {"sub_tasks":[
  {"id":"a","intent":"analysis","prompt":"analizá router.ts","depends_on":[]},
  {"id":"b","intent":"complex-edit","prompt":"arreglá los bugs encontrados en router.ts","depends_on":["a"]}
]}

Input: "cambiá línea 5 de foo.ts a return false y explicame qué era antes"
Output: {"sub_tasks":[
  {"id":"a","intent":"simple-edit","prompt":"cambiá línea 5 de foo.ts a return false","depends_on":[]},
  {"id":"b","intent":"chat","prompt":"explicame qué había antes en línea 5 de foo.ts","depends_on":[]}
]}

Input: "Hacé 3 cosas: 1. analizá pricing.ts 2. decime el modelo más caro 3. explicame el output más barato"
Output: {"sub_tasks":[
  {"id":"a","intent":"analysis","prompt":"analizá pricing.ts","depends_on":[]},
  {"id":"b","intent":"chat","prompt":"decime el modelo más caro en pricing.ts","depends_on":["a"]},
  {"id":"c","intent":"chat","prompt":"explicame el output más barato en pricing.ts","depends_on":["a"]}
]}`;

/**
 * Ask the conductor to decompose the prompt into a sub-task DAG.
 * Returns null on timeout/failure — caller falls back to single-intent routing.
 */
export async function decomposePrompt(userPrompt: string): Promise<ConductorPlan | null> {
  const models = await listModels();
  const LOCAL_PATTERNS = /localhost|127\.0\.0\.1/;

  // Candidate priority: models with reliable structured JSON output first.
  // Empirically:
  //   claude-haiku: ~100% success rate, ~2s
  //   gpt-4o-mini:   ~95% success rate, ~1-2s
  //   grok-3-mini:   unreliable (often times out)
  //   grok-code-fast-1: reliable but "coding" not "cheap" tag
  //   mark7 local:   fails parse consistently — last resort only
  const claudeHaiku = models.find((m) => m.name.startsWith("claude-haiku-"));
  const gpt4oMini = models.find((m) => m.name === "gpt-4o-mini");
  const grokMini = models.find((m) => m.name === "grok-3-mini");
  const localModel = models.find((m) => LOCAL_PATTERNS.test(m.baseUrl));

  const candidates = [claudeHaiku, gpt4oMini, grokMini, localModel].filter(
    (m): m is NonNullable<typeof m> => m !== undefined,
  );

  for (const candidate of candidates) {
    try {
      const start = Date.now();
      const plan = await callConductor(candidate, userPrompt);
      if (plan) {
        const elapsed = Date.now() - start;
        const summary = plan.sub_tasks
          .map((t) => `${t.id}:${t.intent}${t.depends_on.length > 0 ? `<-${t.depends_on.join(",")}` : ""}`)
          .join(" ");
        log.info("router/conductor", `${candidate.name} → [${summary}] (${elapsed}ms)`);
        return plan;
      } else {
        // Model returned something that didn't parse — log at info level
        // so the user can see why the orchestrator was skipped.
        log.info("router/conductor", `${candidate.name} returned unparseable response — trying next candidate`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.info("router/conductor", `${candidate.name} failed (${msg}) — trying next candidate`);
    }
  }
  log.info("router/conductor", "all candidates failed — falling back to single-intent routing");
  return null;
}

async function callConductor(
  model: { name: string; baseUrl: string },
  userPrompt: string,
): Promise<ConductorPlan | null> {
  const { loadUserSettingsRaw } = await import("./config.js");
  const settings = await loadUserSettingsRaw();
  const url = model.baseUrl.toLowerCase();

  let apiKey = "";
  if (url.includes("anthropic.com")) apiKey = String(settings.anthropicApiKey ?? "");
  else if (url.includes("x.ai")) apiKey = String(settings.xaiApiKey ?? "");
  else if (url.includes("openai.com")) apiKey = String(settings.apiKey ?? "");
  else if (url.includes("moonshot")) apiKey = String(settings.kimiApiKey ?? "");

  const isAnthropic = url.includes("anthropic.com");
  const endpoint = isAnthropic
    ? `${model.baseUrl}/v1/messages`
    : `${model.baseUrl}/v1/chat/completions`;

  const body = isAnthropic
    ? {
        model: model.name,
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt.slice(0, 10000) }],
      }
    : {
        model: model.name,
        max_tokens: 500,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt.slice(0, 10000) },
        ],
      };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (isAnthropic) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const isLocal = /localhost|127\.0\.0\.1/.test(model.baseUrl);
  const timeoutMs = isLocal ? CONDUCTOR_TIMEOUT_MS_LOCAL : CONDUCTOR_TIMEOUT_MS_CLOUD;
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) return null;
  const json = (await res.json()) as Record<string, unknown>;

  let text = "";
  if (isAnthropic) {
    const content = json.content as Array<{ type: string; text?: string }> | undefined;
    text = content?.find((b) => b.type === "text")?.text ?? "";
  } else {
    const choices = json.choices as Array<{ message: { content: string } }> | undefined;
    text = choices?.[0]?.message?.content ?? "";
  }

  if (!text) return null;

  // Permissive extraction: models (esp. mark7 local) often wrap JSON in
  // markdown fences or prefix with explanations. Strip fences first, then
  // if the result isn't pure JSON, locate the first balanced {...} block.
  let cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  if (!cleaned.startsWith("{")) {
    // Find first { and the matching } via bracket counting
    const start = cleaned.indexOf("{");
    if (start >= 0) {
      let depth = 0;
      let end = -1;
      for (let i = start; i < cleaned.length; i++) {
        if (cleaned[i] === "{") depth++;
        else if (cleaned[i] === "}") {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end > start) cleaned = cleaned.slice(start, end + 1);
    }
  }
  try {
    const parsed = JSON.parse(cleaned);
    const valid = validatePlan(parsed);
    if (!valid) return null;
    return { sub_tasks: valid, from_conductor: true };
  } catch {
    return null;
  }
}

function validatePlan(parsed: unknown): SubTask[] | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (!Array.isArray(p.sub_tasks)) return null;

  const validIntents: BenchmarkTaskType[] = [
    "analysis", "complex-edit", "simple-edit", "multi-step", "chat", "vision", "general",
  ];
  const tasks: SubTask[] = [];
  const seenIds = new Set<string>();
  for (const raw of p.sub_tasks) {
    if (!raw || typeof raw !== "object") return null;
    const t = raw as Record<string, unknown>;
    if (typeof t.id !== "string" || !t.id) return null;
    if (seenIds.has(t.id)) return null;
    seenIds.add(t.id);
    if (typeof t.intent !== "string" || !validIntents.includes(t.intent as BenchmarkTaskType)) {
      return null;
    }
    if (typeof t.prompt !== "string" || !t.prompt.trim()) return null;
    const deps = Array.isArray(t.depends_on) ? t.depends_on : [];
    if (!deps.every((d: unknown) => typeof d === "string")) return null;
    tasks.push({
      id: t.id,
      intent: t.intent as BenchmarkTaskType,
      prompt: t.prompt,
      depends_on: deps as string[],
    });
  }
  if (tasks.length === 0) return null;

  // Validate deps reference existing ids and no self-reference
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      if (!seenIds.has(dep)) return null;
      if (dep === task.id) return null;
    }
  }

  // Proper cycle detection via DFS. LLMs occasionally emit a DAG like
  // a→b→a which would send the orchestrator into an infinite loop
  // (ready.length=0, pending>0, while loop doesn't exit).
  if (hasCycle(tasks)) {
    log.warn("router/conductor", "Plan has a dependency cycle — rejecting");
    return null;
  }
  return tasks;
}

function hasCycle(tasks: SubTask[]): boolean {
  const adjacency = new Map<string, string[]>();
  for (const t of tasks) adjacency.set(t.id, t.depends_on);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const t of tasks) color.set(t.id, WHITE);

  function dfs(id: string): boolean {
    const c = color.get(id);
    if (c === GRAY) return true;   // back edge = cycle
    if (c === BLACK) return false; // already fully explored
    color.set(id, GRAY);
    for (const dep of adjacency.get(id) ?? []) {
      if (dfs(dep)) return true;
    }
    color.set(id, BLACK);
    return false;
  }
  for (const t of tasks) {
    if (color.get(t.id) === WHITE && dfs(t.id)) return true;
  }
  return false;
}

/**
 * Resolve which cloud model should execute a given sub-task.
 * Returns { model, baseUrl, apiKey } or null if no suitable model.
 *
 * Heuristic override: chat sub-tasks with dependencies aren't really chat —
 * they're synthesis tasks that combine analysis + edit output into a final
 * explanation. mark7 local enters reasoning loops on heavy multi-context
 * synthesis, so we upgrade those to a cloud model with the "cheap" tag
 * instead.
 */
export async function resolveModelForSubTask(
  task: SubTask,
  defaultModel: string,
): Promise<{ model: string; baseUrl: string; apiKey?: string } | null> {
  const { selectBenchmarkModel } = await import("./router.js");

  // Synthesis chat: has deps → skip local, use cheap cloud instead
  if (task.intent === "chat" && task.depends_on.length > 0) {
    // Route as if it were "simple-edit" to get a cheap-fast cloud model
    // without the "local first" bias of the chat routing preference.
    const cloudRoute = await selectBenchmarkModel("simple-edit", defaultModel);
    if (cloudRoute) {
      log.info("router/conductor", `Chat sub-task ${task.id} has deps — upgrading to cloud (${cloudRoute.model})`);
      return cloudRoute;
    }
  }

  const route = await selectBenchmarkModel(task.intent, defaultModel);
  if (route) return route;
  return null;
}
