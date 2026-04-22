// KCode - Live balance fetching for providers that expose it via API

import { log } from "../logger";

export interface LiveBalance {
  available: number; // USD remaining
  currency: string;
  source: "api" | "manual"; // where the number came from
}

/**
 * Kimi/Moonshot — GET /v1/users/me returns remaining_balance in CNY.
 * We convert at a fixed rate (CNY → USD ≈ 0.138).
 * Returns null if the endpoint fails or key is missing.
 */
async function fetchKimiBalance(apiKey: string): Promise<LiveBalance | null> {
  try {
    const res = await fetch("https://api.moonshot.ai/v1/users/me", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    // Moonshot returns balance in CNY under data.balance or cash_balance
    const data = json.data as Record<string, unknown> | undefined;
    const cny =
      typeof data?.cash_balance === "number"
        ? data.cash_balance
        : typeof data?.balance === "number"
          ? data.balance
          : null;
    if (cny === null) return null;
    const usd = cny * 0.138; // CNY → USD (approximate)
    return { available: usd, currency: "USD (from CNY)", source: "api" };
  } catch (err) {
    log.debug("balance/live", `Kimi balance fetch failed: ${err}`);
    return null;
  }
}

/**
 * OpenRouter — already implemented separately in openrouter.ts.
 * Re-exported here for uniform interface.
 */
async function fetchOpenRouterBalance(apiKey: string): Promise<LiveBalance | null> {
  try {
    const { fetchOpenRouterBalance: fetch } = await import("./openrouter.js");
    const result = await fetch(apiKey);
    if (!result) return null;
    return { available: result.remaining ?? 0, currency: "USD", source: "api" };
  } catch {
    return null;
  }
}

/** Fetch live balance for a provider if its API supports it. */
export async function fetchLiveBalance(
  provider: string,
  apiKey: string,
): Promise<LiveBalance | null> {
  if (!apiKey) return null;
  switch (provider) {
    case "kimi":
      return fetchKimiBalance(apiKey);
    case "openrouter":
      return fetchOpenRouterBalance(apiKey);
    default:
      // xAI, Anthropic, OpenAI do not expose a public balance endpoint
      return null;
  }
}
