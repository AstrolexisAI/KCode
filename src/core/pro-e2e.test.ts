// KCode - Pro System E2E Tests
// End-to-end tests for Pro feature gating: free user blocking, valid key access,
// expired cache handling, HMAC rejection, and grace period expiry

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac, pbkdf2Sync } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { kcodePath } from "./paths";
import {
  clearProCache,
  FREE_LIMITS,
  loadProCache,
  PRO_FEATURES,
  validateKeyChecksum,
} from "./pro";

const PRO_CACHE_FILE = kcodePath("pro-cache.json");
const PRO_CACHE_SALT_FILE = kcodePath(".pro-cache-salt");

// ─── Backup/Restore Helpers ──────────────────────────────────────

const BACKUP_DIR = join(tmpdir(), `kcode-pro-e2e-${process.pid}-${Date.now()}`);
mkdirSync(BACKUP_DIR, { recursive: true });

function backupFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const dest = join(BACKUP_DIR, path.replace(/\//g, "__"));
  copyFileSync(path, dest);
  return dest;
}

function restoreFile(path: string, backup: string | null): void {
  if (backup === null) {
    try {
      unlinkSync(path);
    } catch {}
  } else {
    copyFileSync(backup, path);
  }
}

// ─── HMAC Helpers (mirror pro.ts internals) ──────────────────────

function getSaltFromFile(): string {
  if (existsSync(PRO_CACHE_SALT_FILE)) {
    return readFileSync(PRO_CACHE_SALT_FILE, "utf-8").trim();
  }
  const salt = "t".repeat(64);
  mkdirSync(join(PRO_CACHE_FILE, ".."), { recursive: true });
  writeFileSync(PRO_CACHE_SALT_FILE, salt + "\n", { mode: 0o600 });
  return salt;
}

function deriveHmacKey(salt: string): Buffer {
  const material = `kcode_cache_${homedir()}_${process.arch}_${process.platform}`;
  return pbkdf2Sync(material, salt, 100_000, 32, "sha256");
}

function computeHmac(key: string, validatedAt: string, valid: boolean, hmacKey: Buffer): string {
  return createHmac("sha256", hmacKey).update(`${key}|${validatedAt}|${valid}`).digest("hex");
}

function writeCacheFile(opts: {
  key: string;
  validatedAt: string;
  valid: boolean;
  serverValidated: boolean;
}): void {
  const salt = getSaltFromFile();
  const hmacKey = deriveHmacKey(salt);
  const hmac = computeHmac(opts.key, opts.validatedAt, opts.valid, hmacKey);
  writeFileSync(PRO_CACHE_FILE, JSON.stringify({ ...opts, hmac }, null, 2) + "\n", {
    mode: 0o600,
  });
}

function removeCacheFile(): void {
  try {
    unlinkSync(PRO_CACHE_FILE);
  } catch {}
}

function proKey(char = "a"): string {
  return "kcode_pro_" + char.repeat(30);
}

// ═════════════════════════════════════════════════════════════════
// E2E: Free user cannot access hard-gated features
// ═════════════════════════════════════════════════════════════════

describe("Pro E2E: free user feature gating", () => {
  test("hard-gated features are defined and listed", () => {
    const hardGated = [
      "http-server",
      "browser",
      "hooks-webhook",
      "hooks-agent",
      "distillation",
      "smart-routing",
      "cloud-failover",
      "deploy",
    ];

    for (const feature of hardGated) {
      expect(PRO_FEATURES).toHaveProperty(feature);
      expect(typeof PRO_FEATURES[feature as keyof typeof PRO_FEATURES]).toBe("string");
    }
  });

  test("free user has limited capabilities", () => {
    // Free limits should enforce restrictions
    expect(FREE_LIMITS.maxSwarmAgents).toBe(1);
    expect(FREE_LIMITS.transcriptSearchHours).toBe(168);
    expect(FREE_LIMITS.contextWindowCap).toBe(64_000);
    expect(FREE_LIMITS.sessionsPerMonth).toBe(200);
  });

  test("no cache file means no Pro access", () => {
    const cacheBackup = backupFile(PRO_CACHE_FILE);
    const saltBackup = backupFile(PRO_CACHE_SALT_FILE);
    try {
      removeCacheFile();
      clearProCache();
      expect(loadProCache()).toBeNull();
    } finally {
      restoreFile(PRO_CACHE_FILE, cacheBackup);
      restoreFile(PRO_CACHE_SALT_FILE, saltBackup);
      clearProCache();
    }
  });
});

// ═════════════════════════════════════════════════════════════════
// E2E: Valid Pro key with server validation grants access
// ═════════════════════════════════════════════════════════════════

describe("Pro E2E: valid key access", () => {
  let cacheBackup: string | null;
  let saltBackup: string | null;

  beforeEach(() => {
    cacheBackup = backupFile(PRO_CACHE_FILE);
    saltBackup = backupFile(PRO_CACHE_SALT_FILE);
    removeCacheFile();
    clearProCache();
  });

  afterEach(() => {
    restoreFile(PRO_CACHE_FILE, cacheBackup);
    restoreFile(PRO_CACHE_SALT_FILE, saltBackup);
    clearProCache();
  });

  test("server-validated cache with valid=true grants access", () => {
    const key = proKey("v");
    const validatedAt = new Date().toISOString();
    writeCacheFile({ key, validatedAt, valid: true, serverValidated: true });

    const cache = loadProCache();
    expect(cache).not.toBeNull();
    expect(cache!.key).toBe(key);
    expect(cache!.valid).toBe(true);
    expect(cache!.serverValidated).toBe(true);
  });

  test("recent cache is trusted without re-validation", () => {
    const key = proKey("r");
    const recentDate = new Date().toISOString();
    writeCacheFile({ key, validatedAt: recentDate, valid: true, serverValidated: true });

    // Load twice — both should return the cached result
    const first = loadProCache();
    const second = loadProCache();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.key).toBe(second!.key);
  });
});

// ═════════════════════════════════════════════════════════════════
// E2E: Expired cache denies access
// ═════════════════════════════════════════════════════════════════

describe("Pro E2E: expired cache", () => {
  let cacheBackup: string | null;
  let saltBackup: string | null;

  beforeEach(() => {
    cacheBackup = backupFile(PRO_CACHE_FILE);
    saltBackup = backupFile(PRO_CACHE_SALT_FILE);
    removeCacheFile();
    clearProCache();
  });

  afterEach(() => {
    restoreFile(PRO_CACHE_FILE, cacheBackup);
    restoreFile(PRO_CACHE_SALT_FILE, saltBackup);
    clearProCache();
  });

  test("non-server-validated cache older than 24h is rejected", () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeCacheFile({
      key: proKey("e"),
      validatedAt: oldDate,
      valid: true,
      serverValidated: false,
    });

    // Grace period expired — should return null
    expect(loadProCache()).toBeNull();
  });

  test("cache with valid=false is loaded but reports invalid", () => {
    writeCacheFile({
      key: proKey("f"),
      validatedAt: new Date().toISOString(),
      valid: false,
      serverValidated: true,
    });

    const cache = loadProCache();
    expect(cache).not.toBeNull();
    expect(cache!.valid).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════
// E2E: Cache with wrong HMAC is rejected
// ═════════════════════════════════════════════════════════════════

describe("Pro E2E: HMAC integrity", () => {
  let cacheBackup: string | null;
  let saltBackup: string | null;

  beforeEach(() => {
    cacheBackup = backupFile(PRO_CACHE_FILE);
    saltBackup = backupFile(PRO_CACHE_SALT_FILE);
    removeCacheFile();
    clearProCache();
  });

  afterEach(() => {
    restoreFile(PRO_CACHE_FILE, cacheBackup);
    restoreFile(PRO_CACHE_SALT_FILE, saltBackup);
    clearProCache();
  });

  test("corrupted HMAC causes cache rejection", () => {
    writeCacheFile({
      key: proKey("h"),
      validatedAt: new Date().toISOString(),
      valid: true,
      serverValidated: true,
    });

    // Corrupt the HMAC
    const raw = JSON.parse(readFileSync(PRO_CACHE_FILE, "utf-8"));
    raw.hmac = "deadbeefdeadbeef" + raw.hmac.slice(16);
    writeFileSync(PRO_CACHE_FILE, JSON.stringify(raw), { mode: 0o600 });

    expect(loadProCache()).toBeNull();
  });

  test("flipping valid field without updating HMAC causes rejection", () => {
    writeCacheFile({
      key: proKey("i"),
      validatedAt: new Date().toISOString(),
      valid: true,
      serverValidated: true,
    });

    // Flip valid from true to false without updating HMAC
    const raw = JSON.parse(readFileSync(PRO_CACHE_FILE, "utf-8"));
    raw.valid = false;
    writeFileSync(PRO_CACHE_FILE, JSON.stringify(raw), { mode: 0o600 });

    expect(loadProCache()).toBeNull();
  });

  test("swapping HMAC from another cache entry fails", () => {
    // Create first cache entry
    writeCacheFile({
      key: proKey("j"),
      validatedAt: new Date().toISOString(),
      valid: true,
      serverValidated: true,
    });
    const cache1 = JSON.parse(readFileSync(PRO_CACHE_FILE, "utf-8"));

    // Create second cache entry with different key
    writeCacheFile({
      key: proKey("k"),
      validatedAt: new Date().toISOString(),
      valid: false,
      serverValidated: true,
    });
    const cache2 = JSON.parse(readFileSync(PRO_CACHE_FILE, "utf-8"));

    // Swap HMAC from cache1 into cache2
    cache2.hmac = cache1.hmac;
    writeFileSync(PRO_CACHE_FILE, JSON.stringify(cache2), { mode: 0o600 });

    expect(loadProCache()).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════
// E2E: Grace period expires after 24h
// ═════════════════════════════════════════════════════════════════

describe("Pro E2E: grace period", () => {
  let cacheBackup: string | null;
  let saltBackup: string | null;

  beforeEach(() => {
    cacheBackup = backupFile(PRO_CACHE_FILE);
    saltBackup = backupFile(PRO_CACHE_SALT_FILE);
    removeCacheFile();
    clearProCache();
  });

  afterEach(() => {
    restoreFile(PRO_CACHE_FILE, cacheBackup);
    restoreFile(PRO_CACHE_SALT_FILE, saltBackup);
    clearProCache();
  });

  test("non-server-validated cache works within grace period (< 24h)", () => {
    writeCacheFile({
      key: proKey("g"),
      validatedAt: new Date().toISOString(),
      valid: true,
      serverValidated: false,
    });

    const cache = loadProCache();
    expect(cache).not.toBeNull();
    expect(cache!.valid).toBe(true);
  });

  test("non-server-validated cache rejected after grace period (> 24h)", () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeCacheFile({
      key: proKey("g"),
      validatedAt: oldDate,
      valid: true,
      serverValidated: false,
    });

    expect(loadProCache()).toBeNull();
  });

  test("server-validated cache persists beyond 24h grace period", () => {
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeCacheFile({
      key: proKey("g"),
      validatedAt: oldDate,
      valid: true,
      serverValidated: true,
    });

    const cache = loadProCache();
    expect(cache).not.toBeNull();
    expect(cache!.valid).toBe(true);
  });

  test("key checksum validation works for E2E flow", () => {
    // Valid legacy key (all hex)
    expect(validateKeyChecksum("kcode_pro_" + "a".repeat(30))).toBe(true);

    // Invalid key (wrong prefix)
    expect(validateKeyChecksum("invalid_" + "a".repeat(30))).toBe(false);

    // Key too short
    expect(validateKeyChecksum("kcode_pro_short")).toBe(false);
  });
});
