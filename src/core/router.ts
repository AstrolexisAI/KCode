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
  /\b(refactor|debug|fix bug|implement|write code|create function|unit test|test for)\b/i,
  /\b(compile|build|deploy|migration|schema|endpoint|API)\b/i,
  /```[a-z]+\n/, // code blocks with language
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
  // code, config text, or file listings. Require the extension to be preceded
  // by a typical filename char and followed by a word boundary (whitespace,
  // end-of-string, quote, paren, bracket, comma).
  for (const ext of IMAGE_EXTENSIONS) {
    const re = new RegExp(`\\w${ext.replace(".", "\\.")}(?=[\\s"')\\],;:]|$)`, "i");
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
  | "analysis"     // deep analysis, audit, review, debug → [analysis, reasoning]
  | "complex-edit" // must find location in code → [coding]
  | "simple-edit"  // old_string given or trivial change → [coding, fast]
  | "multi-step"   // numbered/structured workflow → [structured, coding]
  | "chat"         // question, explain, discuss → [fast, cheap, local]
  | "vision"       // image input → [vision]
  | "general";     // default

const ANALYSIS_PATTERNS = [
  /\b(audit|analiz[ae]|revisar|review|debug|diagnos|investig|security|vulnerabil)\b/i,
  /\b(por qu[eé]|why does|root cause|explain.*code|code.*review)\b/i,
  /\b(benchmark|performance|profil|bottleneck)\b/i,
  // Technical complexity / algorithm questions
  /\b(complejidad|complexity|algoritm[oa]|big.?o|o\(n|o\(log|tradeoff|trade.?off)\b/i,
  /\b(cu[aá]ndo (usar|evitar|elegir|prefer)|when to (use|avoid|choose))\b/i,
  /\b(diferencia|difference|compar[ae]|pros?\s+(?:y|and)\s+cons?)\b/i,
];

const MULTI_STEP_PATTERNS = [
  /^\s*[1-9]\.\s/m,                    // numbered list: "1. do this"
  /\b(paso\s+[1-9]|step\s+[1-9])\b/i, // "paso 1", "step 1"
  /\btarea\s+[1-9]\b/i,               // "tarea 1"
  /\b(primero|luego|después|finalmente)\b.*\b(luego|después|finalmente)\b/i,
];

const SIMPLE_EDIT_PATTERNS = [
  /old_string|new_string/i,            // explicit old/new string
  /l[ií]nea\s+\d+/i,                  // "línea 42"
  /line\s+\d+/i,
  /\bagregá\s+(?:este|esta|el|la)\s+(?:bloque|línea|comentario)\b/i,
];

export function classifyBenchmarkTask(userMessage: string): BenchmarkTaskType {
  if (detectImageContent(userMessage)) return "vision";

  // Analysis: audit, review, debug, investigate
  if (ANALYSIS_PATTERNS.some((p) => p.test(userMessage))) return "analysis";

  // Multi-step: numbered instructions or structured workflow
  if (MULTI_STEP_PATTERNS.some((p) => p.test(userMessage))) return "multi-step";

  // Simple edit: explicit old_string or line number given
  if (SIMPLE_EDIT_PATTERNS.some((p) => p.test(userMessage))) return "simple-edit";

  // Complex edit: code modification without exact location
  // Also catches "cambia X a Y", "modifica", "actualiza" in spanish
  const COMPLEX_EDIT_EXTRA = /\b(cambia[r]?|modifica[r]?|actualiza[r]?|renombra[r]?|elimina[r]?|borra[r]?|reemplaza[r]?|replace|rename|remove|delete|update)\b/i;
  if (detectCodeTask(userMessage) || COMPLEX_EDIT_EXTRA.test(userMessage)) return "complex-edit";

  // Chat/question: only truly short/conversational — NOT technical questions
  // Threshold reduced to 80 chars (greetings, simple lookups)
  if (userMessage.length < 80 || detectSimpleTask(userMessage)) return "chat";

  return "general";
}

/** Tags required per benchmark task type (in priority order) */
const BENCHMARK_TAG_MAP: Record<BenchmarkTaskType, string[][]> = {
  "analysis":     [["analysis", "reasoning"], ["reasoning"], ["analysis"]],
  "complex-edit": [["coding", "fast"], ["coding"]],
  "simple-edit":  [["coding", "fast"], ["fast"], ["coding"]],
  "multi-step":   [["structured"], ["coding"]],
  "chat":         [["local"], ["fast", "cheap"], ["fast"], ["cheap"]],
  "vision":       [["vision"]],
  "general":      [["coding"], ["fast"]],
};

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
    // For "local" tag, only consider local models
    if (requiredTags.includes("local")) {
      const localModel = models.find((m) => LOCAL_PATTERNS.test(m.baseUrl));
      if (localModel && localModel.name !== defaultModel) {
        log.info("router/multi", `${taskType} → local: ${localModel.name}`);
        return { model: localModel.name, baseUrl: localModel.baseUrl };
      }
      continue;
    }

    // Find cloud models with ALL required tags
    const matched = models.filter((m) => {
      if (LOCAL_PATTERNS.test(m.baseUrl)) return false;
      const modelTags: string[] = (m as Record<string, unknown>).tags as string[] ?? m.capabilities ?? [];
      return requiredTags.every((t) => modelTags.includes(t));
    });

    if (matched.length > 0) {
      const different = matched.find((m) => m.name !== defaultModel);
      const chosen = different ?? matched[0]!;
      if (chosen.name !== defaultModel) {
        // Resolve API key for the new provider
        const { resolveApiKey } = await import("./request-builder.js");
        const { loadUserSettingsRaw } = await import("./config.js");
        let settings: Record<string, unknown> = {};
        try { settings = await loadUserSettingsRaw(); } catch { /* */ }
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
        const apiKey = resolveApiKey(chosen.name, chosen.baseUrl, fakeConfig as Parameters<typeof resolveApiKey>[2]);
        log.info("router/multi", `${taskType} [${requiredTags.join("+")}] → ${chosen.name} @ ${chosen.baseUrl}`);
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
  compiled: RegExp;
  /** Model name to route to */
  model: string;
  /** Optional description for logging */
  description?: string;
}

const MAX_PATTERN_LENGTH = 200;
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
  const rules = loadRoutingRules();
  for (const rule of rules) {
    if (rule.compiled.test(userMessage)) {
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

  const models = await listModels();

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
