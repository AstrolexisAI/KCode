// KCode Backend — Pro and trial key generation
// Key format matches src/core/pro.ts validation logic.
//
// Checksum sizing: the checksum is tamper-detection, not a security
// boundary — real authorization lives in the DB lookup (findCustomerByKey /
// findTrialByKey on the server). A brute-forced checksum still hits
// "key not found" without DB access. 8 hex (32 bits) makes accidental
// collisions and casual tampering infeasible while keeping keys short
// enough to paste. The validator also accepts legacy 2-hex checksums
// for keys minted before 2026-05-20.

import { createHash, randomBytes } from "node:crypto";

const CHECKSUM_LEN = 8;
const LEGACY_CHECKSUM_LEN = 2;

/**
 * Generate a pro key tied to a Stripe customer ID.
 * Format: kcode_pro_{customerHash12}{entropy32}{checksum8}
 */
export function generateProKey(customerId: string): string {
  const customerHash = createHash("sha256").update(customerId).digest("hex").slice(0, 12);
  const entropy = randomBytes(16).toString("hex");
  const body = `${customerHash}${entropy}`;
  const checksum = createHash("sha256").update(body).digest("hex").slice(0, CHECKSUM_LEN);
  return `kcode_pro_${body}${checksum}`;
}

/**
 * Generate a trial key with embedded expiry timestamp.
 * Format: kcode_trial_{random16}_{expiryEpochSeconds}{checksum8}
 */
export function generateTrialKey(daysValid: number = 14): string {
  const random = randomBytes(8).toString("hex");
  const expiryEpoch = Math.floor(Date.now() / 1000) + daysValid * 24 * 60 * 60;
  const body = `${random}_${expiryEpoch}`;
  const checksum = createHash("sha256").update(body).digest("hex").slice(0, CHECKSUM_LEN);
  return `kcode_trial_${body}${checksum}`;
}

/**
 * Validate key checksum (mirrors src/core/pro.ts:validateKeyChecksum).
 * Accepts current (8-hex) and legacy (2-hex) checksum formats.
 */
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
  if (/^[0-9a-f]+$/i.test(payload)) return true;
  for (const len of [CHECKSUM_LEN, LEGACY_CHECKSUM_LEN]) {
    if (payload.length <= len) continue;
    const body = payload.slice(0, -len);
    const check = payload.slice(-len).toLowerCase();
    const expected = createHash("sha256").update(body).digest("hex").slice(0, len);
    if (check === expected) return true;
  }
  return false;
}

/**
 * Extract the customer hash from a pro key (for reverse lookup).
 */
export function extractCustomerHash(proKey: string): string | null {
  if (!proKey.startsWith("kcode_pro_")) return null;
  const payload = proKey.slice("kcode_pro_".length);
  if (payload.length < 20) return null;
  return payload.slice(0, 12);
}
