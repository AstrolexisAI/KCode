// KCode - Cloud Model Discovery
// Fetches the real model list from each cloud provider's API.
// No hardcoded model names — everything comes from the provider.

import { log } from "./logger";

export interface DiscoveredModel {
  id: string;
  contextWindow?: number;
}

/**
 * Fetch the model list from an OpenAI-compatible provider.
 * Calls GET {baseUrl}/v1/models with Bearer auth.
 */
async function fetchOpenAICompatibleModels(
  baseUrl: string,
  apiKey: string,
): Promise<DiscoveredModel[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { data?: unknown[] };
  const items = Array.isArray(json.data) ? json.data : [];
  return items
    .map((item) => {
      const m = item as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id : null;
      if (!id) return null;
      // Filter image/video/audio generation models — not useful for coding assistant
      if (NON_TEXT_PREFIXES.some((p) => id.toLowerCase().startsWith(p))) return null;
      // Different providers use different field names for context window
      const ctx =
        typeof m.context_window === "number"
          ? m.context_window
          : typeof m.context_length === "number"
            ? m.context_length
            : typeof m.max_context_window === "number"
              ? m.max_context_window
              : typeof m.max_input_tokens === "number"
                ? m.max_input_tokens
                : undefined;
      const result: DiscoveredModel = ctx !== undefined ? { id, contextWindow: ctx } : { id };
      return result;
    })
    .filter((m): m is DiscoveredModel => m !== null);
}

// Model ID prefixes to exclude — image/video/audio generation, legacy completions,
// and deprecated versions that clutter the /model list for a coding assistant.
const NON_TEXT_PREFIXES = [
  "dall-e",
  "whisper",
  "tts-",
  "text-embedding",
  "grok-imagine",
  // OpenAI legacy / non-chat
  "babbage",
  "davinci",
  "ada-",
  "curie",
  "text-davinci",
  "text-ada",
  "text-babbage",
  "text-curie",
  "code-davinci",
  "code-cushman",
  // Old GPT-3.5 variants (keep base gpt-3.5-turbo if needed but filter specific old versions)
  "gpt-3.5-turbo-instruct",
  "gpt-3.5-turbo-0301",
  "gpt-3.5-turbo-16k-0613",
  // Fine-tuned model prefixes
  "ft:",
  // OpenAI audio / realtime / image / video
  "gpt-4o-realtime",
  "gpt-4o-audio",
  "gpt-4o-mini-realtime",
  "gpt-4o-mini-audio",
  "gpt-4o-mini-tts",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "gpt-audio",
  "gpt-realtime",
  "gpt-image",
  "gpt-image-",
  "chatgpt-image",
  // Video generation
  "sora",
  // Moderation
  "omni-moderation",
  // Code interpreter specific variants (not useful as chat models)
  "gpt-5-codex",
  "gpt-5.1-codex",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.4-codex",
  "gpt-5-search-api",
  "gpt-5.1-search",
];

/**
 * Fetch the model list from Anthropic's API.
 * Anthropic uses x-api-key header and returns max_input_tokens (not context_window).
 */
async function fetchAnthropicModels(apiKey: string): Promise<DiscoveredModel[]> {
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { data?: unknown[] };
  const items = Array.isArray(json.data) ? json.data : [];
  return items
    .map((item) => {
      const m = item as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id : null;
      if (!id) return null;
      // Anthropic returns max_input_tokens, not context_window
      const ctx =
        typeof m.max_input_tokens === "number"
          ? m.max_input_tokens
          : typeof m.context_window === "number"
            ? m.context_window
            : undefined;
      const result: DiscoveredModel = ctx !== undefined ? { id, contextWindow: ctx } : { id };
      return result;
    })
    .filter((m): m is DiscoveredModel => m !== null);
}

/**
 * Fetch models from a cloud provider.
 * Returns an empty array (not an error) if the endpoint is unreachable —
 * callers should fall back to a manual registration path.
 */
export async function fetchProviderModels(
  providerId: string,
  baseUrl: string,
  apiKey: string,
): Promise<DiscoveredModel[]> {
  try {
    if (providerId === "anthropic") {
      return await fetchAnthropicModels(apiKey);
    }
    return await fetchOpenAICompatibleModels(baseUrl, apiKey);
  } catch (err) {
    log.warn(
      "cloud-discovery",
      `Could not fetch models from ${providerId} (${baseUrl}): ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
}
