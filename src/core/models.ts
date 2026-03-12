// KCode - Dynamic Model Registry
// Models are configured via ~/.kcode/models.json, not hardcoded.
// Each model entry maps a name to a base URL and optional metadata.

import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export interface ModelEntry {
  name: string;
  baseUrl: string;
  contextSize?: number;
  capabilities?: string[]; // e.g. ["code", "vision", "general"]
  gpu?: string; // e.g. "RTX 5090", informational only
  description?: string;
}

export interface ModelsConfig {
  models: ModelEntry[];
  defaultModel?: string;
}

// ─── Paths ──────────────────────────────────────────────────────

const MODELS_PATH = join(homedir(), ".kcode", "models.json");

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
  const dir = join(homedir(), ".kcode");
  await Bun.write(join(dir, ".gitkeep"), ""); // ensure dir exists
  await Bun.write(MODELS_PATH, JSON.stringify(config, null, 2) + "\n");
  cachedConfig = config;
}

function parseModelsConfig(raw: any): ModelsConfig {
  const models: ModelEntry[] = [];

  if (Array.isArray(raw?.models)) {
    for (const entry of raw.models) {
      if (typeof entry?.name === "string" && typeof entry?.baseUrl === "string") {
        models.push({
          name: entry.name,
          baseUrl: entry.baseUrl,
          contextSize: typeof entry.contextSize === "number" ? entry.contextSize : undefined,
          capabilities: Array.isArray(entry.capabilities) ? entry.capabilities : undefined,
          gpu: typeof entry.gpu === "string" ? entry.gpu : undefined,
          description: typeof entry.description === "string" ? entry.description : undefined,
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
  if (configBase) return configBase;

  const config = await loadModelsConfig();
  const entry = config.models.find((m) => m.name === modelName);
  if (entry) {
    log.debug("config", `Model "${modelName}" resolved to ${entry.baseUrl}`);
    return entry.baseUrl;
  }

  // Fallback: env var or default
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
  log.debug("config", `Model "${entry.name}" ${existing >= 0 ? "updated" : "added"} at ${entry.baseUrl}`);
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

/** Invalidate the in-memory cache (e.g., after external edits). */
export function invalidateCache(): void {
  cachedConfig = null;
}
