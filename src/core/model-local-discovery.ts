// KCode - Local Model Runtime Discovery
// Queries the llama.cpp server /props endpoint to read the actual GGUF
// file path currently loaded and derive a canonical label from it. The
// `--alias` flag that whoever launched llama-server passed is whatever
// it is — an alias can be stale (e.g. a "mark6-31b" alias left over
// after the GGUF was swapped to Qwen3.6). The GGUF basename is the
// only source of truth that updates automatically when the file changes.
//
// Used by the /model switcher UI so the list shows the real model
// currently serving, not a frozen string from models.json.

import { log } from "./logger";
import { lookupMarkByGgufBasename } from "./mark-registry";

interface LlamaServerProps {
  model_path?: string;
  model_alias?: string;
  // other fields exist but we only need model_path
}

interface CacheEntry {
  label: string | null;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000; // one minute
const FETCH_TIMEOUT_MS = 1500;

const cache = new Map<string, CacheEntry>();

/**
 * Derive a human label from a GGUF file path. Returns the basename
 * minus the trailing `.gguf`. Preserves the original casing and any
 * quantization / variant suffixes (e.g. `-Q4_K_M`), since those are
 * user-meaningful.
 */
export function deriveGgufLabel(modelPath: string): string {
  const slash = Math.max(modelPath.lastIndexOf("/"), modelPath.lastIndexOf("\\"));
  const base = slash >= 0 ? modelPath.slice(slash + 1) : modelPath;
  return base.replace(/\.gguf$/i, "");
}

/**
 * Fetch the currently-loaded GGUF basename from a llama.cpp server.
 * Returns null if:
 *   - the endpoint doesn't respond within FETCH_TIMEOUT_MS
 *   - the response isn't JSON or doesn't contain `model_path`
 *   - any other error (network, CORS, non-llama.cpp server)
 *
 * Results are cached per-baseUrl for CACHE_TTL_MS so repeated
 * /model opens don't hammer the server.
 */
export async function getLocalModelLabel(baseUrl: string): Promise<string | null> {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const cached = cache.get(trimmed);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.label;
  }

  let label: string | null = null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${trimmed}/props`, { signal: controller.signal });
      if (res.ok) {
        const json = (await res.json()) as LlamaServerProps;
        if (typeof json.model_path === "string" && json.model_path.length > 0) {
          const basename = deriveGgufLabel(json.model_path);
          // Prefer the canonical mark ("mark7") when the basename
          // matches a registered family, so users see a stable short
          // label across quant/variant swaps. Fall through to the raw
          // basename for unregistered families — better than nothing.
          label = lookupMarkByGgufBasename(basename) ?? basename;
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    log.debug("model-discovery", `local label fetch failed for ${trimmed}: ${err}`);
  }

  cache.set(trimmed, { label, expiresAt: now + CACHE_TTL_MS });
  return label;
}

/** Clear the in-memory cache. Used by tests. */
export function _clearLocalModelCache(): void {
  cache.clear();
}
