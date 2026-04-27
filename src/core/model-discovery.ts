// KCode — Model Discovery
//
// Queries cloud provider /v1/models endpoints and merges any newly-
// released models into ~/.kcode/models.json. Solves the "Opus 4.7
// just came out but kcode doesn't know about it" friction — the user
// no longer has to manually `kcode models add` when Anthropic/OpenAI/
// Groq/etc. ship a new model.
//
// Invoked via `kcode models discover` (manual) or at startup when
// KCODE_AUTO_DISCOVER_MODELS=1 is set (opt-in to avoid surprise API
// calls on every kcode launch).
//
// Providers supported today:
//   - Anthropic     (GET https://api.anthropic.com/v1/models)
//   - OpenAI        (GET https://api.openai.com/v1/models)
//   - Groq          (GET https://api.groq.com/openai/v1/models)
//   - DeepSeek      (GET https://api.deepseek.com/v1/models)
//   - Together AI   (GET https://api.together.xyz/v1/models)
//
// Not yet supported (different schema): Google Gemini. Added as a
// TODO — Gemini uses https://generativelanguage.googleapis.com with
// a ?key=KEY auth instead of bearer tokens.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { log } from "./logger";
import type { ModelEntry, ModelsConfig } from "./models";
import { loadModelsConfig, saveModelsConfig } from "./models";
import { kcodePath } from "./paths";

// ─── Provider adapters ──────────────────────────────────────────

export interface ProviderSpec {
  id: string;
  /** Human-readable name for logs/output. */
  label: string;
  /** Endpoint URL — usually {baseUrl}/v1/models. */
  endpoint: string;
  /**
   * Headers factory. Given the API key, returns the auth headers.
   * Split from endpoint because Anthropic uses x-api-key + version
   * while OpenAI-compat uses Authorization: Bearer.
   */
  headers: (apiKey: string) => Record<string, string>;
  /**
   * How to parse the response body into a list of model IDs.
   * Providers return slightly different shapes:
   *   OpenAI-compat: { data: [{ id: "gpt-4o", ... }, ...] }
   *   Anthropic:     { data: [{ id: "claude-opus-4-7", ... }, ...] } (same)
   */
  parse: (body: unknown) => string[];
  /** Internal provider type used when writing to models.json. */
  provider: "openai" | "anthropic";
  /** The baseUrl we store on the entry (/v1 stripped — models.ts appends). */
  baseUrl: string;
}

const ANTHROPIC: ProviderSpec = {
  id: "anthropic",
  label: "Anthropic",
  endpoint: "https://api.anthropic.com/v1/models",
  headers: (apiKey): Record<string, string> => {
    // OAuth access tokens (sk-ant-oat01-*) use Authorization: Bearer
    // + the oauth beta header. Real API keys (sk-ant-api03-*) use
    // x-api-key. Detecting by prefix matches what request-builder.ts
    // does for the /v1/messages endpoint.
    if (apiKey.startsWith("sk-ant-oat01-")) {
      return {
        authorization: `Bearer ${apiKey}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-app": "cli",
      };
    }
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
  },
  parse: parseDataIdArray,
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
};

const OPENAI: ProviderSpec = {
  id: "openai",
  label: "OpenAI",
  endpoint: "https://api.openai.com/v1/models",
  headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  parse: parseDataIdArray,
  provider: "openai",
  baseUrl: "https://api.openai.com",
};

const GROQ: ProviderSpec = {
  id: "groq",
  label: "Groq",
  endpoint: "https://api.groq.com/openai/v1/models",
  headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  parse: parseDataIdArray,
  provider: "openai",
  baseUrl: "https://api.groq.com/openai",
};

const DEEPSEEK: ProviderSpec = {
  id: "deepseek",
  label: "DeepSeek",
  endpoint: "https://api.deepseek.com/v1/models",
  headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  parse: parseDataIdArray,
  provider: "openai",
  baseUrl: "https://api.deepseek.com",
};

const TOGETHER: ProviderSpec = {
  id: "together",
  label: "Together AI",
  endpoint: "https://api.together.xyz/v1/models",
  headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  parse: parseDataIdArray,
  provider: "openai",
  baseUrl: "https://api.together.xyz",
};

export const ALL_PROVIDERS: ProviderSpec[] = [
  ANTHROPIC,
  OPENAI,
  GROQ,
  DEEPSEEK,
  TOGETHER,
];

/**
 * Parser for the common { data: [{ id: string }, ...] } shape used
 * by OpenAI-compatible APIs and Anthropic. Rejects entries without a
 * string id.
 */
function parseDataIdArray(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.data)) return [];
  const ids: string[] = [];
  for (const entry of b.data) {
    if (entry && typeof entry === "object") {
      const id = (entry as Record<string, unknown>).id;
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
  }
  return ids;
}

// ─── Context size heuristic ─────────────────────────────────────

/**
 * Guess the context window size from a model ID. Used when we
 * discover a model we've never seen before — we need SOME context
 * size to store in the registry, and the ID is the only signal we
 * have. Falls back to 128K as a safe default for modern models.
 *
 * Keep this conservative: if we guess too high, the model may 400
 * on requests that exceed its real context. Too low just means
 * kcode compacts earlier than necessary (no broken behavior).
 */
export function guessContextSize(modelId: string): number {
  const id = modelId.toLowerCase();

  // Anthropic Claude family — check 1M variant FIRST (more specific)
  if (/claude.*1m/.test(id)) return 1_000_000;
  if (/claude-(?:opus|sonnet|haiku)-[34]/.test(id)) return 200_000;
  if (/claude-3-(?:5|7)/.test(id)) return 200_000;
  if (/claude-(?:opus|sonnet|haiku)-4/.test(id)) return 200_000;

  // OpenAI
  if (/gpt-4-turbo/.test(id)) return 128_000;
  if (/gpt-4o/.test(id)) return 128_000;
  if (/gpt-4\.1/.test(id)) return 1_000_000;
  if (/gpt-4/.test(id)) return 8_192;
  if (/gpt-3\.5/.test(id)) return 16_385;
  if (/^o[13]/.test(id) || /^o1/.test(id) || /^o3/.test(id)) return 200_000;

  // Groq / Together common llama variants
  if (/llama-3\.[1-3]-70b/.test(id)) return 128_000;
  if (/llama-3\.[1-3]-8b/.test(id)) return 128_000;
  if (/llama-3-/.test(id)) return 8_192;
  if (/mixtral/.test(id)) return 32_768;
  if (/qwen-?2/.test(id)) return 128_000;

  // DeepSeek
  if (/deepseek-(?:r1|v3|coder)/.test(id)) return 128_000;

  // Default for unknown modern models
  return 128_000;
}

// ─── Discovery ──────────────────────────────────────────────────

export interface DiscoveryResult {
  provider: string;
  added: string[];
  skipped: string[];
  error?: string;
}

/** Fetch the model list from a single provider. Returns IDs or throws. */
export async function fetchProviderModels(
  spec: ProviderSpec,
  apiKey: string,
  opts?: { timeoutMs?: number },
): Promise<string[]> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(spec.endpoint, {
      method: "GET",
      headers: spec.headers(apiKey),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`${spec.label} /v1/models returned HTTP ${res.status}`);
    }
    const body = await res.json();
    const ids = spec.parse(body);
    log.debug("model-discovery", `${spec.label}: ${ids.length} models listed`);
    return ids;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Discover models from one provider and merge new ones into the
 * supplied config. Returns what changed so the caller can log it.
 *
 * Existing entries in the config are NEVER overwritten — if the user
 * manually tuned contextSize or description for an entry, we leave
 * it alone. We only ADD entries for IDs we've never seen.
 */
export async function discoverFromProvider(
  spec: ProviderSpec,
  apiKey: string,
  config: ModelsConfig,
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    provider: spec.id,
    added: [],
    skipped: [],
  };

  let ids: string[];
  try {
    ids = await fetchProviderModels(spec, apiKey);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }

  const existingNames = new Set(config.models.map((m) => m.name));
  for (const id of ids) {
    if (existingNames.has(id)) {
      result.skipped.push(id);
      continue;
    }
    const entry: ModelEntry = {
      name: id,
      baseUrl: spec.baseUrl,
      contextSize: guessContextSize(id),
      provider: spec.provider,
      description: `Auto-discovered from ${spec.label} on ${new Date().toISOString().slice(0, 10)}`,
    };
    config.models.push(entry);
    result.added.push(id);
  }

  return result;
}

/**
 * Figure out which credential to use for each provider, in priority:
 *   1. KCode OAuth session (keychain-stored access token)
 *   2. Standard env var API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...)
 *   3. KCODE_-prefixed env var fallback
 *
 * Returns a map of provider id → credential. Providers with no
 * credential at all are omitted. The credential may be either an
 * OAuth bearer token or an API key — the per-provider `headers`
 * function in ProviderSpec handles the distinction.
 */
export async function collectProviderKeys(): Promise<Map<string, string>> {
  const keys = new Map<string, string>();

  // Try OAuth sessions first. If the user ran `/auth` to log in to
  // Anthropic or OpenAI via browser, we have an access token in the
  // keychain and don't need an API key.
  try {
    const { getAuthSessionManager } = await import("./auth/session.js");
    const { resolveProviderConfig } = await import("./auth/oauth-flow.js");
    const manager = getAuthSessionManager();
    for (const oauthProvider of ["anthropic", "openai"]) {
      try {
        const cfg = resolveProviderConfig(oauthProvider);
        const token = await manager.getAccessToken(
          oauthProvider,
          cfg ?? undefined,
        );
        if (token) {
          keys.set(oauthProvider, token);
          log.debug("model-discovery", `using OAuth token for ${oauthProvider}`);
        }
      } catch {
        // Provider not configured for OAuth — fall through to env vars
      }
    }
  } catch {
    // Auth module not available — skip OAuth, use env vars only
  }

  const pick = (id: string, envs: string[]): void => {
    if (keys.has(id)) return; // OAuth already set it
    for (const env of envs) {
      const v = process.env[env];
      if (v && v.length > 0) {
        keys.set(id, v);
        return;
      }
    }
  };
  pick("anthropic", ["ANTHROPIC_API_KEY", "KCODE_ANTHROPIC_API_KEY"]);
  pick("openai", ["OPENAI_API_KEY", "KCODE_OPENAI_API_KEY"]);
  pick("groq", ["GROQ_API_KEY", "KCODE_GROQ_API_KEY"]);
  pick("deepseek", ["DEEPSEEK_API_KEY", "KCODE_DEEPSEEK_API_KEY"]);
  pick("together", ["TOGETHER_API_KEY", "TOGETHER_AI_API_KEY", "KCODE_TOGETHER_API_KEY"]);

  // Final fallback: keys stored in ~/.kcode/settings.json. The /cloud
  // command saves API keys here (anthropicApiKey, xaiApiKey, etc.)
  // instead of env vars, so users who configured via /cloud need this
  // fallback or discovery will wrongly report "no API key configured".
  try {
    const settingsPath = kcodePath("settings.json");
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw);
      const fallback = (id: string, field: string): void => {
        if (keys.has(id)) return;
        const v = settings[field];
        if (typeof v === "string" && v.length > 0) {
          keys.set(id, v);
          log.debug("model-discovery", `using settings.${field} for ${id}`);
        }
      };
      fallback("anthropic", "anthropicApiKey");
      fallback("openai", "openaiApiKey");
      fallback("groq", "groqApiKey");
      fallback("deepseek", "deepseekApiKey");
      fallback("together", "togetherApiKey");
    }
  } catch {
    // settings.json unreadable or malformed — skip, not fatal
  }

  return keys;
}

/**
 * Run discovery across every provider we have a key for. Loads the
 * current registry, appends new entries, saves atomically. Returns
 * the per-provider results for the caller to print.
 */
export async function runModelDiscovery(opts?: {
  providerFilter?: string[];
  apiKeys?: Map<string, string>;
}): Promise<DiscoveryResult[]> {
  const keys = opts?.apiKeys ?? (await collectProviderKeys());
  const config = await loadModelsConfig();
  const results: DiscoveryResult[] = [];
  let anyAdded = false;

  for (const spec of ALL_PROVIDERS) {
    if (opts?.providerFilter && !opts.providerFilter.includes(spec.id)) continue;
    const apiKey = keys.get(spec.id);
    if (!apiKey) {
      results.push({
        provider: spec.id,
        added: [],
        skipped: [],
        error: "no API key configured",
      });
      continue;
    }
    const r = await discoverFromProvider(spec, apiKey, config);
    if (r.added.length > 0) anyAdded = true;
    results.push(r);
  }

  if (anyAdded) {
    await saveModelsConfig(config);
    log.info(
      "model-discovery",
      `saved ${config.models.length} total models to registry`,
    );
  }

  return results;
}

// ─── Throttle state ─────────────────────────────────────────────
//
// Auto-discovery runs at TUI mount, but we don't want every single
// `kcode` invocation hammering 5 provider APIs every time. Record
// the last-run timestamp and skip if < MIN_INTERVAL_MS has passed.
//
// Storage: ~/.kcode/discovery-state.json — tiny JSON blob kept
// separate from models.json so discovery bookkeeping doesn't clutter
// the model registry shape.

const DISCOVERY_STATE_FILE = "discovery-state.json";
const DEFAULT_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface DiscoveryState {
  lastRunAt: number;
}

function readDiscoveryState(): DiscoveryState | null {
  try {
    const path = kcodePath(DISCOVERY_STATE_FILE);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.lastRunAt === "number") return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeDiscoveryState(state: DiscoveryState): void {
  try {
    writeFileSync(
      kcodePath(DISCOVERY_STATE_FILE),
      JSON.stringify(state, null, 2),
      "utf-8",
    );
  } catch {
    // Non-fatal: next run will just re-run discovery.
  }
}

/**
 * Shared handle to the currently-running auto-discovery, so UI
 * surfaces (like ModelToggle) can await it with a short timeout
 * before showing the model list — ensures newly-discovered models
 * appear on the same /model open that triggered discovery.
 *
 * Set by maybeAutoDiscover() on entry, cleared on resolve.
 */
let _inFlightDiscovery: Promise<string[]> | null = null;

/**
 * Returns the in-flight discovery promise if one is running, or null
 * if discovery isn't currently active. Callers can await the promise
 * with their own timeout.
 */
export function getInFlightDiscovery(): Promise<string[]> | null {
  return _inFlightDiscovery;
}

/** Reset module state for tests. Not for production use. */
export function _resetForTest(): void {
  _inFlightDiscovery = null;
}

/**
 * Auto-discovery hook for the TUI. Fires in the background at mount.
 * Skips the actual API calls if we ran discovery recently (default:
 * within the last 6 hours) so opening kcode 20 times in one session
 * doesn't make 100 API requests.
 *
 * Returns a promise that resolves with the list of newly-added model
 * IDs (empty array if throttled or nothing new). Never throws — any
 * failure is swallowed so the TUI can't be held up by network issues.
 */
export async function maybeAutoDiscover(opts?: {
  /** Override the minimum interval between runs. Used by tests. */
  minIntervalMs?: number;
  /** Force-run ignoring the throttle. */
  force?: boolean;
}): Promise<string[]> {
  const minInterval = opts?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

  // If a previous call is still in flight, return its promise so
  // concurrent callers don't kick off duplicate API requests.
  if (_inFlightDiscovery) return _inFlightDiscovery;

  const runPromise = (async (): Promise<string[]> => {
    try {
      if (!opts?.force) {
        const state = readDiscoveryState();
        if (state && Date.now() - state.lastRunAt < minInterval) {
          log.debug(
            "model-discovery",
            `skipped (last run ${Math.round((Date.now() - state.lastRunAt) / 60000)}m ago)`,
          );
          return [];
        }
      }
      const results = await runModelDiscovery();
      writeDiscoveryState({ lastRunAt: Date.now() });
      const added = results.flatMap((r) => r.added);
      if (added.length > 0) {
        log.info(
          "model-discovery",
          `auto-discovered ${added.length} new model(s): ${added.slice(0, 5).join(", ")}${added.length > 5 ? ", ..." : ""}`,
        );
        // Schedule background benchmarks for the new models — runs async,
        // doesn't block discovery, results appear as ✓ in /model over time.
        try {
          const { scheduleBackgroundBenchmark } = await import("./benchmark-driver.js");
          scheduleBackgroundBenchmark();
        } catch { /* benchmark module optional */ }
      }
      return added;
    } catch (err) {
      log.debug("model-discovery", `auto-discovery failed: ${err}`);
      return [];
    } finally {
      _inFlightDiscovery = null;
    }
  })();

  _inFlightDiscovery = runPromise;
  return runPromise;
}

