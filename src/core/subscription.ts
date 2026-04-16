// KCode — Astrolexis Subscription Client
//
// Replaces the local JWT license file with a live OAuth-backed
// subscription check against astrolexis.space. End user runs
// `/login` inside the TUI once; after that, kcode knows the tier /
// features / seats by hitting GET /api/subscription with the stored
// access token. Revocation is instant (server-side subscription
// status changes propagate on the next check).
//
// Backend contract (what astrolexis.space must expose):
//
//   GET https://astrolexis.space/api/subscription
//   Authorization: Bearer <access_token>
//   →
//   {
//     "tier": "free" | "pro" | "team" | "enterprise",
//     "features": ["pro", "swarm", "audit", ...],
//     "seats": 5,
//     "status": "active" | "past_due" | "canceled" | "trialing",
//     "expiresAt": 1776600000,    // unix seconds; 0 for lifetime
//     "customer": { "email": "...", "orgName": "Acme" }
//   }
//
//   401 → token expired/revoked → caller should refresh or fall
//         back to free tier
//   403 → authenticated but no active subscription
//
// Cache: 1h in-memory to avoid hammering the API on every kcode
// invocation or internal isPro() call. Force-refresh with
// `invalidateSubscriptionCache()` after a /login.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger";
import { kcodePath } from "./paths";

// ─── Types ──────────────────────────────────────────────────────

export type SubscriptionTier = "free" | "pro" | "team" | "enterprise";
export type SubscriptionStatus =
  | "active"
  | "past_due"
  | "canceled"
  | "trialing"
  | "none";

export interface Subscription {
  tier: SubscriptionTier;
  features: string[];
  seats: number;
  status: SubscriptionStatus;
  /** Unix seconds. 0 means no expiry (lifetime). */
  expiresAt: number;
  customer?: {
    email?: string;
    orgName?: string;
  };
  /** Unix ms when we last synced from the server. */
  fetchedAt: number;
}

// ─── Constants ──────────────────────────────────────────────────

const SUBSCRIPTION_ENDPOINT =
  process.env.KCODE_SUBSCRIPTION_URL ??
  "https://astrolexis.space/api/subscription";

/** How long a fetched subscription is trusted before re-querying. */
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

/** Disk cache file for offline operation — allows isPro() to return
 * the last-known tier if the network is down or kcode is air-gapped. */
const CACHE_FILE = () => kcodePath("subscription-cache.json");

// ─── State ──────────────────────────────────────────────────────

let _memCache: Subscription | null = null;

// ─── Disk cache helpers ─────────────────────────────────────────

function readDiskCache(): Subscription | null {
  try {
    const path = CACHE_FILE();
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof raw.tier !== "string" || typeof raw.fetchedAt !== "number") return null;
    return raw as Subscription;
  } catch {
    return null;
  }
}

function writeDiskCache(sub: Subscription): void {
  try {
    const path = CACHE_FILE();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(sub, null, 2), "utf-8");
  } catch (err) {
    log.debug("subscription", `failed to write cache: ${err}`);
  }
}

// ─── Fetching ───────────────────────────────────────────────────

/**
 * Fetch subscription from astrolexis.space using the stored OAuth
 * access token. Throws on network failures or if no token is
 * available. 401 is translated into a free-tier Subscription object
 * (token expired/revoked; caller should try a refresh separately).
 */
async function fetchFromServer(): Promise<Subscription> {
  const { getAuthSessionManager } = await import("./auth/session.js");
  const { resolveProviderConfig } = await import("./auth/oauth-flow.js");
  const manager = getAuthSessionManager();
  const cfg = resolveProviderConfig("astrolexis");
  const token = await manager.getAccessToken("astrolexis", cfg ?? undefined);

  if (!token) {
    throw new Error("Not logged in to Astrolexis. Run /login in the TUI.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(SUBSCRIPTION_ENDPOINT, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      signal: controller.signal,
    });

    if (res.status === 401) {
      // Token expired/revoked. Return free-tier as a default; caller
      // can trigger a refresh if it wants.
      log.debug("subscription", "401 from API — token expired or revoked");
      return {
        tier: "free",
        features: [],
        seats: 0,
        status: "none",
        expiresAt: 0,
        fetchedAt: Date.now(),
      };
    }

    if (res.status === 403) {
      // Authenticated but no active subscription.
      return {
        tier: "free",
        features: [],
        seats: 0,
        status: "canceled",
        expiresAt: 0,
        fetchedAt: Date.now(),
      };
    }

    if (!res.ok) {
      throw new Error(`subscription API returned ${res.status}`);
    }

    const raw = await res.json();
    return {
      tier: (raw.tier as SubscriptionTier) ?? "free",
      features: Array.isArray(raw.features) ? raw.features : [],
      seats: typeof raw.seats === "number" ? raw.seats : 1,
      status: (raw.status as SubscriptionStatus) ?? "active",
      expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : 0,
      customer: raw.customer,
      fetchedAt: Date.now(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Get the current subscription, using cached data when possible.
 *
 * Cache priority:
 *   1. Memory cache (if within TTL)
 *   2. Disk cache (if within TTL)
 *   3. Live fetch from astrolexis.space
 *
 * If live fetch fails and a stale disk cache exists, return the stale
 * cache — this keeps kcode usable when the network is flaky. The
 * cache file stores fetchedAt so we can tell callers how old it is.
 */
export async function getSubscription(opts?: {
  forceRefresh?: boolean;
}): Promise<Subscription> {
  const now = Date.now();

  // Memory cache
  if (!opts?.forceRefresh && _memCache && now - _memCache.fetchedAt < CACHE_TTL_MS) {
    return _memCache;
  }

  // Disk cache
  if (!opts?.forceRefresh) {
    const disk = readDiskCache();
    if (disk && now - disk.fetchedAt < CACHE_TTL_MS) {
      _memCache = disk;
      return disk;
    }
  }

  // Live fetch
  try {
    const sub = await fetchFromServer();
    _memCache = sub;
    writeDiskCache(sub);
    return sub;
  } catch (err) {
    log.debug("subscription", `live fetch failed: ${err}`);
    // Fall back to stale disk cache if present — better to let a
    // paying user keep working offline than to hard-fail on network
    // glitches.
    const disk = readDiskCache();
    if (disk) {
      log.info(
        "subscription",
        `using stale disk cache (${Math.round((now - disk.fetchedAt) / 60000)}m old)`,
      );
      _memCache = disk;
      return disk;
    }
    // No cache either → free tier.
    return {
      tier: "free",
      features: [],
      seats: 0,
      status: "none",
      expiresAt: 0,
      fetchedAt: now,
    };
  }
}

/** Clear the in-memory cache. Called after /login or /logout. */
export function invalidateSubscriptionCache(): void {
  _memCache = null;
}

/**
 * Quick-check: is the current subscription pro or better? Used by
 * the existing isPro() path in src/core/pro.ts. Cached and non-
 * blocking-friendly.
 */
export async function hasProSubscription(): Promise<boolean> {
  const sub = await getSubscription();
  return (
    (sub.tier === "pro" || sub.tier === "team" || sub.tier === "enterprise") &&
    (sub.status === "active" || sub.status === "trialing")
  );
}

/** Human-readable summary for /license status in the TUI. */
export function formatSubscription(sub: Subscription): string {
  if (sub.tier === "free" || sub.status === "none") {
    return "Free tier — no active subscription. Run /login to activate.";
  }
  const lines: string[] = [];
  lines.push(`Tier: ${sub.tier}`);
  lines.push(`Status: ${sub.status}`);
  if (sub.seats > 0) lines.push(`Seats: ${sub.seats}`);
  if (sub.features.length > 0) lines.push(`Features: ${sub.features.join(", ")}`);
  if (sub.expiresAt > 0) {
    const days = Math.floor((sub.expiresAt - Math.floor(Date.now() / 1000)) / 86400);
    const when = new Date(sub.expiresAt * 1000).toISOString().slice(0, 10);
    lines.push(`Expires: ${when} (${days} days)`);
  } else {
    lines.push(`Expires: never (lifetime)`);
  }
  if (sub.customer?.email) lines.push(`Customer: ${sub.customer.email}`);
  if (sub.customer?.orgName) lines.push(`Org: ${sub.customer.orgName}`);
  return lines.join("\n  ");
}
