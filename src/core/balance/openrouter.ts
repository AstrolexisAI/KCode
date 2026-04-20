// OpenRouter is the only provider that exposes live balance with an API
// key. Use it when available — otherwise our local spend tracking is the
// only signal.

import { log } from "../logger";

interface AuthKeyResponse {
  data?: {
    label?: string;
    usage?: number;
    limit?: number | null;
    limit_remaining?: number | null;
    is_free_tier?: boolean;
  };
}

export interface OpenRouterBalance {
  /** Already consumed in USD. */
  spent: number;
  /** Remaining USD; null when the key has no hard limit. */
  remaining: number | null;
  /** Hard cap in USD, if any. */
  limit: number | null;
  isFreeTier: boolean;
}

/**
 * Query https://openrouter.ai/api/v1/auth/key for the current balance.
 * Returns null on any error (missing key, network, non-2xx, bad shape).
 */
export async function fetchOpenRouterBalance(
  apiKey: string,
  timeoutMs = 8_000,
): Promise<OpenRouterBalance | null> {
  if (!apiKey) return null;
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "KCode-Balance",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      log.debug("balance/openrouter", `HTTP ${resp.status}`);
      return null;
    }
    const body = (await resp.json()) as AuthKeyResponse;
    const data = body.data ?? {};
    return {
      spent: typeof data.usage === "number" ? data.usage : 0,
      remaining: typeof data.limit_remaining === "number" ? data.limit_remaining : null,
      limit: typeof data.limit === "number" ? data.limit : null,
      isFreeTier: data.is_free_tier === true,
    };
  } catch (err) {
    log.debug("balance/openrouter", `fetch failed: ${err}`);
    return null;
  }
}
