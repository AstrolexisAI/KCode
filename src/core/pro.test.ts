// Tests for pro.ts — Pro feature gating
//
// Tests loadProCache + HMAC integrity by backup/restore of cache files.
// Mock-free: does not use mock.module() to avoid contaminating other test files.

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
// ── Resolve the REAL paths pro.ts uses ──────────────────────────
import { kcodePath } from "./paths";
import { clearProCache, FREE_LIMITS, loadProCache, PRO_FEATURES, validateKeyChecksum } from "./pro.ts";

const PRO_CACHE_FILE = kcodePath("pro-cache.json");
const PRO_CACHE_SALT_FILE = kcodePath(".pro-cache-salt");

// ── Backup/restore helpers ──────────────────────────────────────
const BACKUP_DIR = join(tmpdir(), `kcode-pro-backup-${process.pid}-${Date.now()}`);
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

// ── HMAC helpers (mirror pro.ts internals) ──────────────────────

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
  writeFileSync(PRO_CACHE_FILE, JSON.stringify({ ...opts, hmac }, null, 2) + "\n", { mode: 0o600 });
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
// Constants
// ═════════════════════════════════════════════════════════════════

describe("PRO_FEATURES", () => {
  test("contains all 12 features", () => {
    expect(Object.keys(PRO_FEATURES)).toHaveLength(12);
  });

  test("contains all hard-gated features", () => {
    for (const f of [
      "http-server",
      "browser",
      "hooks-webhook",
      "hooks-agent",
      "distillation",
      "smart-routing",
      "cloud-failover",
      "deploy",
    ]) {
      expect(PRO_FEATURES).toHaveProperty(f);
    }
  });

  test("contains all soft-gated features", () => {
    for (const f of ["swarm", "transcript-search", "image-gen", "analytics-export"]) {
      expect(PRO_FEATURES).toHaveProperty(f);
    }
  });

  test("all descriptions are non-empty strings", () => {
    for (const [, desc] of Object.entries(PRO_FEATURES)) {
      expect(typeof desc).toBe("string");
      expect(desc.length).toBeGreaterThan(0);
    }
  });
});

describe("FREE_LIMITS", () => {
  test("maxSwarmAgents is 1", () => {
    expect(FREE_LIMITS.maxSwarmAgents).toBe(1);
  });
  test("transcriptSearchHours is 72", () => {
    expect(FREE_LIMITS.transcriptSearchHours).toBe(72);
  });
  test("contextWindowCap is 32000", () => {
    expect(FREE_LIMITS.contextWindowCap).toBe(32_000);
  });
  test("sessionsPerMonth is 50", () => {
    expect(FREE_LIMITS.sessionsPerMonth).toBe(50);
  });
  test("has exactly 4 fields", () => {
    expect(Object.keys(FREE_LIMITS)).toHaveLength(4);
  });
});

describe("clearProCache", () => {
  test("does not throw", () => {
    expect(() => clearProCache()).not.toThrow();
  });
  test("idempotent", () => {
    clearProCache();
    clearProCache();
    clearProCache();
  });
});

// ═════════════════════════════════════════════════════════════════
// loadProCache — file I/O with backup/restore
// ═════════════════════════════════════════════════════════════════

describe("loadProCache", () => {
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

  test("returns null when cache file does not exist", () => {
    expect(loadProCache()).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    writeFileSync(PRO_CACHE_FILE, "not json {{{", { mode: 0o600 });
    expect(loadProCache()).toBeNull();
  });

  test("returns null for empty JSON object", () => {
    writeFileSync(PRO_CACHE_FILE, "{}", { mode: 0o600 });
    expect(loadProCache()).toBeNull();
  });

  test("returns null when key field is missing", () => {
    writeFileSync(
      PRO_CACHE_FILE,
      JSON.stringify({
        validatedAt: new Date().toISOString(),
        valid: true,
        serverValidated: true,
        hmac: "abc",
      }),
      { mode: 0o600 },
    );
    expect(loadProCache()).toBeNull();
  });

  test("returns null when validatedAt field is missing", () => {
    writeFileSync(
      PRO_CACHE_FILE,
      JSON.stringify({
        key: proKey(),
        valid: true,
        serverValidated: true,
        hmac: "abc",
      }),
      { mode: 0o600 },
    );
    expect(loadProCache()).toBeNull();
  });

  test("returns null when valid field is missing", () => {
    writeFileSync(
      PRO_CACHE_FILE,
      JSON.stringify({
        key: proKey(),
        validatedAt: new Date().toISOString(),
        serverValidated: true,
        hmac: "abc",
      }),
      { mode: 0o600 },
    );
    expect(loadProCache()).toBeNull();
  });

  test("returns null when valid is not a boolean", () => {
    writeFileSync(
      PRO_CACHE_FILE,
      JSON.stringify({
        key: proKey(),
        validatedAt: new Date().toISOString(),
        valid: "true",
        serverValidated: true,
        hmac: "abc",
      }),
      { mode: 0o600 },
    );
    expect(loadProCache()).toBeNull();
  });

  test("returns null when HMAC is corrupted", () => {
    writeCacheFile({
      key: proKey("x"),
      validatedAt: new Date().toISOString(),
      valid: true,
      serverValidated: true,
    });
    const raw = JSON.parse(readFileSync(PRO_CACHE_FILE, "utf-8"));
    raw.hmac = "deadbeef" + raw.hmac.slice(8);
    writeFileSync(PRO_CACHE_FILE, JSON.stringify(raw), { mode: 0o600 });
    expect(loadProCache()).toBeNull();
  });

  test("returns null when valid field is flipped without HMAC update", () => {
    writeCacheFile({
      key: proKey("y"),
      validatedAt: new Date().toISOString(),
      valid: true,
      serverValidated: true,
    });
    const raw = JSON.parse(readFileSync(PRO_CACHE_FILE, "utf-8"));
    raw.valid = false;
    writeFileSync(PRO_CACHE_FILE, JSON.stringify(raw), { mode: 0o600 });
    expect(loadProCache()).toBeNull();
  });

  test("returns cache when HMAC is correct and valid=true", () => {
    const key = proKey("c");
    const validatedAt = new Date().toISOString();
    writeCacheFile({ key, validatedAt, valid: true, serverValidated: true });
    const cache = loadProCache();
    expect(cache).not.toBeNull();
    expect(cache!.key).toBe(key);
    expect(cache!.valid).toBe(true);
    expect(cache!.validatedAt).toBe(validatedAt);
  });

  test("returns cache when HMAC is correct and valid=false", () => {
    writeCacheFile({
      key: proKey("d"),
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
// HMAC integrity edge cases
// ═════════════════════════════════════════════════════════════════

describe("HMAC integrity", () => {
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

  test("changing the key field invalidates HMAC", () => {
    writeCacheFile({
      key: proKey("j"),
      validatedAt: new Date().toISOString(),
      valid: true,
      serverValidated: true,
    });
    const raw = JSON.parse(readFileSync(PRO_CACHE_FILE, "utf-8"));
    raw.key = proKey("k");
    writeFileSync(PRO_CACHE_FILE, JSON.stringify(raw), { mode: 0o600 });
    expect(loadProCache()).toBeNull();
  });

  test("changing validatedAt invalidates HMAC", () => {
    writeCacheFile({
      key: proKey("l"),
      validatedAt: "2025-01-01T00:00:00.000Z",
      valid: true,
      serverValidated: true,
    });
    const raw = JSON.parse(readFileSync(PRO_CACHE_FILE, "utf-8"));
    raw.validatedAt = "2026-06-01T00:00:00.000Z";
    writeFileSync(PRO_CACHE_FILE, JSON.stringify(raw), { mode: 0o600 });
    expect(loadProCache()).toBeNull();
  });

  test("swapping HMAC from another entry fails", () => {
    writeCacheFile({
      key: proKey("m"),
      validatedAt: new Date().toISOString(),
      valid: true,
      serverValidated: true,
    });
    const cache1 = JSON.parse(readFileSync(PRO_CACHE_FILE, "utf-8"));
    writeCacheFile({
      key: proKey("n"),
      validatedAt: new Date().toISOString(),
      valid: false,
      serverValidated: true,
    });
    const cache2 = JSON.parse(readFileSync(PRO_CACHE_FILE, "utf-8"));
    cache2.hmac = cache1.hmac;
    writeFileSync(PRO_CACHE_FILE, JSON.stringify(cache2), { mode: 0o600 });
    expect(loadProCache()).toBeNull();
  });

  test("correct HMAC with valid=true is accepted", () => {
    writeCacheFile({
      key: proKey("h"),
      validatedAt: new Date().toISOString(),
      valid: true,
      serverValidated: true,
    });
    expect(loadProCache()).not.toBeNull();
    expect(loadProCache()!.valid).toBe(true);
  });

  test("correct HMAC with valid=false is accepted", () => {
    writeCacheFile({
      key: proKey("i"),
      validatedAt: new Date().toISOString(),
      valid: false,
      serverValidated: false,
    });
    expect(loadProCache()).not.toBeNull();
    expect(loadProCache()!.valid).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════
// Key format rules (documentation tests)
// ═════════════════════════════════════════════════════════════════

describe("key format rules", () => {
  const VALID_PREFIXES = ["kcode_pro_", "klx_lic_"];

  test("kcode_pro_ is a valid prefix", () => {
    expect(VALID_PREFIXES.some((p) => "kcode_pro_abc123def456ghij".startsWith(p))).toBe(true);
  });

  test("klx_lic_ is a valid prefix", () => {
    expect(VALID_PREFIXES.some((p) => "klx_lic_abc123def456ghij".startsWith(p))).toBe(true);
  });

  test("random string is not valid", () => {
    expect(VALID_PREFIXES.some((p) => "sk-abc123".startsWith(p))).toBe(false);
  });

  test("minimum payload is 20 chars after prefix", () => {
    const prefix = "kcode_pro_";
    expect((prefix + "a".repeat(19)).slice(prefix.length).length).toBeLessThan(20);
    expect((prefix + "a".repeat(20)).slice(prefix.length).length).toBe(20);
  });
});

// ═════════════════════════════════════════════════════════════════
// Key checksum validation
// ═════════════════════════════════════════════════════════════════

describe("validateKeyChecksum", () => {
  test("rejects keys with wrong prefix", () => {
    expect(validateKeyChecksum("sk-abc123def456ghij78901234")).toBe(false);
  });

  test("rejects keys with payload too short", () => {
    expect(validateKeyChecksum("kcode_pro_short")).toBe(false);
  });

  test("accepts legacy all-hex keys (pre-checksum era)", () => {
    // Legacy format: prefix + 20+ hex chars
    expect(validateKeyChecksum("kcode_pro_" + "a".repeat(30))).toBe(true);
    expect(validateKeyChecksum("klx_lic_" + "0123456789abcdef0123")).toBe(true);
  });

  test("rejects keys with invalid checksum", () => {
    // Non-hex payload with wrong checksum
    expect(validateKeyChecksum("kcode_pro_test_payload_data_hereXX")).toBe(false);
  });

  test("accepts keys with valid checksum", () => {
    const { createHash } = require("node:crypto");
    const body = "test_payload_data_here_valid";
    const check = createHash("sha256").update(body).digest("hex").slice(0, 2);
    expect(validateKeyChecksum("kcode_pro_" + body + check)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════
// Grace period enforcement
// ═════════════════════════════════════════════════════════════════

describe("grace period", () => {
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

  test("non-server-validated cache expires after 24h", () => {
    // Write cache with old timestamp (25h ago) and serverValidated=false
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeCacheFile({
      key: proKey("g"),
      validatedAt: oldDate,
      valid: true,
      serverValidated: false,
    });
    // Should be null — grace period expired
    expect(loadProCache()).toBeNull();
  });

  test("non-server-validated cache works within 24h", () => {
    // Write cache with recent timestamp and serverValidated=false
    writeCacheFile({
      key: proKey("g"),
      validatedAt: new Date().toISOString(),
      valid: true,
      serverValidated: false,
    });
    // Should still work
    expect(loadProCache()).not.toBeNull();
    expect(loadProCache()!.valid).toBe(true);
  });

  test("server-validated cache works beyond 24h", () => {
    // Even old cache is fine if server-validated (will be rechecked via RECHECK_DAYS)
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeCacheFile({
      key: proKey("g"),
      validatedAt: oldDate,
      valid: true,
      serverValidated: true,
    });
    expect(loadProCache()).not.toBeNull();
  });
});
