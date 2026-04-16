// KCode Pro — Feature gating for paid tier
// Free: all core coding tools, LLM conversation, slash commands, plans, memory
// Pro ($19/mo individual, $49/mo team): HTTP API, swarm, transcript search,
//      hooks (webhook+agent-spawn), browser, image-gen, distilled learning

import { createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadUserSettingsRaw } from "./config.js";
import { checkOfflineLicense, hasLicenseFeature } from "./license";
import { log } from "./logger";
import { kcodeHome, kcodePath } from "./paths";

const KCODE_HOME = kcodeHome();
const PRO_CACHE_FILE = kcodePath("pro-cache.json");
const PRO_CACHE_SALT_FILE = kcodePath(".pro-cache-salt");
const VALIDATE_URL = process.env.KCODE_PRO_VALIDATE_URL ?? "https://kulvex.ai/api/pro/validate";
const RECHECK_DAYS = 1;
const GRACE_PERIOD_HOURS = 24; // Max offline grace for non-server-validated cache
const MIN_VALIDATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between server calls
let _lastValidationAttempt = 0;

// ── Hardware fingerprint for cache binding ─────────────────────
function getHardwareFingerprint(): string {
  return `${homedir()}|${process.arch}|${process.platform}|${require("node:os").hostname()}`;
}

// ── Key checksum validation ────────────────────────────────────
// Keys use a simple checksum: last 2 chars of the payload must equal
// the first 2 hex chars of SHA-256(payload_without_checksum).
// This catches typos and naive brute-force attempts.
export function validateKeyChecksum(key: string): boolean {
  const prefix = key.startsWith("kcode_pro_")
    ? "kcode_pro_"
    : key.startsWith("klx_lic_")
      ? "klx_lic_"
      : key.startsWith("kcode_trial_")
        ? "kcode_trial_"
        : "";
  if (!prefix) return false;
  const payload = key.slice(prefix.length);
  if (payload.length < 20) return false;
  // Legacy keys without checksum: accept if payload is all hex (pre-checksum era)
  if (/^[0-9a-f]+$/i.test(payload)) return true;
  // Checksum keys: last 2 chars = first 2 hex of SHA-256(rest)
  const body = payload.slice(0, -2);
  const check = payload.slice(-2).toLowerCase();
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const expected = createHash("sha256").update(body).digest("hex").slice(0, 2);
  return check === expected;
}

// ── Trial key support ─────────────────────────────────────────
// Trial keys have format: kcode_trial_{random}_{expiryTimestamp}_{checksum}
// The expiry timestamp is a Unix epoch in seconds, embedded in the key payload.

/** Check if a key is a trial key (starts with kcode_trial_). */
export function isTrialKey(key: string): boolean {
  return typeof key === "string" && key.startsWith("kcode_trial_");
}

/** Parse the expiry timestamp from a trial key. Returns null if not a valid trial key. */
function parseTrialExpiry(key: string): number | null {
  if (!isTrialKey(key)) return null;
  const payload = key.slice("kcode_trial_".length);
  // Format: {random}_{expiryTimestamp}_{checksum}
  // The checksum is the last 2 chars, expiryTimestamp is the second-to-last segment
  const bodyWithoutChecksum = payload.slice(0, -2);
  const parts = bodyWithoutChecksum.split("_");
  if (parts.length < 2) return null;
  // Expiry is the last segment before checksum
  const expiryStr = parts[parts.length - 1];
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry <= 0) return null;
  return expiry;
}

/** Check if a trial key has expired. Returns true if the key is expired or invalid. */
export function isTrialExpired(key: string): boolean {
  const expiry = parseTrialExpiry(key);
  if (expiry === null) return true;
  return Date.now() / 1000 > expiry;
}

/** Get the number of days remaining on a trial key. Returns 0 if expired or invalid. */
export function getTrialDaysRemaining(key: string): number {
  const expiry = parseTrialExpiry(key);
  if (expiry === null) return 0;
  const remaining = expiry - Date.now() / 1000;
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / (60 * 60 * 24));
}

// HMAC key derived via PBKDF2 with a persistent random salt — NOT guessable from public info
function getOrCreateCacheSalt(): string {
  try {
    if (existsSync(PRO_CACHE_SALT_FILE)) {
      return readFileSync(PRO_CACHE_SALT_FILE, "utf-8").trim();
    }
  } catch (err) {
    log.debug("pro", `Failed to read cache salt file, regenerating: ${err}`);
  }
  const salt = randomBytes(32).toString("hex");
  try {
    mkdirSync(KCODE_HOME, { recursive: true });
    writeFileSync(PRO_CACHE_SALT_FILE, salt + "\n", { mode: 0o600 });
  } catch (err) {
    log.debug("pro", `Failed to write cache salt file: ${err}`);
  }
  return salt;
}

let _cacheHmacKey: Buffer | null = null;
function getCacheHmacKey(): Buffer {
  if (_cacheHmacKey) return _cacheHmacKey;
  const salt = getOrCreateCacheSalt();
  const material = `kcode_cache_${homedir()}_${process.arch}_${process.platform}`;
  _cacheHmacKey = pbkdf2Sync(material, salt, 100_000, 32, "sha256");
  return _cacheHmacKey;
}

export const PRO_FEATURES = {
  // Hard gates — fully blocked without Pro
  "http-server": "HTTP API server for IDE integrations",
  browser: "Browser automation (Playwright)",
  "hooks-webhook": "HTTP webhook hooks",
  "hooks-agent": "Agent-spawn hooks",
  distillation: "Distilled learning from past sessions",
  "smart-routing": "Auto-select best model per task type",
  "cloud-failover": "Multi-provider failover chain",
  deploy: "Deploy automation (Docker, Vercel, Fly, SSH)",
  // Soft gates — limited in free, unlimited in Pro
  swarm: "Multi-agent swarm (free: 1 sequential, Pro: up to 8 parallel)",
  "transcript-search": "Transcript search (free: 72h, Pro: full history)",
  "image-gen": "Image generation via cloud API (Flux, DALL-E)",
  "analytics-export": "Detailed analytics with cost tracking and export",
} as const;

// ── Soft gate limits ────────────────────────────────────────────
export const FREE_LIMITS = {
  maxSwarmAgents: 1,
  transcriptSearchHours: 168, // 7 days
  contextWindowCap: 64_000,
  sessionsPerMonth: 200,
} as const;

export type ProFeature = keyof typeof PRO_FEATURES;

// Serialized validation promise to prevent concurrent race conditions (#10)
let _validationPromise: Promise<boolean> | null = null;
let cachedProStatus: boolean | null = null;

/**
 * Check if the current installation has a valid Pro key.
 * Reads from ~/.kcode/settings.json → proKey field.
 * Format: "kcode_pro_" followed by 32+ hex chars (case-insensitive).
 */
export async function isPro(): Promise<boolean> {
  if (cachedProStatus !== null) return cachedProStatus;

  // Serialize concurrent calls (#10) — only one validation runs at a time
  if (_validationPromise) return _validationPromise;

  _validationPromise = _doValidation();
  try {
    const result = await _validationPromise;
    cachedProStatus = result;
    return result;
  } finally {
    _validationPromise = null;
  }
}

async function _doValidation(): Promise<boolean> {
  try {
    // ── Priority 0: Astrolexis OAuth subscription ─────────────────
    // The new canonical path: user ran /login in the TUI, we have
    // an OAuth access token for astrolexis.space, and the server
    // says their subscription is active. Cached for 1h to avoid
    // hammering the API. Falls through to the offline/key paths
    // below if no token is configured (e.g., air-gapped installs).
    try {
      const { hasProSubscription } = await import("./subscription.js");
      const active = await hasProSubscription();
      if (active) {
        log.debug("pro", "Activated via Astrolexis OAuth subscription");
        return true;
      }
    } catch (err) {
      // Subscription module unavailable or threw — silently fall
      // through. We don't want isPro() to throw under any condition.
      log.debug("pro", `subscription check skipped: ${err}`);
    }

    // ── Priority 1: Offline license file (JWT) ──────────────────
    // Check for a signed license file next — this never requires network.
    // Supports air-gapped/on-prem deployments with permanent offline Pro.
    const licenseResult = checkOfflineLicense();
    if (licenseResult.valid) {
      log.debug("pro", `Activated via offline license: ${licenseResult.claims!.sub}`);
      return true;
    }

    // ── Priority 2: Online key validation ───────────────────────
    const settings = await loadUserSettingsRaw();
    const key = (settings as Record<string, unknown>).proKey;
    // Accept kcode_pro_ keys, klx_lic_ keys (KULVEX licenses), and kcode_trial_ keys
    if (typeof key !== "string") return false;
    const isProKey = key.startsWith("kcode_pro_");
    const isKulvexKey = key.startsWith("klx_lic_");
    const isTrialKeyVal = isTrialKey(key);
    if (!isProKey && !isKulvexKey && !isTrialKeyVal) return false;

    // Validate key format: prefix + sufficient entropy
    const prefix = isProKey ? "kcode_pro_" : isKulvexKey ? "klx_lic_" : "kcode_trial_";
    const payload = key.slice(prefix.length);
    if (payload.length < 20) return false;

    // Validate key checksum (catches typos and naive brute-force)
    if (!validateKeyChecksum(key)) {
      log.debug("pro", "Key checksum validation failed");
      return false;
    }

    // Trial keys: validate locally (check expiry), no server call needed
    if (isTrialKeyVal) {
      if (isTrialExpired(key)) {
        log.debug("pro", "Trial key has expired");
        return false;
      }
      return true;
    }

    // Online validation with secure offline fallback
    return await validateProKey(key);
  } catch (err) {
    log.debug("pro", `Pro validation failed: ${err}`);
    return false;
  }
}

// ── Cache with HMAC integrity (#9) ──────────────────────────────

interface ProCache {
  key: string;
  validatedAt: string;
  valid: boolean;
  serverValidated: boolean; // true only if server confirmed at least once
  hwFingerprint?: string; // hardware fingerprint — invalidate if machine changes
  hmac: string; // HMAC of key+validatedAt+valid+hwFingerprint to detect tampering
}

function computeHmac(key: string, validatedAt: string, valid: boolean, hwFp?: string): string {
  const fp = hwFp ?? getHardwareFingerprint();
  return createHmac("sha256", getCacheHmacKey())
    .update(`${key}|${validatedAt}|${valid}|${fp}`)
    .digest("hex");
}

export function loadProCache(): ProCache | null {
  try {
    if (!existsSync(PRO_CACHE_FILE)) return null;

    // Verify file permissions — reject world-readable cache files
    const { statSync } = require("node:fs") as typeof import("node:fs");
    const stat = statSync(PRO_CACHE_FILE);
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      // File is readable by group/others — could be tampered. Reset permissions.
      const { chmodSync } = require("node:fs") as typeof import("node:fs");
      try {
        chmodSync(PRO_CACHE_FILE, 0o600);
      } catch (err) {
        log.debug("pro", `Failed to chmod pro-cache file: ${err}`);
      }
    }

    const raw = JSON.parse(readFileSync(PRO_CACHE_FILE, "utf-8"));
    if (!raw.key || !raw.validatedAt || typeof raw.valid !== "boolean") return null;

    // Verify hardware fingerprint — reject cache from different machines
    const currentFp = getHardwareFingerprint();
    if (raw.hwFingerprint && raw.hwFingerprint !== currentFp) return null;

    // Verify HMAC integrity (#9)
    const expectedHmac = computeHmac(
      raw.key,
      raw.validatedAt,
      raw.valid,
      raw.hwFingerprint ?? currentFp,
    );
    // Also accept legacy HMAC (without hwFingerprint) for migration
    const legacyHmac = createHmac("sha256", getCacheHmacKey())
      .update(`${raw.key}|${raw.validatedAt}|${raw.valid}`)
      .digest("hex");
    if (raw.hmac !== expectedHmac && raw.hmac !== legacyHmac) return null;

    // Enforce grace period: non-server-validated cache expires after GRACE_PERIOD_HOURS
    if (!raw.serverValidated && raw.valid) {
      const hoursSince = (Date.now() - new Date(raw.validatedAt).getTime()) / (1000 * 60 * 60);
      if (hoursSince > GRACE_PERIOD_HOURS) return null; // grace period expired
    }

    return raw as ProCache;
  } catch (err) {
    log.debug("pro", `Failed to load pro cache: ${err}`);
    return null;
  }
}

function saveProCache(
  key: string,
  validatedAt: string,
  valid: boolean,
  serverValidated: boolean,
): void {
  try {
    mkdirSync(KCODE_HOME, { recursive: true });
    const hwFingerprint = getHardwareFingerprint();
    const hmac = computeHmac(key, validatedAt, valid, hwFingerprint);
    const cache: ProCache = { key, validatedAt, valid, serverValidated, hwFingerprint, hmac };
    writeFileSync(PRO_CACHE_FILE, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    log.debug("pro", `Failed to save pro cache: ${err}`);
  }
}

// ── Validation logic (#1, #4) ───────────────────────────────────

async function validateProKey(key: string): Promise<boolean> {
  const cache = loadProCache();

  // If cache exists for this key and is recent, trust it
  if (cache && cache.key === key) {
    const daysSince = (Date.now() - new Date(cache.validatedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < RECHECK_DAYS) {
      return cache.valid;
    }
  }

  // Rate limit: prevent hammering the validation server
  const now = Date.now();
  if (now - _lastValidationAttempt < MIN_VALIDATION_INTERVAL_MS) {
    log.debug("pro", "Rate limited — using cached result or denying");
    if (cache && cache.key === key) return cache.valid;
    return false;
  }
  _lastValidationAttempt = now;

  // Phone home
  try {
    const resp = await fetch(VALIDATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(8000),
    });

    // Check HTTP status (#4 from pro.ts audit)
    if (!resp.ok) {
      // Server error (5xx) — don't cache, fall through to offline logic
      if (resp.status >= 500) throw new Error(`Server error: ${resp.status}`);
      // Client error (4xx) — key is definitively invalid
      saveProCache(key, new Date().toISOString(), false, true);
      return false;
    }

    const result = (await resp.json()) as { valid?: boolean };
    const valid = result.valid === true;

    saveProCache(key, new Date().toISOString(), valid, true);
    return valid;
  } catch (err) {
    log.debug("pro", `Pro key validation server unreachable: ${err}`);
    // Server unreachable — trust cache if it was previously server-validated
    if (cache && cache.key === key && cache.serverValidated) {
      return cache.valid;
    }
    // First-time offline: grant a grace period so users aren't locked out
    // when the validation server is unreachable. Cache as non-server-validated
    // so we'll re-check next time. This prevents deleting the user's proKey.
    saveProCache(key, new Date().toISOString(), true, false);
    return true;
  }
}

/**
 * Require Pro for a feature.
 * In interactive mode (TTY): shows feature info and prompts for key inline.
 * In non-interactive mode: throws with activation instructions.
 */
export async function requirePro(feature: ProFeature): Promise<void> {
  if (await isPro()) return;

  const description = PRO_FEATURES[feature];

  // Non-interactive (piped, CI, tools) — throw immediately
  if (!process.stdin.isTTY) {
    throw new Error(
      `⚡ KCode Pro required — ${description}\n` +
        `\n` +
        `  This feature requires KCode Pro ($19/mo).\n` +
        `  Activate: kcode pro activate <your-pro-key>\n` +
        `  License file: place a signed JWT at ~/.kcode/license.jwt (air-gap/on-prem)\n` +
        `  Get a key: https://kulvex.ai/pro\n`,
    );
  }

  // Interactive — show feature and prompt for key
  const C = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    cyan: "\x1b[36m",
    yellow: "\x1b[33m",
    green: "\x1b[32m",
    red: "\x1b[31m",
  };

  console.log();
  console.log(`  ${C.yellow}⚡ KCode Pro feature${C.reset}`);
  console.log(`  ${C.bold}${description}${C.reset}`);
  console.log();
  console.log(`  ${C.dim}This feature requires KCode Pro ($19/mo).${C.reset}`);
  console.log(`  ${C.dim}Get a key: ${C.cyan}https://kulvex.ai/pro${C.reset}`);
  console.log(`  ${C.dim}Air-gap: place a signed license at ~/.kcode/license.jwt${C.reset}`);
  console.log();

  // Prompt for key inline
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const answer = await new Promise<string>((resolve) => {
    rl.question(
      `  ${C.bold}Enter Pro key${C.reset} ${C.dim}(or press Enter to cancel):${C.reset} `,
      (ans) => {
        resolve(ans.trim());
      },
    );
  });
  rl.close();

  if (!answer) {
    throw new Error("Cancelled — Pro key required for this feature.");
  }

  // Validate key format before saving — reject non-key inputs like "quit", "exit", etc.
  if (
    !answer.startsWith("kcode_pro_") &&
    !answer.startsWith("klx_lic_") &&
    !answer.startsWith("kcode_trial_")
  ) {
    throw new Error(
      `${C.red}✗${C.reset} Invalid key format. Keys start with "kcode_pro_", "klx_lic_", or "kcode_trial_".\n` +
        `  Get a key: ${C.cyan}https://kulvex.ai/pro${C.reset}\n`,
    );
  }

  // Try to activate the key
  const { loadUserSettingsRaw, saveUserSettingsRaw } = await import("./config.js");
  const settings = await loadUserSettingsRaw();
  settings.proKey = answer;
  await saveUserSettingsRaw(settings);
  clearProCache();

  if (await isPro()) {
    console.log(`\n  ${C.green}✓${C.reset} KCode Pro activated! Continuing...\n`);
    return;
  }

  // Key didn't validate — only revert if the server explicitly rejected it
  // (not if validation failed due to network issues)
  const cache = loadProCache();
  const serverRejected = cache && cache.key === answer && cache.serverValidated && !cache.valid;
  if (serverRejected) {
    settings.proKey = undefined; // merge-safe deletion
    await saveUserSettingsRaw(settings);
  }
  clearProCache();
  throw new Error(
    `${C.red}✗${C.reset} Pro key could not be validated. Check that it's correct or try again later.\n` +
      `  Get a key: ${C.cyan}https://kulvex.ai/pro${C.reset}\n`,
  );
}

/** Clear cached status (e.g., after activating a new key). */
export function clearProCache(): void {
  cachedProStatus = null;
  _validationPromise = null;
}

// ── Soft gate helpers ───────────────────────────────────────────

/** Max swarm agents: 1 for free, MAX_AGENTS for Pro. */
export async function getMaxSwarmAgents(): Promise<number> {
  return (await isPro()) ? 8 : FREE_LIMITS.maxSwarmAgents;
}

/** Context window cap: 32K for free, unlimited for Pro. */
export async function getContextWindowCap(): Promise<number | null> {
  return (await isPro()) ? null : FREE_LIMITS.contextWindowCap;
}

/** Transcript search hours: 72h for free, null (unlimited) for Pro. */
export async function getTranscriptSearchHoursLimit(): Promise<number | null> {
  return (await isPro()) ? null : FREE_LIMITS.transcriptSearchHours;
}

/** Count sessions this month from transcript directory. */
export async function getSessionCountThisMonth(): Promise<number> {
  try {
    const transcriptDir = join(KCODE_HOME, "transcripts");
    const { readdirSync, statSync } = await import("node:fs");
    if (!existsSync(transcriptDir)) return 0;
    const files = readdirSync(transcriptDir);
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    let count = 0;
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const mtime = statSync(join(transcriptDir, f)).mtimeMs;
        if (mtime >= thirtyDaysAgo) count++;
      } catch (err) {
        log.debug("pro", `Failed to stat transcript file ${f}: ${err}`);
      }
    }
    return count;
  } catch (err) {
    log.debug("pro", `Failed to count sessions this month: ${err}`);
    return 0;
  }
}

/** Check if session limit reached (free: 200/month). Soft warnings at 80% and 95%. */
export async function checkSessionLimit(): Promise<void> {
  // Skip session limits during test runs
  if (typeof globalThis.Bun !== "undefined" && (globalThis as any).Bun?.jest) return;
  if (process.env.KCODE_SKIP_SESSION_LIMIT === "1") return;
  if (await isPro()) return;
  const count = await getSessionCountThisMonth();
  const limit = FREE_LIMITS.sessionsPerMonth;

  // Soft warning at 80%
  if (count >= Math.floor(limit * 0.8) && count < Math.floor(limit * 0.95)) {
    const remaining = limit - count;
    process.stderr.write(
      `\x1b[33m  ${remaining} sessions remaining this month (free tier: ${limit}/mo).\x1b[0m\n` +
        `\x1b[2m  Upgrade to Pro for unlimited: kcode pro checkout\x1b[0m\n\n`,
    );
    return;
  }

  // Stronger warning at 95%
  if (count >= Math.floor(limit * 0.95) && count < limit) {
    const remaining = limit - count;
    process.stderr.write(
      `\x1b[33;1m  Only ${remaining} sessions left this month!\x1b[0m\n` +
        `\x1b[2m  Upgrade to Pro ($19/mo) for unlimited sessions: kcode pro checkout\x1b[0m\n\n`,
    );
    return;
  }

  if (count < limit) return;

  const C = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    cyan: "\x1b[36m",
    yellow: "\x1b[33m",
    green: "\x1b[32m",
    red: "\x1b[31m",
  };

  if (!process.stdin.isTTY) {
    throw new Error(
      `⚡ Session limit reached — ${count}/${FREE_LIMITS.sessionsPerMonth} sessions this month.\n` +
        `\n` +
        `  Upgrade to KCode Pro for unlimited sessions.\n` +
        `  Activate: kcode pro activate <your-pro-key>\n` +
        `  Get a key: https://kulvex.ai/pro\n`,
    );
  }

  console.log();
  console.log(`  ${C.yellow}⚡ Session limit reached${C.reset}`);
  console.log(
    `  ${C.bold}${count}/${FREE_LIMITS.sessionsPerMonth} sessions used this month${C.reset}`,
  );
  console.log();
  console.log(`  ${C.dim}Upgrade to KCode Pro ($19/mo) for unlimited sessions.${C.reset}`);
  console.log(`  ${C.dim}Get a key: ${C.cyan}https://kulvex.ai/pro${C.reset}`);
  console.log();

  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      `  ${C.bold}Enter Pro key${C.reset} ${C.dim}(or press Enter to exit):${C.reset} `,
      (ans) => resolve(ans.trim()),
    );
  });
  rl.close();

  if (!answer) {
    throw new Error("Session limit reached — Pro key required to continue.");
  }

  // Validate key format before saving
  if (
    !answer.startsWith("kcode_pro_") &&
    !answer.startsWith("klx_lic_") &&
    !answer.startsWith("kcode_trial_")
  ) {
    throw new Error(
      'Invalid key format. Keys start with "kcode_pro_", "klx_lic_", or "kcode_trial_".',
    );
  }

  const { loadUserSettingsRaw, saveUserSettingsRaw } = await import("./config.js");
  const settings = await loadUserSettingsRaw();
  settings.proKey = answer;
  await saveUserSettingsRaw(settings);
  clearProCache();

  if (await isPro()) {
    console.log(`\n  ${C.green}✓${C.reset} Pro activated! Continuing...\n`);
    return;
  }

  // Only remove key if server explicitly rejected it (not network failure)
  const sessionCache = loadProCache();
  if (
    sessionCache &&
    sessionCache.key === answer &&
    sessionCache.serverValidated &&
    !sessionCache.valid
  ) {
    settings.proKey = undefined;
    await saveUserSettingsRaw(settings);
  }
  clearProCache();
  throw new Error("Pro key could not be validated. Try again or check your connection.");
}

/** Soft gate for swarm: show upgrade prompt when free user hits agent limit. */
export async function softRequireSwarm(requestedAgents: number): Promise<number> {
  const max = await getMaxSwarmAgents();
  if (requestedAgents <= max) return requestedAgents;

  if (!process.stdin.isTTY) {
    process.stderr.write(
      `\x1b[33m⚠ Free tier: swarm limited to ${max} agent. Upgrade to Pro for up to 8 parallel agents.\x1b[0m\n` +
        `  Get a key: \x1b[36mhttps://kulvex.ai/pro\x1b[0m\n`,
    );
    return max;
  }

  console.log();
  console.log(
    `  \x1b[33m⚠ Free tier: swarm limited to ${max} agent (you requested ${requestedAgents}).\x1b[0m`,
  );
  console.log(`  \x1b[2mUpgrade to Pro for up to 8 parallel agents.\x1b[0m`);
  console.log(`  \x1b[2mGet a key: \x1b[36mhttps://kulvex.ai/pro\x1b[0m`);
  console.log();

  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      `  \x1b[1mEnter Pro key\x1b[0m \x1b[2m(or press Enter to continue with ${max} agent):\x1b[0m `,
      (ans) => resolve(ans.trim()),
    );
  });
  rl.close();

  if (!answer) return max; // Continue with free limit

  // Validate key format before saving
  if (
    !answer.startsWith("kcode_pro_") &&
    !answer.startsWith("klx_lic_") &&
    !answer.startsWith("kcode_trial_")
  ) {
    console.log(
      `\n  \x1b[31m✗\x1b[0m Invalid key format. Keys start with "kcode_pro_", "klx_lic_", or "kcode_trial_".\n`,
    );
    return max;
  }

  // Try to activate
  const { loadUserSettingsRaw, saveUserSettingsRaw } = await import("./config.js");
  const settings = await loadUserSettingsRaw();
  settings.proKey = answer;
  await saveUserSettingsRaw(settings);
  clearProCache();

  if (await isPro()) {
    console.log(`\n  \x1b[32m✓\x1b[0m Pro activated! Using ${requestedAgents} agents.\n`);
    return requestedAgents;
  }

  delete settings.proKey;
  await saveUserSettingsRaw(settings);
  clearProCache();
  console.log(`\n  \x1b[31m✗\x1b[0m Key not valid. Continuing with ${max} agent.\n`);
  return max;
}
