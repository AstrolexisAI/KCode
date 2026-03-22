// KCode Pro — Feature gating for paid tier
// Free: all core coding tools, LLM conversation, slash commands, plans, memory
// Pro ($19/mo individual, $49/mo team): HTTP API, swarm, transcript search,
//      hooks (webhook+agent-spawn), browser, image-gen, distilled learning

import { join } from "node:path";
import { homedir } from "node:os";
import { loadUserSettingsRaw } from "./config.js";

const KCODE_HOME = join(homedir(), ".kcode");
const PRO_CACHE_FILE = join(KCODE_HOME, "pro-cache.json");
const VALIDATE_URL = "https://kulvex.ai/api/pro/validate";
const RECHECK_DAYS = 7;

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

let cachedProStatus: boolean | null = null;

/**
 * Check if the current installation has a valid Pro key.
 * Reads from ~/.kcode/settings.json → proKey field.
 * Format: "kcode_pro_" followed by 32+ hex chars.
 */
export async function isPro(): Promise<boolean> {
  if (cachedProStatus !== null) return cachedProStatus;

  try {
    const settings = await loadUserSettingsRaw();
    const key = (settings as Record<string, unknown>).proKey;
    if (typeof key !== "string" || !key.startsWith("kcode_pro_")) {
      cachedProStatus = false;
      return false;
    }

    // Validate key format: kcode_pro_ + 32+ hex chars
    const payload = key.slice("kcode_pro_".length);
    if (payload.length < 32 || !/^[a-f0-9]+$/.test(payload)) {
      cachedProStatus = false;
      return false;
    }

    // Online validation with offline-first fallback
    const validated = await validateProKey(key);
    cachedProStatus = validated;
    return validated;
  } catch {
    cachedProStatus = false;
    return false;
  }
}

interface ProCache {
  key: string;
  validatedAt: string;
  valid: boolean;
}

function loadProCache(): ProCache | null {
  try {
    const file = Bun.file(PRO_CACHE_FILE);
    if (!file.size) return null;
    const raw = JSON.parse(require("node:fs").readFileSync(PRO_CACHE_FILE, "utf-8"));
    if (!raw.key || !raw.validatedAt) return null;
    return raw as ProCache;
  } catch {
    return null;
  }
}

function saveProCache(cache: ProCache): void {
  try {
    require("node:fs").mkdirSync(KCODE_HOME, { recursive: true });
    require("node:fs").writeFileSync(PRO_CACHE_FILE, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
  } catch { /* best-effort */ }
}

/**
 * Validate a Pro key — checks local cache first, then phones home.
 * Offline-first: if server is unreachable, trusts cached result or format check.
 */
async function validateProKey(key: string): Promise<boolean> {
  // Check cache — if recently validated with same key, trust it
  const cache = loadProCache();
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

    const result = await resp.json() as { valid?: boolean };
    const valid = result.valid === true;

    saveProCache({ key, validatedAt: new Date().toISOString(), valid });
    return valid;
  } catch {
    // Server unreachable — trust cache if exists, otherwise trust format
    if (cache && cache.key === key) return cache.valid;
    // First-time offline: trust format validation (already passed above)
    saveProCache({ key, validatedAt: new Date().toISOString(), valid: true });
    return true;
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
}
