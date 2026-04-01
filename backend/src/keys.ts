// KCode Backend — Pro and trial key generation
// Key format matches src/core/pro.ts validation logic

import { createHash, randomBytes } from "node:crypto";

/**
 * Generate a pro key tied to a Stripe customer ID.
 * Format: kcode_pro_{customerHash12}{entropy32}{checksum2}
 *
 * The customerHash allows server-side lookup without storing the full key.
 * The checksum (first 2 hex chars of SHA-256(body)) catches typos.
 */
export function generateProKey(customerId: string): string {
  const customerHash = createHash("sha256").update(customerId).digest("hex").slice(0, 12);
  const entropy = randomBytes(16).toString("hex");
  const body = `${customerHash}${entropy}`;
  const checksum = createHash("sha256").update(body).digest("hex").slice(0, 2);
  return `kcode_pro_${body}${checksum}`;
}

/**
 * Generate a trial key with embedded expiry timestamp.
 * Format: kcode_trial_{random16}_{expiryEpochSeconds}_{checksum2}
 */
export function generateTrialKey(daysValid: number = 14): string {
  const random = randomBytes(8).toString("hex");
  const expiryEpoch = Math.floor(Date.now() / 1000) + daysValid * 24 * 60 * 60;
  const body = `${random}_${expiryEpoch}`;
  const checksum = createHash("sha256").update(body).digest("hex").slice(0, 2);
  return `kcode_trial_${body}${checksum}`;
}

/**
 * Validate key checksum (mirrors src/core/pro.ts:validateKeyChecksum).
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
  const body = payload.slice(0, -2);
  const check = payload.slice(-2).toLowerCase();
  const expected = createHash("sha256").update(body).digest("hex").slice(0, 2);
  return check === expected;
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
