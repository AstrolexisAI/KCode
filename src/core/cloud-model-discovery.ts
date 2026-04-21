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
  const json = await res.json() as { data?: unknown[] };
  const items = Array.isArray(json.data) ? json.data : [];
  return items
    .map((item) => {
      const m = item as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id : null;
      if (!id) return null;
      // Different providers use different field names for context window
      const ctx =
        typeof m.context_window === "number"
          ? m.context_window
          : typeof m.context_length === "number"
            ? m.context_length
            : typeof m.max_context_window === "number"
              ? m.max_context_window
              : undefined;
      return { id, contextWindow: ctx } satisfies DiscoveredModel;
    })
    .filter((m): m is DiscoveredModel => m !== null);
}

/**
 * Fetch the model list from Anthropic's API.
 * Uses x-api-key header and Anthropic's own /v1/models format.
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
  const json = await res.json() as { data?: unknown[] };
  const items = Array.isArray(json.data) ? json.data : [];
  return items
    .map((item) => {
      const m = item as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id : null;
      if (!id) return null;
      const ctx =
        typeof m.context_window === "number" ? m.context_window : undefined;
      return { id, contextWindow: ctx } satisfies DiscoveredModel;
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
