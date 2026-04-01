// Prefetch — Parallel preloading of credentials and config during module evaluation.
// Spawns async operations early so they resolve by the time they're needed,
// following the pattern of launching work during imports (not waiting for it).

import { log } from "./logger";

/** Prefetched results, resolved lazily when accessed */
interface PrefetchResults {
  proStatus: Promise<boolean>;
  userSettings: Promise<Record<string, unknown>>;
  modelsConfig: Promise<{ models: Array<{ name: string; provider?: string; baseUrl?: string }> }>;
}

let _results: PrefetchResults | null = null;

/**
 * Start prefetching credentials and config in parallel.
 * Call this as early as possible (ideally right after imports).
 * Does NOT block — returns immediately. Access results via getPrefetched().
 */
export function startPrefetch(): void {
  if (_results) return; // already started

  _results = {
    proStatus: prefetchProStatus(),
    userSettings: prefetchUserSettings(),
    modelsConfig: prefetchModelsConfig(),
  };
}

/**
 * Get the prefetch results. Each field is a Promise that may already be resolved.
 * If prefetch wasn't started, starts it now (lazy init).
 */
export function getPrefetched(): PrefetchResults {
  if (!_results) startPrefetch();
  return _results!;
}

/** Get cached Pro status (non-blocking if prefetch was started early) */
export async function getPrefetchedProStatus(): Promise<boolean> {
  return getPrefetched().proStatus;
}

/** Get cached user settings (non-blocking if prefetch was started early) */
export async function getPrefetchedUserSettings(): Promise<Record<string, unknown>> {
  return getPrefetched().userSettings;
}

/** Get cached models config (non-blocking if prefetch was started early) */
export async function getPrefetchedModelsConfig(): Promise<{ models: Array<{ name: string; provider?: string; baseUrl?: string }> }> {
  return getPrefetched().modelsConfig;
}

// ── Internal prefetch operations ────────────────────────────────

async function prefetchProStatus(): Promise<boolean> {
  try {
    const { isPro } = await import("./pro");
    return await isPro();
  } catch (err) {
    log.debug("prefetch", `Pro status prefetch failed: ${err}`);
    return false;
  }
}

async function prefetchUserSettings(): Promise<Record<string, unknown>> {
  try {
    const { loadUserSettingsRaw } = await import("./config");
    return await loadUserSettingsRaw();
  } catch (err) {
    log.debug("prefetch", `User settings prefetch failed: ${err}`);
    return {};
  }
}

async function prefetchModelsConfig(): Promise<{ models: Array<{ name: string; provider?: string; baseUrl?: string }> }> {
  try {
    const { loadModelsConfig } = await import("./models");
    return await loadModelsConfig();
  } catch (err) {
    log.debug("prefetch", `Models config prefetch failed: ${err}`);
    return { models: [] };
  }
}

/** Reset for testing */
export function _resetPrefetch(): void {
  _results = null;
}
