// KCode - Remote Feature Flags Client
// Fetches feature flags from a remote API for dynamic flag management.
// Supports gradual rollout, A/B testing, and env var overrides.
//
// Flow: Remote API → Local cache → Runtime evaluation
// Fallback: If remote is unreachable, uses local cache or defaults.

import { join } from "node:path";
import { log } from "../logger";
import { kcodeHome } from "../paths";

// ─── Types ──────────────────────────────────────────────────────

export interface RemoteFlag {
  key: string;
  enabled: boolean;
  /** Percentage of users who see this flag (0-100). null = all or none based on enabled. */
  rolloutPercent?: number | null;
  /** A/B test variant (null = not in test) */
  variant?: string | null;
  /** Last updated timestamp */
  updatedAt: string;
}

export interface RemoteFlagConfig {
  /** API endpoint for fetching flags */
  apiUrl: string;
  /** API key for authentication */
  apiKey?: string;
  /** How often to refresh flags (ms). Default: 5 minutes */
  refreshIntervalMs: number;
  /** Client ID for rollout bucketing */
  clientId: string;
  /** Request timeout (ms). Default: 5000 */
  timeoutMs: number;
}

interface FlagCache {
  flags: RemoteFlag[];
  fetchedAt: number;
  etag?: string;
}

const DEFAULT_CONFIG: RemoteFlagConfig = {
  apiUrl: "https://kulvex.ai/api/v1/flags",
  refreshIntervalMs: 5 * 60 * 1000,
  clientId: "",
  timeoutMs: 5000,
};

const CACHE_FILE = () => join(kcodeHome(), "flag-cache.json");

// ─── Remote Flag Client ────────────────────────────────────────

export class RemoteFlagClient {
  private config: RemoteFlagConfig;
  private cache: FlagCache | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private fetching = false;

  constructor(config?: Partial<RemoteFlagConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (!this.config.clientId) {
      // Generate a stable client ID from machine identity
      this.config.clientId = `${process.arch}-${process.platform}-${process.env.USER ?? "anon"}`;
    }
  }

  /** Initialize: load cache from disk, then fetch from remote */
  async init(): Promise<void> {
    this.loadCacheFromDisk();
    await this.refresh();
    this.startAutoRefresh();
  }

  /** Check if a flag is enabled */
  isEnabled(key: string): boolean {
    // Env var override: KCODE_FLAG_<KEY>=true/false
    const envKey = `KCODE_FLAG_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    const envVal = process.env[envKey];
    if (envVal !== undefined) {
      return envVal === "true" || envVal === "1";
    }

    const flag = this.getFlag(key);
    if (!flag) return false;
    if (!flag.enabled) return false;

    // Rollout check
    if (flag.rolloutPercent != null && flag.rolloutPercent < 100) {
      return this.isInRollout(key, flag.rolloutPercent);
    }

    return true;
  }

  /** Get the A/B test variant for a flag (null if not in test) */
  getVariant(key: string): string | null {
    const flag = this.getFlag(key);
    return flag?.variant ?? null;
  }

  /** Get a specific flag */
  getFlag(key: string): RemoteFlag | null {
    if (!this.cache) return null;
    return this.cache.flags.find((f) => f.key === key) ?? null;
  }

  /** Get all flags */
  getAllFlags(): RemoteFlag[] {
    return this.cache?.flags ?? [];
  }

  /** Force refresh from remote */
  async refresh(): Promise<boolean> {
    if (this.fetching) return false;
    this.fetching = true;

    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "X-Client-ID": this.config.clientId,
      };
      if (this.config.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }
      if (this.cache?.etag) {
        headers["If-None-Match"] = this.cache.etag;
      }

      const resp = await fetch(this.config.apiUrl, {
        headers,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      if (resp.status === 304) {
        // Not modified — cache is still valid
        return true;
      }

      if (!resp.ok) {
        log.debug("flags", `Remote flag fetch failed: ${resp.status}`);
        return false;
      }

      const data = (await resp.json()) as { flags: RemoteFlag[] };
      this.cache = {
        flags: data.flags,
        fetchedAt: Date.now(),
        etag: resp.headers.get("etag") ?? undefined,
      };

      this.saveCacheToDisk();
      log.info("flags", `Loaded ${data.flags.length} remote feature flags`);
      return true;
    } catch (err) {
      log.debug("flags", `Remote flag fetch error: ${err}`);
      return false;
    } finally {
      this.fetching = false;
    }
  }

  /** Stop auto-refresh */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // ─── Internal ────────────────────────────────────────────────

  private startAutoRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => this.refresh(), this.config.refreshIntervalMs);
  }

  /** Deterministic rollout bucket using simple hash */
  private isInRollout(key: string, percent: number): boolean {
    const input = `${this.config.clientId}:${key}`;
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
    }
    const bucket = Math.abs(hash) % 100;
    return bucket < percent;
  }

  private loadCacheFromDisk(): void {
    try {
      const path = CACHE_FILE();
      const file = Bun.file(path);
      // Sync check for existence to avoid async in constructor path
      const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
      if (existsSync(path)) {
        const data = JSON.parse(readFileSync(path, "utf-8")) as FlagCache;
        this.cache = data;
      }
    } catch {
      // Cache file doesn't exist or is corrupt — will fetch fresh
    }
  }

  private saveCacheToDisk(): void {
    try {
      const path = CACHE_FILE();
      const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
      const { dirname } = require("node:path") as typeof import("node:path");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(this.cache), { mode: 0o600 });
    } catch (err) {
      log.debug("flags", `Failed to save flag cache: ${err}`);
    }
  }
}

// ─── Singleton ─────────────────────────────────────────────────

let _client: RemoteFlagClient | null = null;

export function getRemoteFlagClient(config?: Partial<RemoteFlagConfig>): RemoteFlagClient {
  if (!_client) {
    _client = new RemoteFlagClient(config);
  }
  return _client;
}

export function _resetRemoteFlagClient(): void {
  _client?.stop();
  _client = null;
}
