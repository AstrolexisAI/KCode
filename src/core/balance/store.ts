// Balance store — persisted per-provider credit tracking.
//
// Lives at ~/.kcode/balance.json. The file is updated atomically (write
// to .tmp, rename). Shape:
//
//   {
//     "providers": {
//       "xai":    { "starting": 150.00, "spent": 12.34, "currency": "USD" },
//       "openai": { "starting": null,   "spent": 0.50,  "currency": "USD" }
//     },
//     "alertThresholds": [0.20, 0.05],   // 20% + 5% remaining
//     "lastAlertedPct": { "xai": 0.20 }  // highest threshold already fired
//   }
//
// `starting` = null means "track spend only, don't compute remaining"
// (useful when the user hasn't told us how much they loaded).

import { log } from "../logger";
import { kcodePath } from "../paths";
import type { BillingProvider } from "./provider";

export interface ProviderEntry {
  /** Starting credit the user registered. null = not configured. */
  starting: number | null;
  /** Cumulative USD spent since the last reset. */
  spent: number;
  /** Currency label — USD by default; informational only. */
  currency: string;
}

export interface BalanceState {
  providers: Partial<Record<BillingProvider, ProviderEntry>>;
  /** Descending thresholds as fractions of `starting` (0.20 = 20% remaining). */
  alertThresholds: number[];
  /** Last threshold that fired per provider — prevents duplicate alerts. */
  lastAlertedPct: Partial<Record<BillingProvider, number>>;
}

const DEFAULT_THRESHOLDS = [0.2, 0.05] as const;

function defaultState(): BalanceState {
  return {
    providers: {},
    alertThresholds: [...DEFAULT_THRESHOLDS],
    lastAlertedPct: {},
  };
}

function balanceFile(): string {
  return kcodePath("balance.json");
}

export async function loadBalance(): Promise<BalanceState> {
  try {
    const file = Bun.file(balanceFile());
    if (!(await file.exists())) return defaultState();
    const raw = (await file.json()) as Partial<BalanceState>;
    const merged = defaultState();
    if (raw.providers && typeof raw.providers === "object") {
      merged.providers = raw.providers;
    }
    if (Array.isArray(raw.alertThresholds) && raw.alertThresholds.length > 0) {
      merged.alertThresholds = [...raw.alertThresholds].sort((a, b) => b - a);
    }
    if (raw.lastAlertedPct && typeof raw.lastAlertedPct === "object") {
      merged.lastAlertedPct = raw.lastAlertedPct;
    }
    return merged;
  } catch (err) {
    log.debug("balance", `load failed: ${err}`);
    return defaultState();
  }
}

export async function saveBalance(state: BalanceState): Promise<void> {
  const file = balanceFile();
  const tmp = file + ".tmp";
  try {
    await Bun.write(tmp, JSON.stringify(state, null, 2));
    // Bun doesn't expose fs.rename directly through Bun.write, use node:fs.
    const { renameSync } = await import("node:fs");
    renameSync(tmp, file);
  } catch (err) {
    log.debug("balance", `save failed: ${err}`);
  }
}

/** Read the provider entry, creating a default one if missing. */
export function getEntry(state: BalanceState, provider: BillingProvider): ProviderEntry {
  const existing = state.providers[provider];
  if (existing) return existing;
  const fresh: ProviderEntry = { starting: null, spent: 0, currency: "USD" };
  state.providers[provider] = fresh;
  return fresh;
}
