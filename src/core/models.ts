// KCode - Dynamic Model Registry
// Models are configured via ~/.kcode/models.json, not hardcoded.
// Each model entry maps a name to a base URL and optional metadata.

import { join } from "node:path";
import { log } from "./logger";
import { kcodePath } from "./paths";

// ─── Types ──────────────────────────────────────────────────────

export type ModelProvider =
  | "openai"
  | "anthropic"
  | "xai"
  | "google"
  | "deepseek"
  | "groq"
  | "openrouter"
  | "together"
  | "kimi";

export interface ModelEntry {
  name: string;
  baseUrl: string;
  contextSize?: number;
  capabilities?: string[]; // e.g. ["code", "vision", "general"]
  tags?: string[];         // benchmark-based tags: ["coding","fast","analysis","reasoning"]
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
          tags: Array.isArray(entry.tags) ? entry.tags : undefined,
          gpu: typeof entry.gpu === "string" ? entry.gpu : undefined,
          description: typeof entry.description === "string" ? entry.description : undefined,
          provider: (
            ["openai", "anthropic", "xai", "google", "deepseek", "groq", "openrouter", "together", "kimi"] as const
          ).includes(entry.provider)
            ? (entry.provider as ModelProvider)
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

// Known context windows for remote models that callers commonly use
// without registering them in ~/.kcode/models.json first (e.g. using
// `--model grok-4.20-0309-reasoning` on a fresh install). Without this
// fallback, config.ts lands on 32_000 and the Kodi context bar reads
// 100% after ~30k tokens for a 256k-window model.
//
// Sources: provider docs as of 2026-04. Entries are checked after the
// user's registry — explicit overrides always win.
const KNOWN_CONTEXT_SIZES: Record<string, number> = {
  // xAI Grok 4 family — 2M window (applies to both the fast variants
  // and the flagship). Grok 3 stays on 128k.
  "grok-4": 2_000_000,
  "grok-4-latest": 2_000_000,
  "grok-4-0709": 2_000_000,
  "grok-4.20": 2_000_000,
  "grok-4.20-reasoning": 2_000_000,
  "grok-4.20-0309-reasoning": 2_000_000,
  "grok-4.20-non-reasoning": 2_000_000,
  "grok-4.20-0309-non-reasoning": 2_000_000,
  "grok-4.20-multi-agent": 2_000_000,
  "grok-4.20-multi-agent-0309": 2_000_000,
  "grok-4-fast-reasoning": 2_000_000,
  "grok-4-fast-non-reasoning": 2_000_000,
  "grok-4-1-fast-reasoning": 2_000_000,
  "grok-4-1-fast-non-reasoning": 2_000_000,
  "grok-code-fast": 2_000_000,
  "grok-code-fast-1": 2_000_000,
  "grok-3": 131_072,
  "grok-3-mini": 131_072,
  // Anthropic 4.x — 1M with the `context-1m-2025-08-07` beta header.
  // KCode enables it for these models, so the display matches capacity.
  "claude-sonnet-4-6": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-haiku-4-5": 1_000_000,
  "claude-sonnet-4-5": 1_000_000,
  // OpenAI
  "gpt-4.1": 1_000_000,
  "gpt-4.1-mini": 1_000_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  o3: 200_000,
  "o4-mini": 200_000,
  // Google Gemini 2.5 — 1M input window on both pro and flash.
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  // DeepSeek
  "deepseek-chat": 128_000,
  "deepseek-reasoner": 128_000,
  // Kimi (Moonshot AI) — sizes from api.moonshot.ai/v1/models (context_window field)
  "kimi-k2.5": 262_144,
  "kimi-k2.6": 262_144,
  "kimi-k2": 128_000,
  "moonshot-v1-auto": 131_072,
  "moonshot-v1-128k": 131_072,
  "moonshot-v1-32k": 32_768,
  "moonshot-v1-8k": 8_192,
};

/**
 * Get the context window size for a model. Lookup order:
 *   1. User's ~/.kcode/models.json — explicit override.
 *   2. KNOWN_CONTEXT_SIZES — built-in table for common cloud models.
 *   3. Prefix match against the built-in table (e.g. unknown "grok-4-…"
 *      variant borrows from the closest "grok-4" family entry).
 * Returns undefined when nothing matches so callers can decide whether
 * to fall back to a default or hide the context bar.
 */
export async function getModelContextSize(modelName: string): Promise<number | undefined> {
  const config = await loadModelsConfig();
  const entry = config.models.find((m) => m.name === modelName);

  // KNOWN_CONTEXT_SIZES takes precedence over the registry when it has a LARGER
  // value. This auto-corrects stale registry entries that were saved before the
  // correct context window was known (e.g. grok-4 registered as 131K before
  // xAI announced the 2M window).
  const knownExact = KNOWN_CONTEXT_SIZES[modelName];
  if (entry?.contextSize) {
    const registrySize = entry.contextSize;
    return knownExact && knownExact > registrySize ? knownExact : registrySize;
  }

  if (knownExact) return knownExact;

  // Prefix fallback: a name like "grok-4.20-0309-mystery" should match
  // "grok-4.20-0309-reasoning" via shared prefix → "grok-4.20" etc.
  // Sort by length so the most specific key wins.
  const keys = Object.keys(KNOWN_CONTEXT_SIZES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (modelName.startsWith(key)) return KNOWN_CONTEXT_SIZES[key];
  }

  return undefined;
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

  // Name-based detection always wins for well-known prefixes.
  // This auto-corrects legacy registry entries where provider was stored as
  // "openai" for non-OpenAI models (models.json written before ModelProvider
  // was extended to include "xai", "google", "deepseek", etc.).
  const lower = modelName.toLowerCase();
  if (lower.startsWith("claude-") || lower.startsWith("claude_")) return "anthropic";
  if (lower.startsWith("grok-")) return "xai";
  if (lower.startsWith("gemini-") || lower.startsWith("gemini_")) return "google";
  if (lower.startsWith("deepseek-") || lower.startsWith("deepseek_")) return "deepseek";
  if (lower.startsWith("kimi-") || lower.startsWith("moonshot-")) return "kimi";

  // For names that don't match a known prefix, trust the registry entry.
  if (entry?.provider) return entry.provider;

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
