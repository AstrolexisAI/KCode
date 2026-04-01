// KCode - Policy Limits
// Fetch and enforce organization-level policy restrictions (rate limiting, quotas, feature toggles).
// Supports fail-open (default) and fail-closed modes.

import { join } from "node:path";
import { log } from "../core/logger";
import { kcodeHome } from "../core/paths";
import type { PolicyLimitsCache, PolicyLimitsResponse, PolicyRestriction } from "./types";

// ─── Constants ──────────────────────────────────────────────────

const CACHE_PATH = () => join(kcodeHome(), "policy-limits.json");
const MAX_RETRY_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const NON_RETRYABLE_STATUS = new Set([400, 401, 403]);
const REQUEST_TIMEOUT_MS = 15_000;

/** Policies that fail-closed when no cache is available (compliance-critical) */
const CRITICAL_POLICIES = new Set(["allow_feedback"]);

// ─── State ──────────────────────────────────────────────────────

let _cache: PolicyLimitsCache | null = null;
let _fetching = false;

// ─── Helpers ────────────────────────────────────────────────────

function getSettingsUrl(): string | null {
  return process.env.KCODE_SETTINGS_URL ?? null;
}

function getFailMode(): "open" | "closed" {
  const mode = process.env.KCODE_POLICY_FAIL_MODE;
  if (mode === "closed") return "closed";
  return "open";
}

function retryDelay(attempt: number): number {
  const exponential = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(exponential * jitter);
}

// ─── Cache I/O ──────────────────────────────────────────────────

export async function loadPolicyCache(): Promise<PolicyLimitsCache | null> {
  if (_cache) return _cache;
  try {
    const file = Bun.file(CACHE_PATH());
    if (!(await file.exists())) return null;
    const raw = await file.json();
    if (raw && typeof raw === "object" && raw.response) {
      _cache = raw as PolicyLimitsCache;
      return _cache;
    }
  } catch (err) {
    log.debug("config", `Failed to load policy limits cache: ${err}`);
  }
  return null;
}

async function saveToCache(cache: PolicyLimitsCache): Promise<void> {
  _cache = cache;
  try {
    const path = CACHE_PATH();
    await Bun.write(path, JSON.stringify(cache, null, 2));
    try {
      const { chmodSync } = require("node:fs") as typeof import("node:fs");
      chmodSync(path, 0o600);
    } catch {
      /* best effort */
    }
  } catch (err) {
    log.debug("config", `Failed to save policy limits cache: ${err}`);
  }
}

// ─── Fetch ──────────────────────────────────────────────────────

export async function fetchPolicyLimits(): Promise<PolicyLimitsResponse | null> {
  const baseUrl = getSettingsUrl();
  if (!baseUrl) return null;

  if (_fetching) return _cache?.response ?? null;
  _fetching = true;

  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/policy-limits`;
    const cached = await loadPolicyCache();

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const headers: Record<string, string> = {
          "X-KCode-Version": process.env.KCODE_VERSION ?? "0.0.0",
          "X-KCode-OS": process.platform,
        };
        if (cached?.etag) headers["If-None-Match"] = cached.etag;

        const authToken = process.env.KCODE_AUTH_TOKEN ?? process.env.KCODE_API_KEY;
        if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        const resp = await fetch(url, { headers, signal: controller.signal });
        clearTimeout(timeout);

        // 304 - Not Modified
        if (resp.status === 304) {
          return cached?.response ?? null;
        }

        // 204 / 404 - No policies configured
        if (resp.status === 204 || resp.status === 404) {
          const emptyResponse: PolicyLimitsResponse = { restrictions: {} };
          await saveToCache({
            etag: "",
            response: emptyResponse,
            fetchedAt: new Date().toISOString(),
          });
          return emptyResponse;
        }

        // Non-retryable errors
        if (NON_RETRYABLE_STATUS.has(resp.status)) {
          log.warn("config", `Policy limits fetch failed with non-retryable status ${resp.status}`);
          return cached?.response ?? null;
        }

        // Other errors - retry
        if (!resp.ok) {
          lastError = new Error(`HTTP ${resp.status}`);
          if (attempt < MAX_RETRY_ATTEMPTS - 1) {
            await new Promise((r) => setTimeout(r, retryDelay(attempt)));
            continue;
          }
          break;
        }

        // 200 OK
        const body = (await resp.json()) as PolicyLimitsResponse;
        if (!body || typeof body !== "object" || !body.restrictions) {
          log.warn("config", "Policy limits response is invalid, ignoring");
          return cached?.response ?? null;
        }

        const checksum = new Bun.CryptoHasher("sha256");
        checksum.update(JSON.stringify(body.restrictions));
        const etag = `sha256:${checksum.digest("hex")}`;

        await saveToCache({
          etag,
          response: body,
          fetchedAt: new Date().toISOString(),
        });

        return body;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRY_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, retryDelay(attempt)));
        }
      }
    }

    if (lastError) {
      log.warn(
        "config",
        `Policy limits fetch failed after ${MAX_RETRY_ATTEMPTS} attempts: ${lastError.message}`,
      );
    }
    return cached?.response ?? null;
  } finally {
    _fetching = false;
  }
}

// ─── Runtime Checks ─────────────────────────────────────────────

/**
 * Check if a policy is allowed.
 * - If cache exists: check the restriction
 * - If no cache and fail-open (default): allow unless critical policy
 * - If no cache and fail-closed: deny
 * - Unknown policies default to allowed
 */
export async function isPolicyAllowed(policyName: string): Promise<boolean> {
  const cached = await loadPolicyCache();

  if (!cached) {
    // No cache available - apply fail mode
    const failMode = getFailMode();
    if (failMode === "closed") return false;
    // Fail-open: critical policies still fail-closed
    if (CRITICAL_POLICIES.has(policyName)) return false;
    return true;
  }

  const restriction = cached.response.restrictions[policyName];
  if (!restriction) return true; // Unknown policy = allowed

  return restriction.allowed;
}

/**
 * Get the numeric limit for a policy (e.g., max_sessions_per_day).
 * Returns undefined if no limit is set.
 */
export async function getPolicyLimit(policyName: string): Promise<number | undefined> {
  const cached = await loadPolicyCache();
  if (!cached) return undefined;

  const restriction = cached.response.restrictions[policyName];
  if (!restriction) return undefined;

  return restriction.limit;
}

/**
 * Clear the in-memory cache (for testing or hot-reload).
 */
export function clearPolicyCache(): void {
  _cache = null;
}
