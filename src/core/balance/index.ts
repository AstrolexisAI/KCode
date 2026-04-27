// Public balance API.
//
// The typical flow is:
//   1. User: `/balance set xai 150`        → setStarting("xai", 150)
//   2. Each remote turn: recordSpend(model, baseUrl, costUsd)
//   3. UI: getStatus(provider) for display
//
// Only `recordSpend` produces alerts — `setStarting` / `reset` intentionally
// do not, since the user is already watching when they run them.

import { log } from "../logger";
import { fetchOpenRouterBalance } from "./openrouter";
import { type BillingProvider, providerFromModel, providerLabel } from "./provider";
import { type BalanceState, getEntry, loadBalance, saveBalance } from "./store";

export type { BillingProvider } from "./provider";
export { KNOWN_PROVIDERS, providerLabel } from "./provider";

export interface ProviderStatus {
  provider: BillingProvider;
  label: string;
  starting: number | null;
  spent: number;
  /** starting - spent, or null when starting isn't set. */
  remaining: number | null;
  /** Fraction 0–1 remaining of starting, or null. */
  fractionRemaining: number | null;
  currency: string;
}

export interface ThresholdAlert {
  provider: BillingProvider;
  label: string;
  fraction: number;
  remaining: number;
  currency: string;
}

/** Load all known provider statuses. */
export async function getAllStatuses(): Promise<ProviderStatus[]> {
  const state = await loadBalance();
  const out: ProviderStatus[] = [];
  for (const [name, entry] of Object.entries(state.providers)) {
    if (!entry) continue;
    const provider = name as BillingProvider;
    const remaining = entry.starting != null ? Math.max(0, entry.starting - entry.spent) : null;
    const fractionRemaining =
      entry.starting != null && entry.starting > 0
        ? Math.max(0, remaining! / entry.starting)
        : null;
    out.push({
      provider,
      label: providerLabel(provider),
      starting: entry.starting,
      spent: entry.spent,
      remaining,
      fractionRemaining,
      currency: entry.currency,
    });
  }
  out.sort((a, b) => a.provider.localeCompare(b.provider));
  return out;
}

/** Status for a single provider, or null if nothing was ever recorded. */
export async function getStatus(provider: BillingProvider): Promise<ProviderStatus | null> {
  const all = await getAllStatuses();
  return all.find((s) => s.provider === provider) ?? null;
}

/** Status for the provider backing a given model. */
export async function getStatusForModel(
  model: string,
  baseUrl?: string,
): Promise<ProviderStatus | null> {
  const provider = providerFromModel(model, baseUrl);
  if (!provider) return null;
  return getStatus(provider);
}

/** Register a starting credit. Pass null (or 0 via `off`) to stop tracking. */
export async function setStarting(provider: BillingProvider, amount: number | null): Promise<void> {
  const state = await loadBalance();
  const entry = getEntry(state, provider);
  entry.starting = amount;
  // Reset the alert history when the ceiling changes so the next drop
  // through a threshold fires cleanly.
  delete state.lastAlertedPct[provider];
  await saveBalance(state);
}

/** Zero out the `spent` counter for a provider (e.g. after reloading credit). */
export async function resetSpent(provider: BillingProvider): Promise<void> {
  const state = await loadBalance();
  const entry = getEntry(state, provider);
  entry.spent = 0;
  delete state.lastAlertedPct[provider];
  await saveBalance(state);
}

/** Replace alert thresholds (descending fractions; e.g. [0.2, 0.05]). */
export async function setThresholds(fractions: number[]): Promise<void> {
  const state = await loadBalance();
  state.alertThresholds = [...fractions]
    .filter((f) => Number.isFinite(f) && f > 0 && f < 1)
    .sort((a, b) => b - a);
  await saveBalance(state);
}

/**
 * Record a turn's spend against the provider that backs `model`. Returns
 * a threshold alert if the remaining balance just crossed a configured
 * threshold for the first time.
 *
 * No-ops (returns null) when:
 *   - Model maps to no billing provider (local inference).
 *   - `costUsd` is 0 or negative.
 */
export async function recordSpend(
  model: string,
  baseUrl: string | undefined,
  costUsd: number,
): Promise<ThresholdAlert | null> {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return null;
  const provider = providerFromModel(model, baseUrl);
  if (!provider) return null;

  const state = await loadBalance();
  const entry = getEntry(state, provider);
  entry.spent += costUsd;

  const alert = computeAlert(state, provider);
  if (alert) {
    state.lastAlertedPct[provider] = alert.fraction;
  }
  await saveBalance(state);

  if (alert) {
    log.debug(
      "balance",
      `alert: ${provider} crossed ${Math.round(alert.fraction * 100)}% remaining ($${alert.remaining.toFixed(2)} left)`,
    );
  }
  return alert;
}

/**
 * Query a live balance when the provider supports it (currently only
 * OpenRouter). Returns null otherwise. Callers can use this to reconcile
 * local spend tracking with ground truth.
 */
export async function fetchLiveBalance(
  provider: BillingProvider,
  apiKey: string,
): Promise<{ spent: number; remaining: number | null } | null> {
  if (provider !== "openrouter") return null;
  const info = await fetchOpenRouterBalance(apiKey);
  if (!info) return null;
  return { spent: info.spent, remaining: info.remaining };
}

// ─── Internals ─────────────────────────────────────────────────────────

function computeAlert(state: BalanceState, provider: BillingProvider): ThresholdAlert | null {
  const entry = state.providers[provider];
  if (!entry || entry.starting == null || entry.starting <= 0) return null;
  const remaining = Math.max(0, entry.starting - entry.spent);
  const fraction = remaining / entry.starting;
  const lastFired = state.lastAlertedPct[provider] ?? Infinity;

  // Fire the LOWEST threshold we've just crossed — i.e. the largest
  // threshold >= current fraction that we haven't already fired.
  for (const t of state.alertThresholds) {
    if (fraction <= t && t < lastFired) {
      return {
        provider,
        label: providerLabel(provider),
        fraction: t,
        remaining,
        currency: entry.currency,
      };
    }
  }
  return null;
}
