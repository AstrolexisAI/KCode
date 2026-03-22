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
  // Hard gates — fully blocked without Pro
  "http-server":       "HTTP API server for IDE integrations",
  "browser":           "Browser automation (Playwright)",
  "hooks-webhook":     "HTTP webhook hooks",
  "hooks-agent":       "Agent-spawn hooks",
  "distillation":      "Distilled learning from past sessions",
  "smart-routing":     "Auto-select best model per task type",
  "cloud-failover":    "Multi-provider failover chain",
  "deploy":            "Deploy automation (Docker, Vercel, Fly, SSH)",
  // Soft gates — limited in free, unlimited in Pro
  "swarm":             "Multi-agent swarm (free: 1 sequential, Pro: up to 8 parallel)",
  "transcript-search": "Transcript search (free: 72h, Pro: full history)",
  "image-gen":         "Image generation via cloud API (Flux, DALL-E)",
  "analytics-export":  "Detailed analytics with cost tracking and export",
} as const;

// ── Soft gate limits ────────────────────────────────────────────
export const FREE_LIMITS = {
  maxSwarmAgents: 1,
  transcriptSearchHours: 72,
  contextWindowCap: 32_000,
  sessionsPerMonth: 50,
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
      `  Get a key: https://kulvex.ai/pro\n`
    );
  }

  // Interactive — show feature and prompt for key
  const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", yellow: "\x1b[33m", green: "\x1b[32m", red: "\x1b[31m" };

  console.log();
  console.log(`  ${C.yellow}⚡ KCode Pro feature${C.reset}`);
  console.log(`  ${C.bold}${description}${C.reset}`);
  console.log();
  console.log(`  ${C.dim}This feature requires KCode Pro ($19/mo).${C.reset}`);
  console.log(`  ${C.dim}Get a key: ${C.cyan}https://kulvex.ai/pro${C.reset}`);
  console.log();

  // Prompt for key inline
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const answer = await new Promise<string>((resolve) => {
    rl.question(`  ${C.bold}Enter Pro key${C.reset} ${C.dim}(or press Enter to cancel):${C.reset} `, (ans) => {
      resolve(ans.trim());
    });
  });
  rl.close();

  if (!answer) {
    throw new Error("Cancelled — Pro key required for this feature.");
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

  // Key didn't validate — revert
  delete settings.proKey;
  await saveUserSettingsRaw(settings);
  clearProCache();
  throw new Error(
    `${C.red}✗${C.reset} Pro key not valid. Check that it's correct.\n` +
    `  Get a key: ${C.cyan}https://kulvex.ai/pro${C.reset}\n`
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
      } catch { /* skip */ }
    }
    return count;
  } catch { return 0; }
}

/** Check if session limit reached (free: 50/month). Uses requirePro for interactive prompt. */
export async function checkSessionLimit(): Promise<void> {
  if (await isPro()) return;
  const count = await getSessionCountThisMonth();
  if (count >= FREE_LIMITS.sessionsPerMonth) {
    // This will show the interactive Pro key prompt if in TTY
    await requirePro("swarm"); // reuse — the error message is overridden below
  }
}

/** Soft gate for swarm: show upgrade prompt when free user hits agent limit. */
export async function softRequireSwarm(requestedAgents: number): Promise<number> {
  const max = await getMaxSwarmAgents();
  if (requestedAgents <= max) return requestedAgents;

  if (!process.stdin.isTTY) {
    process.stderr.write(
      `\x1b[33m⚠ Free tier: swarm limited to ${max} agent. Upgrade to Pro for up to 8 parallel agents.\x1b[0m\n` +
      `  Get a key: \x1b[36mhttps://kulvex.ai/pro\x1b[0m\n`
    );
    return max;
  }

  console.log();
  console.log(`  \x1b[33m⚠ Free tier: swarm limited to ${max} agent (you requested ${requestedAgents}).\x1b[0m`);
  console.log(`  \x1b[2mUpgrade to Pro for up to 8 parallel agents.\x1b[0m`);
  console.log(`  \x1b[2mGet a key: \x1b[36mhttps://kulvex.ai/pro\x1b[0m`);
  console.log();

  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`  \x1b[1mEnter Pro key\x1b[0m \x1b[2m(or press Enter to continue with ${max} agent):\x1b[0m `, (ans) => resolve(ans.trim()));
  });
  rl.close();

  if (!answer) return max; // Continue with free limit

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
