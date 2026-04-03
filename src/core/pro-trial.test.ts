// Tests for trial key support in pro.ts

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { getTrialDaysRemaining, isTrialExpired, isTrialKey, validateKeyChecksum } from "./pro";

// ── Helper: build a trial key with valid checksum ──────────────
function buildTrialKey(expiryTimestamp: number): string {
  const random = "abcdef1234567890abcd"; // 20 chars of random hex
  // Body format: {random}_{expiryTimestamp}
  const body = `${random}_${expiryTimestamp}`;
  // Checksum: first 2 hex chars of SHA-256(body)
  const checksum = createHash("sha256").update(body).digest("hex").slice(0, 2);
  return `kcode_trial_${body}${checksum}`;
}

// Future: 30 days from now
const futureExpiry = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
// Past: 5 days ago
const pastExpiry = Math.floor(Date.now() / 1000) - 5 * 24 * 60 * 60;

const validTrialKey = buildTrialKey(futureExpiry);
const expiredTrialKey = buildTrialKey(pastExpiry);

// ═══════════════════════════════════════════════════════════════
// isTrialKey
// ═══════════════════════════════════════════════════════════════

describe("isTrialKey", () => {
  test("returns true for kcode_trial_ prefix", () => {
    expect(isTrialKey("kcode_trial_something")).toBe(true);
  });

  test("returns true for a well-formed trial key", () => {
    expect(isTrialKey(validTrialKey)).toBe(true);
  });

  test("returns false for kcode_pro_ prefix", () => {
    expect(isTrialKey("kcode_pro_something")).toBe(false);
  });

  test("returns false for klx_lic_ prefix", () => {
    expect(isTrialKey("klx_lic_something")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isTrialKey("")).toBe(false);
  });

  test("returns false for non-string input", () => {
    expect(isTrialKey(null as any)).toBe(false);
    expect(isTrialKey(undefined as any)).toBe(false);
    expect(isTrialKey(42 as any)).toBe(false);
  });

  test("returns false for partial prefix", () => {
    expect(isTrialKey("kcode_trial")).toBe(false);
    expect(isTrialKey("kcode_tri_abc")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// validateKeyChecksum with trial keys
// ═══════════════════════════════════════════════════════════════

describe("validateKeyChecksum (trial keys)", () => {
  test("accepts a valid trial key with correct checksum", () => {
    expect(validateKeyChecksum(validTrialKey)).toBe(true);
  });

  test("accepts an expired trial key with correct checksum (checksum is format-only)", () => {
    expect(validateKeyChecksum(expiredTrialKey)).toBe(true);
  });

  test("rejects a trial key with wrong checksum", () => {
    // Flip last 2 chars
    const bad = validTrialKey.slice(0, -2) + "zz";
    expect(validateKeyChecksum(bad)).toBe(false);
  });

  test("rejects a trial key with too-short payload", () => {
    expect(validateKeyChecksum("kcode_trial_short")).toBe(false);
  });

  test("does not accept trial prefix for pro key validation", () => {
    // A kcode_pro_ key should not validate if given kcode_trial_ prefix
    const proKey = "kcode_pro_" + "a".repeat(30);
    expect(validateKeyChecksum(proKey)).toBe(true); // pro key is fine
    // But a bare trial prefix without enough payload fails
    expect(validateKeyChecksum("kcode_trial_abc")).toBe(false);
  });

  test("still accepts kcode_pro_ keys", () => {
    expect(validateKeyChecksum("kcode_pro_" + "a".repeat(30))).toBe(true);
  });

  test("still accepts klx_lic_ keys", () => {
    expect(validateKeyChecksum("klx_lic_" + "b".repeat(30))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// isTrialExpired
// ═══════════════════════════════════════════════════════════════

describe("isTrialExpired", () => {
  test("returns false for a trial key expiring in the future", () => {
    expect(isTrialExpired(validTrialKey)).toBe(false);
  });

  test("returns true for an expired trial key", () => {
    expect(isTrialExpired(expiredTrialKey)).toBe(true);
  });

  test("returns true for a non-trial key", () => {
    expect(isTrialExpired("kcode_pro_" + "a".repeat(30))).toBe(true);
  });

  test("returns true for empty/invalid input", () => {
    expect(isTrialExpired("")).toBe(true);
    expect(isTrialExpired("garbage")).toBe(true);
  });

  test("returns true for trial key with non-numeric expiry", () => {
    // Construct a key with non-numeric expiry part
    const body = "abcdef1234567890abcd_notanumber";
    const checksum = createHash("sha256").update(body).digest("hex").slice(0, 2);
    const key = `kcode_trial_${body}${checksum}`;
    expect(isTrialExpired(key)).toBe(true);
  });

  test("correctly handles a key expiring exactly now (boundary)", () => {
    const nowExpiry = Math.floor(Date.now() / 1000);
    const key = buildTrialKey(nowExpiry);
    // Should be expired (or just barely) since Date.now() >= expiry
    expect(isTrialExpired(key)).toBe(true);
  });

  test("handles a key expiring 1 second from now", () => {
    const soonExpiry = Math.floor(Date.now() / 1000) + 1;
    const key = buildTrialKey(soonExpiry);
    expect(isTrialExpired(key)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// getTrialDaysRemaining
// ═══════════════════════════════════════════════════════════════

describe("getTrialDaysRemaining", () => {
  test("returns ~30 for a key expiring in 30 days", () => {
    const days = getTrialDaysRemaining(validTrialKey);
    expect(days).toBeGreaterThanOrEqual(29);
    expect(days).toBeLessThanOrEqual(31);
  });

  test("returns 0 for an expired key", () => {
    expect(getTrialDaysRemaining(expiredTrialKey)).toBe(0);
  });

  test("returns 0 for a non-trial key", () => {
    expect(getTrialDaysRemaining("kcode_pro_" + "a".repeat(30))).toBe(0);
  });

  test("returns 0 for empty string", () => {
    expect(getTrialDaysRemaining("")).toBe(0);
  });

  test("returns 1 for a key expiring in less than 24h but more than 0", () => {
    const halfDayFromNow = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
    const key = buildTrialKey(halfDayFromNow);
    expect(getTrialDaysRemaining(key)).toBe(1); // ceil rounds up
  });

  test("returns 7 for a key expiring in exactly 7 days", () => {
    const sevenDays = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
    const key = buildTrialKey(sevenDays);
    const days = getTrialDaysRemaining(key);
    expect(days).toBeGreaterThanOrEqual(7);
    expect(days).toBeLessThanOrEqual(8);
  });
});
