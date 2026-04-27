// KCode — Dynamic context-size discovery
//
// Asks the provider's own /v1/models endpoint for the advertised
// context window, so we stop hardcoding numbers that drift. Falls
// back to the static registry (model-context-sizes.ts) when the
// provider either doesn't expose the field (Anthropic, OpenAI,
// xAI, Groq, DeepSeek as of 2026-04) or when the discovery
// request fails for any reason.
//
// What each provider exposes at GET /v1/models/<id>:
//
//   Anthropic — `display_name`, `type`, `created_at`. NO context
//               field. Fall back to registry.
//   OpenAI   — `id`, `object`, `created`, `owned_by`. NO context
//               field. Fall back to registry.
//   xAI      — OpenAI-compatible shape. NO context field. Fall
//               back to registry. (Public docs mention Grok-4's
//               2M but the models endpoint doesn't surface it.)
//   Groq     — `id`, `object`, `created`, `owned_by`,
//               `active`, `context_window`, `max_completion_tokens`.
//               `context_window` is the key we want.
//   DeepSeek — OpenAI-compatible shape. NO context field.
//   Together — `id`, `object`, `type`, `running`, `context_length`.
//               `context_length` is the key.
//   Gemini   — `inputTokenLimit`, `outputTokenLimit` at
//               /v1beta/models/<id>. inputTokenLimit is our
//               context_size.
//
// Strategy: try the provider-specific endpoint with a short
// timeout (5s). If it returns a number, use it. Otherwise, fall
// through to the registry. Cached in-process so we don't hit
// the API more than once per model per process.

import { log } from "./logger";
import { guessContextSize } from "./model-context-sizes";

// In-process cache — keyed by model name. Persists for the session
// only; the setup wizard and migration-005 write the resolved
// value back to models.json so subsequent sessions get it from
// disk via getModelContextSize() without re-querying the API.
const _cache = new Map<string, number | null>();

/** Provider hint derived from the apiBase URL. */
function sniffProvider(apiBase: string): string {
  const b = apiBase.toLowerCase();
  if (b.includes("anthropic.com")) return "anthropic";
  if (b.includes("openai.com")) return "openai";
  if (b.includes("x.ai")) return "xai";
  if (b.includes("groq.com")) return "groq";
  if (b.includes("deepseek.com")) return "deepseek";
  if (b.includes("together.xyz")) return "together";
  if (b.includes("generativelanguage.googleapis.com")) return "gemini";
  return "unknown";
}

function trimBase(apiBase: string): string {
  return apiBase.replace(/\/+$/, "").replace(/\/v1(beta)?\/?$/, "");
}

/** Fetch wrapper with timeout + error swallowing. Never throws. */
async function tryFetch(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 5000,
): Promise<unknown | null> {
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (err) {
    log.debug("context-discovery", `GET ${url} failed: ${err}`);
    return null;
  }
}

interface DiscoveryInput {
  modelName: string;
  apiBase: string;
  apiKey?: string;
}

/**
 * Look up the real context window for a model by asking the
 * provider. Returns null when the provider doesn't expose it OR
 * the call fails. Callers should use this + guessContextSize()
 * together:
 *
 *    const size =
 *      (await discoverContextSize({...})) ?? guessContextSize(name);
 */
export async function discoverContextSize({
  modelName,
  apiBase,
  apiKey,
}: DiscoveryInput): Promise<number | null> {
  if (!modelName || !apiBase) return null;
  if (_cache.has(modelName)) return _cache.get(modelName) ?? null;

  const provider = sniffProvider(apiBase);
  const base = trimBase(apiBase);

  let size: number | null = null;

  try {
    if (provider === "groq") {
      // GET /openai/v1/models — returns data[].context_window
      const data = (await tryFetch(
        `${base}/openai/v1/models/${encodeURIComponent(modelName)}`,
        apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      )) as { context_window?: number } | null;
      if (typeof data?.context_window === "number") size = data.context_window;
    } else if (provider === "together") {
      // GET /v1/models — list endpoint, find by id, read context_length
      const data = (await tryFetch(
        `${base}/v1/models`,
        apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      )) as Array<{ id?: string; context_length?: number }> | null;
      if (Array.isArray(data)) {
        const entry = data.find((m) => m.id === modelName);
        if (typeof entry?.context_length === "number") size = entry.context_length;
      }
    } else if (provider === "gemini") {
      // GET /v1beta/models/<id>?key=... — returns inputTokenLimit
      const qs = apiKey ? `?key=${encodeURIComponent(apiKey)}` : "";
      const id = modelName.startsWith("models/") ? modelName : `models/${modelName}`;
      const data = (await tryFetch(`${base}/v1beta/${id}${qs}`, {})) as {
        inputTokenLimit?: number;
      } | null;
      if (typeof data?.inputTokenLimit === "number") size = data.inputTokenLimit;
    }
    // Anthropic / OpenAI / xAI / DeepSeek: context not exposed via
    // /v1/models. Skip discovery and let the caller fall back to
    // the static registry.
  } catch (err) {
    log.debug("context-discovery", `discovery error for ${modelName}: ${err}`);
  }

  _cache.set(modelName, size);
  return size;
}

/**
 * Convenience: one call that tries discovery first, then the
 * static registry. Returns `undefined` only if BOTH fail (model
 * unknown to us and not exposed by the API) — caller picks a
 * default.
 */
export async function resolveContextSize(input: DiscoveryInput): Promise<number | undefined> {
  const discovered = await discoverContextSize(input);
  if (discovered && discovered > 0) return discovered;
  return guessContextSize(input.modelName);
}

/** Test-only: reset the in-process cache. */
export function _clearContextDiscoveryCache(): void {
  _cache.clear();
}
