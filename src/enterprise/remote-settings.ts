// KCode - Remote Managed Settings
// Fetch, cache, and poll organization-managed settings from a central server.
// Settings URL is configured via KCODE_SETTINGS_URL env var.

import { join } from "node:path";
import { kcodeHome } from "../core/paths";
import { log } from "../core/logger";
import type { RemoteSettingsResponse, RemoteSettingsCache } from "./types";
import type { Settings } from "../core/config";

// ─── Constants ──────────────────────────────────────────────────

const CACHE_PATH = () => join(kcodeHome(), "remote-settings.json");
const DEFAULT_POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_RETRY_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const NON_RETRYABLE_STATUS = new Set([400, 401, 403]);
const REQUEST_TIMEOUT_MS = 15_000;

// ─── State ──────────────────────────────────────────────────────

let _cache: RemoteSettingsCache | null = null;
let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _fetching = false;

// ─── Helpers ────────────────────────────────────────────────────

function getSettingsUrl(): string | null {
  return process.env.KCODE_SETTINGS_URL ?? null;
}

function getPollInterval(): number {
  const env = process.env.KCODE_SETTINGS_POLL_INTERVAL;
  if (env) {
    const ms = parseInt(env, 10);
    if (!isNaN(ms) && ms > 0) return ms;
  }
  return DEFAULT_POLL_INTERVAL_MS;
}

/**
 * Compute a deterministic SHA256 checksum of settings for ETag comparison.
 * Keys are sorted for deterministic output.
 */
export async function computeChecksum(settings: Record<string, unknown>): Promise<string> {
  const sorted = JSON.stringify(settings, Object.keys(settings).sort());
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(sorted);
  return hash.digest("hex");
}

function retryDelay(attempt: number): number {
  const exponential = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(exponential * jitter);
}

// ─── Cache I/O ──────────────────────────────────────────────────

export async function loadFromCache(): Promise<RemoteSettingsCache | null> {
  if (_cache) return _cache;
  try {
    const file = Bun.file(CACHE_PATH());
    if (!(await file.exists())) return null;
    const raw = await file.json();
    if (raw && typeof raw === "object" && raw.etag && raw.response) {
      _cache = raw as RemoteSettingsCache;
      return _cache;
    }
  } catch (err) {
    log.debug("config", `Failed to load remote settings cache: ${err}`);
  }
  return null;
}

async function saveToCache(cache: RemoteSettingsCache): Promise<void> {
  _cache = cache;
  try {
    const path = CACHE_PATH();
    await Bun.write(path, JSON.stringify(cache, null, 2));
    try {
      const { chmodSync } = require("node:fs") as typeof import("node:fs");
      chmodSync(path, 0o600);
    } catch { /* best effort */ }
  } catch (err) {
    log.debug("config", `Failed to save remote settings cache: ${err}`);
  }
}

// ─── Fetch ──────────────────────────────────────────────────────

export async function fetchSettings(): Promise<RemoteSettingsResponse | null> {
  const baseUrl = getSettingsUrl();
  if (!baseUrl) return null;

  if (_fetching) return _cache?.response ?? null;
  _fetching = true;

  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/settings`;

    // Compute ETag from cached settings
    let etag: string | undefined;
    const cached = await loadFromCache();
    if (cached?.response?.settings) {
      const checksum = await computeChecksum(cached.response.settings as unknown as Record<string, unknown>);
      etag = `sha256:${checksum}`;
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const headers: Record<string, string> = {
          "X-KCode-Version": process.env.KCODE_VERSION ?? "0.0.0",
          "X-KCode-OS": process.platform,
        };
        if (etag) headers["If-None-Match"] = etag;

        // Add auth if available
        const authToken = process.env.KCODE_AUTH_TOKEN ?? process.env.KCODE_API_KEY;
        if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        const resp = await fetch(url, {
          headers,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        // 304 - Not Modified
        if (resp.status === 304) {
          return cached?.response ?? null;
        }

        // 204 / 404 - No settings configured
        if (resp.status === 204 || resp.status === 404) {
          const emptyResponse: RemoteSettingsResponse = {
            version: new Date().toISOString(),
            checksum: "",
            settings: {},
          };
          await saveToCache({
            etag: "",
            response: emptyResponse,
            fetchedAt: new Date().toISOString(),
          });
          return emptyResponse;
        }

        // Non-retryable errors
        if (NON_RETRYABLE_STATUS.has(resp.status)) {
          log.warn("config", `Remote settings fetch failed with non-retryable status ${resp.status}`);
          return cached?.response ?? null;
        }

        // Other errors - retry
        if (!resp.ok) {
          lastError = new Error(`HTTP ${resp.status}`);
          if (attempt < MAX_RETRY_ATTEMPTS - 1) {
            await new Promise(r => setTimeout(r, retryDelay(attempt)));
            continue;
          }
          break;
        }

        // 200 OK - Parse and cache
        const body = await resp.json() as RemoteSettingsResponse;
        if (!body || typeof body !== "object" || !body.settings) {
          log.warn("config", "Remote settings response is invalid, ignoring");
          return cached?.response ?? null;
        }

        const newChecksum = await computeChecksum(body.settings as unknown as Record<string, unknown>);
        await saveToCache({
          etag: `sha256:${newChecksum}`,
          response: body,
          fetchedAt: new Date().toISOString(),
        });

        return body;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRY_ATTEMPTS - 1) {
          await new Promise(r => setTimeout(r, retryDelay(attempt)));
        }
      }
    }

    if (lastError) {
      log.warn("config", `Remote settings fetch failed after ${MAX_RETRY_ATTEMPTS} attempts: ${lastError.message}`);
    }
    return cached?.response ?? null;
  } finally {
    _fetching = false;
  }
}

// ─── Polling ────────────────────────────────────────────────────

export function startPolling(): void {
  if (_pollTimer) return;
  const interval = getPollInterval();
  _pollTimer = setInterval(() => {
    fetchSettings().catch(err => {
      log.warn("config", `Remote settings poll error: ${err}`);
    });
  }, interval);
  // Unref so polling doesn't prevent process exit
  if (_pollTimer && typeof _pollTimer === "object" && "unref" in _pollTimer) {
    (_pollTimer as { unref: () => void }).unref();
  }
}

export function stopPolling(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Get the current remote settings (from cache).
 * Returns partial Settings or empty object.
 */
export async function getRemoteSettings(): Promise<Partial<Settings>> {
  const cached = await loadFromCache();
  return cached?.response?.settings ?? {};
}

/**
 * Clear the in-memory cache (for testing or hot-reload).
 */
export function clearRemoteSettingsCache(): void {
  _cache = null;
}
