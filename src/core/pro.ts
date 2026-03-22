// KCode Pro — Feature gating for paid tier
// Free: all core coding tools, LLM conversation, slash commands, plans, memory
// Pro ($19/mo individual, $49/mo team): HTTP API, swarm, transcript search,
//      hooks (webhook+agent-spawn), browser, image-gen, distilled learning

import { join } from "node:path";
import { homedir } from "node:os";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadUserSettingsRaw } from "./config.js";

const KCODE_HOME = join(homedir(), ".kcode");
const PRO_CACHE_FILE = join(KCODE_HOME, "pro-cache.json");
const VALIDATE_URL = process.env.KCODE_PRO_VALIDATE_URL ?? "https://kulvex.ai/api/pro/validate";
const RECHECK_DAYS = 7;

// HMAC secret derived from machine-specific data to prevent cache file tampering (#9)
const CACHE_HMAC_KEY = `kcode_cache_${homedir()}_${process.arch}_${process.platform}`;

export const PRO_FEATURES = {
  "http-server":       "HTTP API server for IDE integrations",
  "swarm":             "Multi-agent swarm orchestration",
  "transcript-search": "Full-text search across past transcripts",
  "hooks-webhook":     "HTTP webhook hooks",
  "hooks-agent":       "Agent-spawn hooks",
  "browser":           "Browser automation (Playwright)",
  "image-gen":         "Image generation (ComfyUI)",
  "distillation":      "Distilled learning from past sessions",
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
    const settings = await loadUserSettingsRaw();
    const key = (settings as Record<string, unknown>).proKey;
    if (typeof key !== "string" || !key.startsWith("kcode_pro_")) {
      return false;
    }

    // Validate key format: kcode_pro_ + 32+ hex chars, case-insensitive (#6)
    const payload = key.slice("kcode_pro_".length);
    if (payload.length < 32 || !/^[a-fA-F0-9]+$/i.test(payload)) {
      return false;
    }

    // Online validation with secure offline fallback
    return await validateProKey(key);
  } catch {
    return false;
  }
}

// ── Cache with HMAC integrity (#9) ──────────────────────────────

interface ProCache {
  key: string;
  validatedAt: string;
  valid: boolean;
  serverValidated: boolean; // true only if server confirmed at least once
  hmac: string;             // HMAC of key+validatedAt+valid to detect tampering
}

function computeHmac(key: string, validatedAt: string, valid: boolean): string {
  return createHmac("sha256", CACHE_HMAC_KEY)
    .update(`${key}|${validatedAt}|${valid}`)
    .digest("hex");
}

function loadProCache(): ProCache | null {
  try {
    if (!existsSync(PRO_CACHE_FILE)) return null;
    const raw = JSON.parse(readFileSync(PRO_CACHE_FILE, "utf-8"));
    if (!raw.key || !raw.validatedAt || typeof raw.valid !== "boolean") return null;

    // Verify HMAC integrity (#9)
    const expectedHmac = computeHmac(raw.key, raw.validatedAt, raw.valid);
    if (raw.hmac !== expectedHmac) return null; // tampered — ignore cache

    return raw as ProCache;
  } catch {
    return null;
  }
}

function saveProCache(key: string, validatedAt: string, valid: boolean, serverValidated: boolean): void {
  try {
    mkdirSync(KCODE_HOME, { recursive: true });
    const hmac = computeHmac(key, validatedAt, valid);
    const cache: ProCache = { key, validatedAt, valid, serverValidated, hmac };
    writeFileSync(PRO_CACHE_FILE, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
  } catch { /* best-effort */ }
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

    const result = await resp.json() as { valid?: boolean };
    const valid = result.valid === true;

    saveProCache(key, new Date().toISOString(), valid, true);
    return valid;
  } catch {
    // Server unreachable — ONLY trust cache if it was previously server-validated (#1)
    if (cache && cache.key === key && cache.serverValidated) {
      return cache.valid;
    }
    // First-time offline: DENY Pro — require at least one server validation (#1)
    return false;
  }
}

/**
 * Require Pro for a feature. Throws a user-friendly error if not Pro.
 */
export async function requirePro(feature: ProFeature): Promise<void> {
  if (await isPro()) return;

  const description = PRO_FEATURES[feature];
  throw new Error(
    `⚡ KCode Pro required — ${description}\n` +
    `\n` +
    `  This feature requires KCode Pro ($19/mo).\n` +
    `  Activate: kcode pro activate <your-pro-key>\n` +
    `  Get a key: https://kulvex.ai/pro\n`
  );
}

/** Clear cached status (e.g., after activating a new key). */
export function clearProCache(): void {
  cachedProStatus = null;
  _validationPromise = null;
}
