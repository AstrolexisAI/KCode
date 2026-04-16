// KCode - Dynamic Model Registry
// Models are configured via ~/.kcode/models.json, not hardcoded.
// Each model entry maps a name to a base URL and optional metadata.

import { join } from "node:path";
import { log } from "./logger";
import { kcodePath } from "./paths";

// ─── Types ──────────────────────────────────────────────────────

export type ModelProvider = "openai" | "anthropic";

export interface ModelEntry {
  name: string;
  baseUrl: string;
  contextSize?: number;
  capabilities?: string[]; // e.g. ["code", "vision", "general"]
  gpu?: string; // e.g. "RTX 5090", informational only
  description?: string;
  provider?: ModelProvider; // "openai" (default) or "anthropic" — auto-detected from name if not set
}

export interface ModelsConfig {
  models: ModelEntry[];
  defaultModel?: string;
}

// ─── Paths ──────────────────────────────────────────────────────

let MODELS_PATH = kcodePath("models.json");

/** Override the models.json path (for tests). Passing undefined resets to default. */
export function _setModelsPathForTest(path?: string): void {
  MODELS_PATH = path ?? kcodePath("models.json");
  cachedConfig = null;
}

// ─── In-memory cache ────────────────────────────────────────────

let cachedConfig: ModelsConfig | null = null;

// ─── Load / Save ────────────────────────────────────────────────

export async function loadModelsConfig(): Promise<ModelsConfig> {
  if (cachedConfig) return cachedConfig;

  try {
    const file = Bun.file(MODELS_PATH);
    if (await file.exists()) {
      const raw = await file.json();
      cachedConfig = parseModelsConfig(raw);
      return cachedConfig;
    }
  } catch {
    // File doesn't exist or is invalid — return defaults
  }

  // No config file yet — return empty registry
  cachedConfig = { models: [], defaultModel: undefined };
  return cachedConfig;
}

export async function saveModelsConfig(config: ModelsConfig): Promise<void> {
  const { dirname } = await import("node:path");
  const dir = dirname(MODELS_PATH);
  await Bun.write(join(dir, ".gitkeep"), ""); // ensure dir exists
  await Bun.write(MODELS_PATH, JSON.stringify(config, null, 2) + "\n");
  cachedConfig = config;
}

/**
 * Invalidate the in-process models cache. Forces the next
 * loadModelsConfig() call to re-read from disk. Used by ModelToggle
 * and other UI surfaces that want to pick up discovery results
 * immediately instead of waiting for the next kcode restart.
 */
export function invalidateModelsCache(): void {
  cachedConfig = null;
}

/**
 * Normalize a stored baseUrl at load time. KCode's request builder
 * appends /v1/chat/completions to the baseUrl, so the stored value
 * MUST NOT already contain a trailing /v1. If it does (e.g., from an
 * older /cloud run that mis-entered the xAI base), strip it on load
 * so the request builder doesn't produce /v1/v1/chat/completions.
 *
 * This is a migration path: users who ran /cloud on KCode < 2.10.29
 * with xAI have "https://api.x.ai/v1" stored; on next startup this
 * silently normalizes to "https://api.x.ai".
 */
function normalizeBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  // Strip trailing /v1 ONLY for providers where the request builder
  // already appends /v1/... itself. Doing this across the board would
  // break providers that DO expect /v1 in the baseUrl (e.g., Gemini
  // which uses /v1beta/openai already in its documented base).
  const known = [
    "api.x.ai",
    "api.openai.com",
    "api.anthropic.com",
    "api.deepseek.com",
    "api.together.xyz",
    "api.groq.com",
  ];
  const lower = trimmed.toLowerCase();
  if (lower.endsWith("/v1") && known.some((host) => lower.includes(host))) {
    return trimmed.slice(0, -"/v1".length);
  }
  return trimmed;
}

function parseModelsConfig(raw: any): ModelsConfig {
  const models: ModelEntry[] = [];

  if (Array.isArray(raw?.models)) {
    for (const entry of raw.models) {
      if (typeof entry?.name === "string" && typeof entry?.baseUrl === "string") {
        models.push({
          name: entry.name,
          baseUrl: normalizeBaseUrl(entry.baseUrl),
          contextSize: typeof entry.contextSize === "number" ? entry.contextSize : undefined,
          capabilities: Array.isArray(entry.capabilities) ? entry.capabilities : undefined,
          gpu: typeof entry.gpu === "string" ? entry.gpu : undefined,
          description: typeof entry.description === "string" ? entry.description : undefined,
          provider:
            entry.provider === "anthropic"
              ? "anthropic"
              : entry.provider === "openai"
                ? "openai"
                : undefined,
        });
      }
    }
  }

  return {
    models,
    defaultModel: typeof raw?.defaultModel === "string" ? raw.defaultModel : undefined,
  };
}

// ─── Registry API ───────────────────────────────────────────────

/** Get the base URL for a model. Falls back to KCODE_API_BASE env var or http://localhost:10091. */
export async function getModelBaseUrl(modelName: string, configBase?: string): Promise<string> {
  // Registry entries always win — they have the correct baseUrl per model
  const config = await loadModelsConfig();
  const entry = config.models.find((m) => m.name === modelName);
  if (entry) {
    log.debug("config", `Model "${modelName}" resolved to ${entry.baseUrl}`);
    return entry.baseUrl;
  }

  // No registry entry: use configBase or fallback
  if (configBase) return configBase;

  const fallback = process.env.KCODE_API_BASE ?? "http://localhost:10091";
  log.debug("config", `Model "${modelName}" not in registry, using fallback ${fallback}`);
  return fallback;
}

/** Get the context window size for a model. Returns undefined if not configured. */
export async function getModelContextSize(modelName: string): Promise<number | undefined> {
  const config = await loadModelsConfig();
  const entry = config.models.find((m) => m.name === modelName);
  return entry?.contextSize;
}

/** Get the configured default model name, or "mnemo:code3" if none set. */
export async function getDefaultModel(): Promise<string> {
  const config = await loadModelsConfig();
  return config.defaultModel ?? "mnemo:code3";
}

/** Find a model entry by name. */
export async function findModel(modelName: string): Promise<ModelEntry | undefined> {
  const config = await loadModelsConfig();
  return config.models.find((m) => m.name === modelName);
}

/** List all registered models. */
export async function listModels(): Promise<ModelEntry[]> {
  const config = await loadModelsConfig();
  return config.models;
}

/** Add or update a model in the registry. */
export async function addModel(entry: ModelEntry): Promise<void> {
  const config = await loadModelsConfig();
  const existing = config.models.findIndex((m) => m.name === entry.name);
  if (existing >= 0) {
    config.models[existing] = entry;
  } else {
    config.models.push(entry);
  }
  log.debug(
    "config",
    `Model "${entry.name}" ${existing >= 0 ? "updated" : "added"} at ${entry.baseUrl}`,
  );
  await saveModelsConfig(config);
}

/** Remove a model from the registry by name. Returns true if found and removed. */
export async function removeModel(modelName: string): Promise<boolean> {
  const config = await loadModelsConfig();
  const idx = config.models.findIndex((m) => m.name === modelName);
  if (idx < 0) return false;
  config.models.splice(idx, 1);
  if (config.defaultModel === modelName) {
    config.defaultModel = undefined;
  }
  await saveModelsConfig(config);
  return true;
}

/** Set the default model. */
export async function setDefaultModel(modelName: string): Promise<void> {
  const config = await loadModelsConfig();
  config.defaultModel = modelName;
  await saveModelsConfig(config);
}

/** Detect the API provider for a model — checks registry first, then falls back to name heuristic. */
export async function getModelProvider(modelName: string): Promise<ModelProvider> {
  const config = await loadModelsConfig();
  const entry = config.models.find((m) => m.name === modelName);
  if (entry?.provider) return entry.provider;

  // Name-based detection
  const lower = modelName.toLowerCase();
  if (lower.startsWith("claude-") || lower.startsWith("claude_")) return "anthropic";

  return "openai";
}

/** Invalidate the in-memory cache (e.g., after external edits). */
export function invalidateCache(): void {
  cachedConfig = null;
}

/**
 * Enrich model entries with hardware-based recommendations.
 * Adds a `recommended` flag and optional `hardwareNotes` to models that match
 * the detected hardware profile's optimal configuration.
 */
export async function getRecommendedModels(): Promise<
  Array<ModelEntry & { recommended?: boolean; hardwareNotes?: string }>
> {
  const { HardwareDetector } = await import("./hardware/detector.js");
  const { HardwareOptimizer } = await import("./hardware/optimizer.js");

  const detector = new HardwareDetector();
  const optimizer = new HardwareOptimizer();
  const profile = await detector.detect();
  const recommendations = optimizer.recommend(profile);

  const config = await loadModelsConfig();
  const enriched = config.models.map((model) => {
    const rec = recommendations.find((r) => r.model === model.name);
    return {
      ...model,
      recommended: !!rec,
      hardwareNotes: rec?.reason,
    };
  });

  // Add recommended models that are not yet in the registry
  for (const rec of recommendations) {
    if (!enriched.find((m) => m.name === rec.model)) {
      enriched.push({
        name: rec.model,
        baseUrl: "http://localhost:10091",
        contextSize: rec.contextWindow,
        description: rec.reason,
        recommended: true,
        hardwareNotes: rec.reason,
      });
    }
  }

  return enriched;
}
