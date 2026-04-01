import { describe, expect, test } from "bun:test";
import { extractCustomerHash, generateProKey, generateTrialKey, validateKeyChecksum } from "./keys";

describe("generateProKey", () => {
  test("produces valid kcode_pro_ prefix", () => {
    const key = generateProKey("cus_test123");
    expect(key.startsWith("kcode_pro_")).toBe(true);
  });

  test("has sufficient length", () => {
    const key = generateProKey("cus_test123");
    const payload = key.slice("kcode_pro_".length);
    expect(payload.length).toBeGreaterThanOrEqual(20);
  });

  test("passes checksum validation", () => {
    const key = generateProKey("cus_abc");
    expect(validateKeyChecksum(key)).toBe(true);
  });

  test("different calls produce different keys", () => {
    const k1 = generateProKey("cus_same");
    const k2 = generateProKey("cus_same");
    expect(k1).not.toBe(k2);
  });
});

describe("generateTrialKey", () => {
  test("produces valid kcode_trial_ prefix", () => {
    const key = generateTrialKey(14);
    expect(key.startsWith("kcode_trial_")).toBe(true);
  });

  test("passes checksum validation", () => {
    const key = generateTrialKey(7);
    expect(validateKeyChecksum(key)).toBe(true);
  });

  test("embeds expiry timestamp", () => {
    const key = generateTrialKey(14);
    const payload = key.slice("kcode_trial_".length);
    const body = payload.slice(0, -2);
    const parts = body.split("_");
    const expiry = Number(parts[parts.length - 1]);
    const now = Date.now() / 1000;
    // Expiry should be ~14 days from now
    expect(expiry).toBeGreaterThan(now + 13 * 86400);
    expect(expiry).toBeLessThan(now + 15 * 86400);
  });
});

describe("validateKeyChecksum", () => {
  test("rejects empty string", () => {
    expect(validateKeyChecksum("")).toBe(false);
  });

  test("rejects unknown prefix", () => {
    expect(validateKeyChecksum("invalid_prefix_abcdefghijklmnopqrst")).toBe(false);
  });

  test("rejects too short payload", () => {
    expect(validateKeyChecksum("kcode_pro_abc")).toBe(false);
  });

  test("rejects tampered trial key", () => {
    // Trial keys contain underscores so they don't pass the all-hex legacy path
    const key = generateTrialKey(14);
    const payload = key.slice("kcode_trial_".length);
    const body = payload.slice(0, -2);
    // Flip the expiry to break checksum
    const tampered = `kcode_trial_${body}xx`;
    expect(validateKeyChecksum(tampered)).toBe(false);
  });

  test("accepts all-hex pro keys (legacy path)", () => {
    // Pro keys are all hex, which passes the legacy validation
    const key = generateProKey("cus_test");
    const payload = key.slice("kcode_pro_".length);
    expect(/^[0-9a-f]+$/i.test(payload)).toBe(true);
    expect(validateKeyChecksum(key)).toBe(true);
  });

  test("accepts klx_lic_ keys", () => {
    // Legacy all-hex key
    const key = "klx_lic_" + "a".repeat(32);
    expect(validateKeyChecksum(key)).toBe(true);
  });
});

describe("extractCustomerHash", () => {
  test("extracts first 12 chars of payload", () => {
    const key = generateProKey("cus_xyz");
    const hash = extractCustomerHash(key);
    expect(hash).not.toBeNull();
    expect(hash!.length).toBe(12);
  });

  test("returns null for non-pro keys", () => {
    expect(extractCustomerHash("kcode_trial_abc")).toBeNull();
    expect(extractCustomerHash("invalid")).toBeNull();
  });

  test("same customer produces same hash prefix", () => {
    const k1 = generateProKey("cus_consistent");
    const k2 = generateProKey("cus_consistent");
    expect(extractCustomerHash(k1)).toBe(extractCustomerHash(k2));
  });
});
