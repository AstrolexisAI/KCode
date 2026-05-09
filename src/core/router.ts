// KCode - Multi-Model Router
// Routes requests to the best model based on message content and task type.
// Supports mid-session model switching for vision, code, and chat tasks.

import { existsSync, readFileSync } from "node:fs";
import { getDebugTracer } from "./debug-tracer";
import { log } from "./logger";
import { listModels } from "./models";
import { kcodePath } from "./paths";

// ─── Task Types ─────────────────────────────────────────────────

export type TaskType = "code" | "vision" | "chat" | "simple" | "reasoning" | "general";

// Image file extensions (mirrors IMAGE_EXTENSIONS from tools/read.ts)
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

// Patterns that indicate image content in message history
const IMAGE_INDICATORS = [
  "data:image/", // base64 data URIs
  "[Image:", // Read tool image output header
  "[image/png output]", // notebook image output
  "[image/jpeg output]", // notebook image output
];

// Patterns that indicate simple tasks (can use a faster model)
const SIMPLE_TASK_INDICATORS = [
  /^(show|list|find|search|grep|glob|read|cat|ls)\b/i,
  /^(what is|where is|how many)\b/i,
  /^(git status|git log|git diff|git show)\b/i,
];

/**
 * Detect whether the user message is a simple task that can use a faster model.
 */
function detectSimpleTask(text: string): boolean {
  if (text.length > 200) return false; // Long prompts are likely complex
  for (const pattern of SIMPLE_TASK_INDICATORS) {
    if (pattern.test(text.trim())) return true;
  }
  return false;
}

// Patterns that indicate code-heavy tasks
const CODE_INDICATORS = [
  /\b(refactor|debug|fix bug|fix the bug|implement|write code|create function|unit test|test for)\b/i,
  /\b(compile|build|deploy|migration|schema|endpoint|API)\b/i,
  /```[a-z]+\n/, // code blocks with language
  // Spanish: refactor, fix, write tests, create function/project, etc.
  // Allow optional article ("un", "una", "el", "la") between verb and target noun.
  /\b(refactor[aá]?|implement[aá]?|escrib[ií]?|escribir|crea[rd]?|cre[aá]|cre[aá]me|gener[ae]r?|gener[aá])\s+(?:un[ao]?|el|la|los|las|este|esta)?\s*(?:tests?|funci[oó]n|m[oó]dulo|clase|script|c[oó]digo|tipo|interface|api|endpoint|proyecto|app|aplicaci[oó]n|biblioteca|libreria|librer[ií]a|servicio|servidor|repo|repositorio|microservicio)/i,
  /\b(fix(ear)?|arregl[ae]r?|arregl[aá]|corregir?|corrig[ie]|debugg?[ae]?r?)\s+(?:el|la|los|este|esta|un|una|esto)?\s*(?:bug|error|issue|funci[oó]n|c[oó]digo|m[oó]dulo|tests?)/i,
  /\b(test[ae]?r?|testin?g)\b/i, // testing in any form
  /\b(typescript|javascript|python|rust|golang|ruby|kotlin|swift)\b/i,
];

// Patterns that indicate deep reasoning tasks
const REASONING_INDICATORS = [
  /\b(analyz|architect|design|plan|compar|trade.?off|pros?\s+(?:and|&)\s+cons?)\b/i,
  /\b(why does|explain why|root cause|investig|diagnos)\b/i,
  /\b(security audit|code review|performance review|audit)\b/i,
];

// ─── Detection ──────────────────────────────────────────────────

/**
 * Check whether a string contains signs of image content.
 */
function detectImageContent(text: string): boolean {
  for (const indicator of IMAGE_INDICATORS) {
    if (text.includes(indicator)) return true;
  }

  // Only detect image extensions in user-facing image references, not inside
  // code, config text, or file listings. Allow the extension to be preceded
  // by any path-like char (word, slash, dot) so /image.png, ./img.png,
  // ../pics/shot.jpg and bare image.png all match. End boundary: whitespace,
  // quote, paren, bracket, comma, colon, or end-of-string.
  for (const ext of IMAGE_EXTENSIONS) {
    const re = new RegExp(
      `(?:^|[\\w/.])[\\w.-]*?${ext.replace(".", "\\.")}(?=[\\s"')\\],;:]|$)`,
      "i",
    );
    if (re.test(text)) {
      // Extra guard: skip if the match is clearly inside a config line
      // (e.g. "VISION_SUPPORTED_FORMATS=png,jpg,jpeg")
      const match = text.match(re);
      if (match && match.index !== undefined) {
        const lineStart = text.lastIndexOf("\n", match.index) + 1;
        const line = text.slice(lineStart, text.indexOf("\n", match.index + 1));
        if (/^[A-Z_]+=/.test(line.trim()) || /formats?\s*[:=]/i.test(line)) {
          continue; // Skip env/config lines
        }
        return true;
      }
    }
  }

  return false;
}

/**
 * Detect whether the user message is primarily a code task.
 */
function detectCodeTask(text: string): boolean {
  for (const pattern of CODE_INDICATORS) {
    if (pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Detect whether the user message requires deep reasoning.
 */
function detectReasoningTask(text: string): boolean {
  for (const pattern of REASONING_INDICATORS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

export function classifyTask(userMessage: string): TaskType {
  if (detectImageContent(userMessage)) return "vision";
  if (detectSimpleTask(userMessage)) return "simple";
  if (detectReasoningTask(userMessage)) return "reasoning";
  if (detectCodeTask(userMessage)) return "code";

  // Default to general
  return "general";
}

// ─── Multi-model routing (benchmark-based tags) ──────────────────

/**
 * Extended task classification using benchmark results.
 * Maps to the tag system: coding, fast, analysis, reasoning, structured, local, cheap.
 */
export type BenchmarkTaskType =
  | "analysis" // deep analysis, audit, review, debug → [analysis, reasoning]
  | "complex-edit" // must find location in code → [coding]
  | "simple-edit" // old_string given or trivial change → [coding, fast]
  | "multi-step" // numbered/structured workflow → [structured, coding]
  | "chat" // question, explain, discuss → [fast, cheap, local]
  | "vision" // image input → [vision]
  | "general"; // default

const ANALYSIS_PATTERNS = [
  // Spanish imperatives (with/without accent). Note: \b breaks on accented chars in JS,
  // so accented forms use lookahead/lookbehind instead.
  /\b(audit[ae]?|analiz[ae]|revisar?|review|debugg?[ea]?|diagnos|investig[ae]?|security|vulnerabil|inspecciona?r?|examina?r?|verifica?r?|chequear?)\b/i,
  /(analiz[aá]|audit[aá]|revis[aá]|investig[aá]|debugge[aá]|inspeccio[nñ][aá]|examin[aá]|verific[aá])/i,
  /\b(por qu[eé]|why does|root cause|explain.*code|code.*review|understand.*how)\b/i,
  /\b(benchmark|performance|profil|bottleneck|mejorar.*performance)\b/i,
  // Technical complexity / algorithm questions
  /\b(complejidad|complexity|algoritm[oa]|big.?o|o\(n|o\(log|tradeoff|trade.?off)\b/i,
  /\b(cu[aá]ndo (usar|evitar|elegir|prefer)|when to (use|avoid|choose))\b/i,
  /\b(diferencia|difference|compar[ae]|pros?\s+(?:y|and)\s+cons?)\b/i,
  // Vision analysis: screenshots, captures
  /\b(captura|screenshot|image|foto|pantalla)\b/i,
];

// Monolithic creation prompts — "creá un proyecto X", "implementá Y", "escribí
// un script Z". These must NOT be decomposed into parallel sub-tasks: they're
// a single coherent construction task where each step depends on the previous.
// Running 6 parallel sub-tasks creates incoherent code written blindly.
const MONOLITHIC_CREATION_PATTERNS = [
  // Spanish creation verbs, imperatives + infinitives, with/without accent
  /\b(creá|crea\b|crear|cree|construye|construí|construir|armá|armar|implementá|implement[ae]\b|implementar|escribí|escrib[ae]\b|escribir|genera|generá|generar|desarrollá|desarrollar|programá|programar|diseña|diseñá|diseñar|hace|hacé|hacer)\s+(?:un|una|el|la|los|las|el?\s+)/i,
  // English creation verbs followed by article/project terms
  /\b(create|build|implement|make|write|generate|design|develop|scaffold|craft)\s+(?:an?|the|my|our|some|a\s+new)/i,
  // Explicit "from scratch" phrases
  /\b(from scratch|desde cero|nuevo proyecto|new project|fresh project)\b/i,
  // "Creame/Hazme un X"
  /\b(cre[aá]me|hazme|h[aá]game|armame|armáme)\s+(?:un|una|el|la)/i,
];

/**
 * True if the prompt asks to CREATE a new project/file/module from scratch.
 * Used to short-circuit the orchestrator: creation tasks shouldn't be
 * decomposed into parallel sub-tasks because each step depends on the prior
 * (file structure, entry points, package metadata all need coherent layout).
 */
export function isMonolithicCreation(userMessage: string): boolean {
  return MONOLITHIC_CREATION_PATTERNS.some((p) => p.test(userMessage));
}

// Prompts that clearly operate on the whole file / whole codebase (not a
// sliceable multi-task job). Same reasoning: one coherent edit, not parallel.
const WHOLE_SCOPE_PATTERNS = [
  /\b(refactoriz[aá]r?\s+todo|refactor\s+the\s+(?:whole|entire)|todo el archivo|entire file)\b/i,
  /\b(traducí|traducir|translate)\s+(?:el |the |this |este )/i,
  /\b(migrá|migrar|migrate)\s+.*(?:de|from|to|a)\s+(?:python|node|java|typescript|rust)/i,
  /\b(reescrib[ií]r?|reescribí|reescribe|rewrite|re-write)\s+(?:el|the|la|esta|todo)/i,
];

export function isWholeScopeEdit(userMessage: string): boolean {
  return WHOLE_SCOPE_PATTERNS.some((p) => p.test(userMessage));
}

const MULTI_STEP_PATTERNS = [
  /^\s*[1-9]\.\s/m, // numbered list: "1. do this"
  /\b(paso\s+[1-9]|step\s+[1-9])\b/i, // "paso 1", "step 1"
  /\b(tarea|task)\s+[1-9]\b/i, // "tarea 1" / "task 1"
  /\b(primero|luego|despu[eé]s|finalmente|segundo|tercero)\b.*\b(luego|despu[eé]s|finalmente|segundo|tercero)\b/i,
  /\b(first|then|next|finally|second|third)\b.*\b(then|next|finally|second|third)\b/i,
  // "Hacé N cosas" / "Do N things"
  /\b(hac[eé]|do)\s+[1-9]\s+(cosas|things|tareas|tasks)/i,
];

const SIMPLE_EDIT_PATTERNS = [
  /old_string|new_string/i, // explicit old/new string
  /l[ií]nea\s+\d+/i, // "línea 42"
  /line\s+\d+/i,
  /\bagregá\s+(?:este|esta|el|la)\s+(?:bloque|línea|comentario)\b/i,
];

export function classifyBenchmarkTask(userMessage: string): BenchmarkTaskType {
  if (detectImageContent(userMessage)) return "vision";

  // Multi-step FIRST — a prompt like "Hacé 3 cosas: 1. analizá..." should be
  // multi-step even though it contains "analizá". Structure wins over keyword.
  if (MULTI_STEP_PATTERNS.some((p) => p.test(userMessage))) return "multi-step";

  // Scaffold/creation BEFORE analysis. A prompt like "crear un proyecto nuevo
  // … para analizar la blockchain" is scaffold-first — the "analyze" is what
  // the product will do, not what the agent should do. Without this order,
  // the "analizar" keyword wins and the task is mis-routed to an analysis-
  // tuned model that emits inspection-style output instead of scaffolding.
  // See GitHub issue #101.
  if (isMonolithicCreation(userMessage)) return "complex-edit";

  // Analysis: audit, review, debug, investigate
  if (ANALYSIS_PATTERNS.some((p) => p.test(userMessage))) {
    if (/\b(captura|screenshot)\b/i.test(userMessage)) return "vision";
    return "analysis";
  }

  // Simple edit: explicit old_string or line number given
  if (SIMPLE_EDIT_PATTERNS.some((p) => p.test(userMessage))) return "simple-edit";

  // Complex edit: code modification without exact location
  // Two patterns: non-accented (word boundary works) + accented Spanish imperatives
  const COMPLEX_EDIT_BASE =
    /\b(cambiar?|modificar?|actualizar?|renombrar?|eliminar?|borrar?|reemplazar?|agregar?|añadir?|insertar?|quitar?|corregir|corrige|arreglar?|arregla|repara|repar[aá]r?|refactoriz[aá]r?|refactor\b|optimiz[aá]r?|fix\b|replace|rename|remove|delete|update|add|insert|append|remove|enhance|improve|clean\s*up)\b/i;
  const COMPLEX_EDIT_ACCENTED =
    /(cambi[aá]|modific[aá]|actualiz[aá]|renombr[aá]|elimin[aá]|borr[aá]|reemplaz[aá]|agreg[aá]|añad[ií]|insert[aá]|quit[aá]|corrig[eií]|correg[ií]|arregl[aá]|repar[aá]|refactor[ií][aá]|optimiz[aá]|mejor[aá])/i;
  if (
    detectCodeTask(userMessage) ||
    COMPLEX_EDIT_BASE.test(userMessage) ||
    COMPLEX_EDIT_ACCENTED.test(userMessage)
  )
    return "complex-edit";

  // Chat/question: only truly short/conversational — NOT technical questions
  // Threshold reduced to 80 chars (greetings, simple lookups)
  if (userMessage.length < 80 || detectSimpleTask(userMessage)) return "chat";

  return "general";
}

/** Tags required per benchmark task type (in priority order) */
const BENCHMARK_TAG_MAP: Record<BenchmarkTaskType, string[][]> = {
  analysis: [["analysis", "reasoning"], ["reasoning"], ["analysis"]],
  "complex-edit": [["coding", "fast"], ["coding"]],
  "simple-edit": [["coding", "fast"], ["fast"], ["coding"]],
  "multi-step": [["structured"], ["coding"]],
  chat: [["local"], ["fast", "cheap"], ["fast"], ["cheap"]],
  vision: [["vision"]],
  general: [["coding"], ["fast"]],
};

// ─── Cost-aware sorting ────────────────────────────────────────
//
// Within a tag group, prefer cheaper models. Local models (no
// pricePerMtok* fields, host on 127.0.0.1/localhost) cost zero.
// Cloud models without explicit pricing fall to a "moderate" sentinel
// so they don't beat verified-cheap models like Haiku.
//
// Pricing reference (approx USD per 1M tokens, late-2025 / early-
// 2026 list rates) — used as fallback when entry doesn't set explicit
// values. Conservative — favors known-cheap, never over-promises.
const PRICING_FALLBACK: ReadonlyArray<readonly [RegExp, number, number]> = [
  // model match, $/Mtok input, $/Mtok output
  [/^claude-haiku-/, 1, 5],
  [/^claude-sonnet-/, 3, 15],
  [/^claude-opus-/, 15, 75],
  [/^grok-3(-mini)?\b/, 2, 10],
  [/^grok-4(-fast|-1)?\b/, 5, 25],
  [/^gpt-4o-mini/, 0.15, 0.6],
  [/^gpt-4o\b/, 2.5, 10],
  [/^gpt-5/, 5, 20],
  [/^o1\b/, 15, 60],
  [/^o3-mini/, 1, 4],
  [/^o3\b/, 10, 40],
  [/^gemini-1\.5-flash/, 0.075, 0.3],
  [/^gemini-2-flash/, 0.1, 0.4],
  [/^gemini-2-pro/, 5, 15],
  [/^deepseek-v[23]/, 0.5, 2],
];

function isLocalUrl(baseUrl: string): boolean {
  return /localhost|127\.0\.0\.1|\.local\b/.test(baseUrl);
}

interface PricedModel {
  inPrice: number;
  outPrice: number;
}

/**
 * Resolve cost per 1M tokens for a model. Returns 0 for local,
 * explicit fields if set, fallback table match if found, or a
 * conservative cloud default ($5/$25) if nothing matches.
 */
export function priceModel(model: {
  name: string;
  baseUrl: string;
  pricePerMtokInput?: number;
  pricePerMtokOutput?: number;
}): PricedModel {
  if (isLocalUrl(model.baseUrl)) return { inPrice: 0, outPrice: 0 };
  if (model.pricePerMtokInput !== undefined && model.pricePerMtokOutput !== undefined) {
    return { inPrice: model.pricePerMtokInput, outPrice: model.pricePerMtokOutput };
  }
  for (const [re, inP, outP] of PRICING_FALLBACK) {
    if (re.test(model.name)) return { inPrice: inP, outPrice: outP };
  }
  // Unknown cloud model — conservative moderate estimate.
  return { inPrice: 5, outPrice: 25 };
}

/**
 * Compare two models by blended cost (input + output, weighted 1:3 to
 * approximate typical agentic-session ratio: more output than input).
 * Local models always sort first (cost 0).
 */
function compareModelCost(
  a: { name: string; baseUrl: string; pricePerMtokInput?: number; pricePerMtokOutput?: number },
  b: { name: string; baseUrl: string; pricePerMtokInput?: number; pricePerMtokOutput?: number },
): number {
  const ap = priceModel(a);
  const bp = priceModel(b);
  const aBlend = ap.inPrice + ap.outPrice * 3;
  const bBlend = bp.inPrice + bp.outPrice * 3;
  return aBlend - bBlend;
}

// ─── Default-model task mismatch detection ─────────────────────
//
// When multimodel routing is OFF, the user is using a single default
// model for everything. Some defaults are great for one kind of task
// and bad for another (Qwen3-Coder is excellent code-gen but ignores
// hints in agentic flows; Gemma is good at chat/translation but does
// not follow tool guidance for code edits). Detect that mismatch and
// suggest enabling multimodel routing so KCode picks per-task.
//
// Returns null when there's no mismatch (model is broadly OK for the
// task or we have no opinion on the combination).

export interface ModelTaskMismatch {
  /** One-sentence why this default model is weak for the current task. */
  reason: string;
  /** Concrete next step the user can take. */
  suggestion: string;
}

interface MismatchRule {
  modelMatch: RegExp;
  badTasks: ReadonlySet<BenchmarkTaskType>;
  reason: string;
}

const MISMATCH_RULES: ReadonlyArray<MismatchRule> = [
  {
    modelMatch: /qwen3-coder/i,
    badTasks: new Set<BenchmarkTaskType>(["analysis", "chat"]),
    reason:
      "Qwen3-Coder is excellent at code-gen but ignores tool-result hints in agentic / analysis prompts (verified 2026-05-08).",
  },
  {
    modelMatch: /gemma-?[234]/i,
    badTasks: new Set<BenchmarkTaskType>(["complex-edit", "simple-edit", "multi-step"]),
    reason:
      "Gemma family is chat/translation-tuned and falls into 'explain mode' on coding prompts instead of issuing tool calls.",
  },
  {
    modelMatch: /llama-?[23]\b|llama-3\.0-/i,
    badTasks: new Set<BenchmarkTaskType>(["complex-edit", "simple-edit", "multi-step", "analysis"]),
    reason:
      "Llama 2 / Llama 3.0 predate strong tool-use fine-tuning and are unreliable for agentic work.",
  },
  {
    modelMatch: /phi-(2|3)\b/i,
    badTasks: new Set<BenchmarkTaskType>(["complex-edit", "simple-edit", "multi-step", "analysis"]),
    reason: "Phi-2/3 are too small for reliable agentic tool use.",
  },
];

export function checkModelTaskMismatch(
  modelName: string,
  task: BenchmarkTaskType,
): ModelTaskMismatch | null {
  if (!modelName) return null;
  for (const rule of MISMATCH_RULES) {
    if (rule.modelMatch.test(modelName) && rule.badTasks.has(task)) {
      return {
        reason: rule.reason,
        suggestion:
          "Enable multi-model routing so KCode auto-picks a stronger model for this task: run `/multimodel on` (or set `multimodel: true` in ~/.kcode/settings.json).",
      };
    }
  }
  return null;
}

/**
 * Check if multimodel routing is enabled in settings.
 */
export function isMultimodelEnabled(): boolean {
  try {
    const settingsPath = kcodePath("settings.json");
    if (!existsSync(settingsPath)) return false;
    const data = JSON.parse(readFileSync(settingsPath, "utf-8"));
    return data?.multimodel === true;
  } catch {
    return false;
  }
}

export interface ModelRouteResult {
  model: string;
  baseUrl: string;
  /** Resolved API key for the new provider */
  apiKey?: string;
}

// ─── Endpoint liveness ──────────────────────────────────────────
//
// Local entries in models.json can outlive the server they pointed at
// (user stopped llama-server, switched model, etc.). When the router
// picks a dead entry, the chat fetch fails downstream and the user
// sees a connection error mid-conversation. Probe /v1/models before
// returning a local route, and cache the result for a short TTL so
// we don't hammer the same dead port on every turn.
//
// Cloud endpoints are not probed — DNS+TLS+API are virtually always
// up, the probe would add latency, and a transient 5xx would
// blacklist a working provider.

const ENDPOINT_PROBE_TTL_MS = 30_000;
const ENDPOINT_PROBE_TIMEOUT_MS = 1500;
const _endpointProbeCache = new Map<string, { alive: boolean; checkedAt: number }>();

/** Reset the in-memory liveness cache (testing). */
export function _resetEndpointProbeCache(): void {
  _endpointProbeCache.clear();
}

/**
 * Probe `${baseUrl}/v1/models` with a short timeout. Cached for
 * ENDPOINT_PROBE_TTL_MS so repeated routing decisions in the same
 * turn don't re-probe.
 */
export async function isEndpointAlive(baseUrl: string): Promise<boolean> {
  const now = Date.now();
  const cached = _endpointProbeCache.get(baseUrl);
  if (cached && now - cached.checkedAt < ENDPOINT_PROBE_TTL_MS) {
    return cached.alive;
  }
  let alive = false;
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
    const res = await fetch(url, { signal: AbortSignal.timeout(ENDPOINT_PROBE_TIMEOUT_MS) });
    alive = res.ok;
  } catch {
    alive = false;
  }
  _endpointProbeCache.set(baseUrl, { alive, checkedAt: now });
  return alive;
}

/**
 * Select the best model for a task using benchmark tags.
 * Returns the full route info (model + baseUrl + apiKey) so callers can
 * update config.apiBase and config.apiKey, not just config.model.
 * Returns null if no better model is found (use default).
 */
export async function selectBenchmarkModel(
  taskType: BenchmarkTaskType,
  defaultModel: string,
): Promise<ModelRouteResult | null> {
  const models = await listModels();
  const LOCAL_PATTERNS = /localhost|127\.0\.0\.1/;

  const tagGroups = BENCHMARK_TAG_MAP[taskType] ?? [["coding"]];

  for (const requiredTags of tagGroups) {
    // For "local" tag, prefer local model unconditionally — even if it's already
    // the current model. Routing may have previously switched to a cloud model
    // mid-session; chat tasks should always snap back to local.
    if (requiredTags.includes("local")) {
      // Walk all local candidates and probe each — a dead entry should
      // fall through to the next, not be returned as if it were live.
      const localCandidates = models.filter((m) => LOCAL_PATTERNS.test(m.baseUrl));
      for (const candidate of localCandidates) {
        if (await isEndpointAlive(candidate.baseUrl)) {
          if (candidate.name !== defaultModel) {
            log.info("router/multi", `${taskType} → local: ${candidate.name}`);
          }
          return { model: candidate.name, baseUrl: candidate.baseUrl };
        }
        log.info(
          "router/multi",
          `skip dead local endpoint: ${candidate.name} @ ${candidate.baseUrl}`,
        );
      }
      // No live local — fall through to next tag group (cloud, etc.)
      continue;
    }

    // Find cloud models with ALL required tags, excluding session-blacklisted
    const { isBlacklisted } = await import("./model-reliability.js");
    const matched = models.filter((m) => {
      if (LOCAL_PATTERNS.test(m.baseUrl)) return false;
      if (isBlacklisted(m.name)) return false;
      const modelTags: string[] =
        ((m as unknown as Record<string, unknown>).tags as string[]) ?? m.capabilities ?? [];
      return requiredTags.every((t) => modelTags.includes(t));
    });

    if (matched.length > 0) {
      // Cost-aware preference: among models satisfying the tag group,
      // pick the cheapest. Local always wins (cost 0); within cloud,
      // sort by blended $/Mtok. The "different from default" rule is
      // a tiebreak — prefer not switching just for the sake of it.
      // (Smart-escalation budget gate is the natural extension here —
      // skip a 3×-costlier escalation when session is past 75% of
      // budget. Deferred to a follow-up because the PolicyEngine
      // doesn't currently expose a singleton getter; would need a
      // small refactor.)
      const sorted = [...matched].sort(compareModelCost);
      const cheapestDifferent = sorted.find((m) => m.name !== defaultModel);
      const chosen = cheapestDifferent ?? sorted[0]!;
      if (chosen.name !== defaultModel) {
        // Resolve API key for the new provider
        const { resolveApiKey } = await import("./request-builder.js");
        const { loadUserSettingsRaw } = await import("./config.js");
        let settings: Record<string, unknown> = {};
        try {
          settings = await loadUserSettingsRaw();
        } catch {
          /* */
        }
        const fakeConfig = {
          apiKey: String(settings.apiKey ?? ""),
          anthropicApiKey: String(settings.anthropicApiKey ?? ""),
          xaiApiKey: String(settings.xaiApiKey ?? ""),
          groqApiKey: String(settings.groqApiKey ?? ""),
          geminiApiKey: String(settings.geminiApiKey ?? ""),
          deepseekApiKey: String(settings.deepseekApiKey ?? ""),
          togetherApiKey: String(settings.togetherApiKey ?? ""),
          kimiApiKey: String(settings.kimiApiKey ?? ""),
        };
        const apiKey = resolveApiKey(
          chosen.name,
          chosen.baseUrl,
          fakeConfig as Parameters<typeof resolveApiKey>[2],
        );
        log.info(
          "router/multi",
          `${taskType} [${requiredTags.join("+")}] → ${chosen.name} @ ${chosen.baseUrl}`,
        );
        return { model: chosen.name, baseUrl: chosen.baseUrl, apiKey };
      }
      return null; // already on the best model
    }
  }

  return null; // no better match
}

// ─── Router ─────────────────────────────────────────────────────

/**
 * Route a request to the most appropriate model based on content.
 * Supports multi-model routing within a single session.
 *
 * @param defaultModel - The currently configured model name
 * @param userMessage  - The latest user message text
 * @param hasImageContent - Optional explicit flag for image content
 * @returns The model name to use (may be the default if no routing needed)
 */
// ─── Custom Routing Rules ─────────────────────────────────────

interface RoutingRule {
  /** Regex pattern to match user message */
  pattern: string;
  /** Pre-compiled regex (cached) */
  compiled: RegExp | null;
  /** Model name to route to */
  model: string;
  /** Optional description for logging */
  description?: string;
}

const MAX_PATTERN_LENGTH = 200;

/**
 * Detect regex patterns prone to catastrophic backtracking (ReDoS).
 * Matches nested quantifiers and alternation-over-same-char — the two
 * classes that produce exponential time on adversarial input.
 *
 *   (a+)+         → nested quantifier
 *   (a|a)*        → alternation over same char
 *   (a*)*         → nested with *
 *   ([a-z]+)+     → nested quantifier in char class
 */
function isDangerousRegex(pattern: string): boolean {
  // Nested quantifier: (...<one-or-more-chars>+|*|?){+,*,?,{...}}
  if (/\([^)]*[+*?]\s*\)\s*[+*?{]/.test(pattern)) return true;
  // Alternation over identical branches: (foo|foo) or (a|a|a)
  const altMatch = pattern.match(/\(([^|()]+)(?:\|\1)+\)/);
  if (altMatch) return true;
  // Lots of unbounded quantifiers (more than 5) — practical heuristic
  if ((pattern.match(/[*+]/g)?.length ?? 0) > 5) return true;
  return false;
}

let customRules: RoutingRule[] | null = null;
let customRulesLoadedAt = 0;
const RULES_TTL_MS = 30_000; // Re-read settings every 30 seconds

function loadRoutingRules(): RoutingRule[] {
  // Re-read if cache is stale (TTL expired)
  if (customRules !== null && Date.now() - customRulesLoadedAt < RULES_TTL_MS) {
    return customRules;
  }
  customRules = [];
  customRulesLoadedAt = Date.now();

  // Load from ~/.kcode/settings.json → routing.rules
  const settingsPath = kcodePath("settings.json");
  try {
    if (existsSync(settingsPath)) {
      const data = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (Array.isArray(data?.routing?.rules)) {
        for (const rule of data.routing.rules) {
          if (
            rule.pattern &&
            rule.model &&
            typeof rule.pattern === "string" &&
            rule.pattern.length <= MAX_PATTERN_LENGTH
          ) {
            // Reject patterns with catastrophic backtracking signatures
            // (nested quantifiers like (a+)+ or (a|a)*) before compiling.
            // Even compiled, these can hang .test() on crafted input with
            // exponential time complexity (ReDoS).
            if (isDangerousRegex(rule.pattern)) {
              log.warn("router", `Refusing ReDoS-prone pattern: "${rule.pattern}"`);
              continue;
            }
            try {
              const compiled = new RegExp(rule.pattern, "i");
              customRules.push({ ...rule, compiled });
            } catch {
              log.warn("router", `Invalid regex in routing rule: "${rule.pattern}"`);
            }
          }
        }
      }
    }
  } catch (e) {
    log.warn("router", `Failed to load routing rules: ${e instanceof Error ? e.message : e}`);
  }

  return customRules;
}

// ─── Router ─────────────────────────────────────────────────

export async function routeToModel(
  defaultModel: string,
  userMessage: string,
  hasImageContent?: boolean,
): Promise<string> {
  // Smart routing is a Pro feature — free users always use defaultModel
  const { isPro } = await import("./pro.js");
  if (!(await isPro())) {
    // Free users still get vision routing (critical for image input)
    if (hasImageContent) {
      const models = await listModels();
      const visionModel = models.find(
        (m) => m.capabilities?.includes("vision") || m.capabilities?.includes("ocr"),
      );
      if (visionModel) return visionModel.name;
    }
    return defaultModel;
  }

  // Pro: full smart routing with custom rules and task classification
  const models = await listModels();
  const rules = loadRoutingRules();
  for (const rule of rules) {
    // Skip rules that got disabled in a prior call due to slowness
    if (!rule.compiled) continue;
    // ReDoS mitigation: cap input to 1000 chars + elapsed-time check.
    // JS can't interrupt sync regex, but if a rule takes >50ms even on
    // 1k chars it's definitely adversarial — disable it for this session.
    const testStart = Date.now();
    const matched = rule.compiled.test(userMessage.slice(0, 1000));
    if (Date.now() - testStart > 50) {
      log.warn(
        "router",
        `Rule "${rule.description ?? rule.pattern}" took ${Date.now() - testStart}ms — suspected ReDoS, disabling`,
      );
      (rule as { compiled: RegExp | null }).compiled = null;
      continue;
    }
    if (matched) {
      // Validate that the model exists before using it
      const modelExists = models.some((m) => m.name === rule.model);
      if (!modelExists) {
        log.warn(
          "router",
          `Custom rule matched invalid model: "${rule.description ?? rule.pattern}" → ${rule.model} (model not found, skipping rule)`,
        );
        continue;
      }
      log.info(
        "router",
        `Custom rule matched: "${rule.description ?? rule.pattern}" → ${rule.model}`,
      );
      return rule.model;
    }
  }

  const taskType = hasImageContent ? "vision" : classifyTask(userMessage);

  if (taskType === "general") {
    return defaultModel;
  }

  const capabilityMap: Record<string, string[]> = {
    simple: ["fast"],
    code: ["code"],
    reasoning: ["reasoning"],
    vision: ["vision", "ocr"],
  };

  const caps = capabilityMap[taskType];
  if (caps) {
    const matched = models.find((m) => caps.some((cap) => m.capabilities?.includes(cap)));
    if (matched && (taskType === "vision" || matched.name !== defaultModel)) {
      log.info("router", `Routing ${taskType} task to ${matched.name}`);
      const tracer = getDebugTracer();
      if (tracer.isEnabled()) {
        const candidates = models
          .filter((m) => caps.some((cap) => m.capabilities?.includes(cap)))
          .map((m) => m.name);
        tracer.traceRouting(taskType, matched.name, candidates);
      }
      return matched.name;
    }
    if (taskType === "vision" && !matched) {
      log.debug("router", "Image content detected but no vision model registered");
    }
  }

  return defaultModel;
}

/**
 * Cloud failover: try multiple providers in order (Pro only).
 * Returns the first successful response or throws the last error.
 */
export async function withCloudFailover<T>(
  models: string[],
  fn: (model: string) => Promise<T>,
): Promise<T> {
  const { isPro } = await import("./pro.js");
  if (!(await isPro()) || models.length <= 1) {
    return fn(models[0]!);
  }

  let lastError: Error | undefined;
  for (const model of models) {
    try {
      return await fn(model);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log.warn("router", `Model ${model} failed, trying next: ${lastError.message}`);
    }
  }
  throw lastError ?? new Error("All models in failover chain failed");
}

/** Reset cached routing rules (for testing or after config change). */
export function resetRoutingRules(): void {
  customRules = null;
}

/**
 * Select models for ensemble execution based on task type and available models.
 * Returns a list of recommended models for ensemble, or empty if not enough models.
 */
export async function selectEnsembleModels(
  userMessage: string,
  maxModels: number = 3,
): Promise<string[]> {
  const models = await listModels();
  if (models.length < 2) return [];

  const taskType = classifyTask(userMessage);
  const capabilityMap: Record<string, string[]> = {
    code: ["code"],
    reasoning: ["reasoning"],
    simple: ["fast"],
    vision: ["vision", "ocr"],
  };

  const caps = capabilityMap[taskType];
  const selected: string[] = [];

  // First, add models that match the task capability
  if (caps) {
    for (const m of models) {
      if (caps.some((cap) => m.capabilities?.includes(cap))) {
        selected.push(m.name);
        if (selected.length >= maxModels) break;
      }
    }
  }

  // Fill remaining slots with general models
  for (const m of models) {
    if (!selected.includes(m.name)) {
      selected.push(m.name);
      if (selected.length >= maxModels) break;
    }
  }

  return selected;
}

/**
 * Get all available models grouped by capability.
 * Useful for showing the user what models are available for what tasks.
 */
export async function getModelCapabilities(): Promise<Record<string, string[]>> {
  const models = await listModels();
  const capabilities: Record<string, string[]> = {
    code: [],
    vision: [],
    chat: [],
    fast: [],
    reasoning: [],
    general: [],
  };

  for (const m of models) {
    const caps = m.capabilities ?? [];
    if (caps.includes("vision") || caps.includes("ocr")) {
      capabilities.vision!.push(m.name);
    }
    if (caps.includes("code")) {
      capabilities.code!.push(m.name);
    }
    if (caps.includes("chat")) {
      capabilities.chat!.push(m.name);
    }
    if (caps.includes("fast")) {
      capabilities.fast!.push(m.name);
    }
    if (caps.includes("reasoning")) {
      capabilities.reasoning!.push(m.name);
    }
    // All models are general-purpose
    capabilities.general!.push(m.name);
  }

  return capabilities;
}
