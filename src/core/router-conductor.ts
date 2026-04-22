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

const CONDUCTOR_TIMEOUT_MS = 4_000;

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

  const localModel = models.find((m) => LOCAL_PATTERNS.test(m.baseUrl));
  const grokMini = models.find((m) => m.name === "grok-3-mini");
  const fallbackModel = models.find((m) => {
    if (LOCAL_PATTERNS.test(m.baseUrl)) return false;
    const tags: string[] = (m as Record<string, unknown>).tags as string[] ?? m.capabilities ?? [];
    return tags.includes("fast") && tags.includes("cheap");
  });

  const candidates = [localModel, grokMini, fallbackModel].filter(
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
      }
    } catch (err) {
      log.debug("router/conductor", `${candidate.name} failed: ${err}`);
    }
  }
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
        messages: [{ role: "user", content: userPrompt.slice(0, 1500) }],
      }
    : {
        model: model.name,
        max_tokens: 500,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt.slice(0, 1500) },
        ],
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
    signal: AbortSignal.timeout(CONDUCTOR_TIMEOUT_MS),
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

  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
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

  // Validate deps reference existing ids and no cycles (simple check: deps must be earlier ids)
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      if (!seenIds.has(dep)) return null;
      if (dep === task.id) return null;
    }
  }
  return tasks;
}

/**
 * Resolve which cloud model should execute a given sub-task.
 * Returns { model, baseUrl, apiKey } or null if no suitable model.
 */
export async function resolveModelForSubTask(
  task: SubTask,
  defaultModel: string,
): Promise<{ model: string; baseUrl: string; apiKey?: string } | null> {
  const { selectBenchmarkModel } = await import("./router.js");
  const route = await selectBenchmarkModel(task.intent, defaultModel);
  if (route) return route;
  // Fallback: use default model
  return null;
}
