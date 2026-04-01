// KCode - Offline License Validation (JWT-based)
// Supports RS256-signed license files for permanent offline/air-gap Pro activation.
// License files are self-contained JWTs that don't require network validation.
//
// License file locations (checked in order):
//   1. KCODE_LICENSE_FILE env var
//   2. ~/.kcode/license.jwt
//   3. .kcode/license.jwt (project-level)
//
// License JWT payload:
//   iss: "kulvex.ai"
//   sub: org/user identifier
//   features: string[] (e.g. ["pro", "enterprise", "swarm"])
//   seats: number (0 = unlimited)
//   exp: number (Unix epoch seconds, expiry date)
//   iat: number (Unix epoch seconds, issued at)
//   offline: boolean (true = no server validation required)
//   hardware: string | null (null = any machine, string = bound to fingerprint)

import { createVerify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger";
import { kcodeHome, kcodePath } from "./paths";

// ─── Types ──────────────────────────────────────────────────────

export interface LicenseClaims {
  iss: string;
  sub: string;
  features: string[];
  seats: number;
  exp: number;
  iat: number;
  offline: boolean;
  hardware: string | null;
  orgName?: string;
  tier?: "pro" | "team" | "enterprise";
}

export interface LicenseValidationResult {
  valid: boolean;
  claims: LicenseClaims | null;
  error?: string;
}

// ─── Embedded Public Key ────────────────────────────────────────
// This is the Kulvex license-signing public key (RS256).
// The corresponding private key is held by the Kulvex licensing server.
// Customers receive signed JWTs; KCode verifies them locally with this key.

const KULVEX_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Z1qR3kJxRKMsz8LWaF1
gNPkMSbH9SAql0FDxAQyvVpGwOZ8CfBDJHQnVTaM7RZVHkGJ2sSxPMalN8DNFOQ3
kEpCQn9LPnkQ5GJcR1MhFjXRbfXmUvTsXpCrJCdBlYa2NzGKQFLmFROrhDqkV8sS
YqnPMRWJfU3va4ZVJzMkMdXBMa4VKfrgst8KaHS7xO1xPIAe9gLP5U8kxGYlQ3qN
rADBwS7vZ0dTbKaq3H2KaNr/3gq1bSLC7TKQAV5bJfAz3gRayehFEQPJsMzJV8vq
n9PoFdcpnJUMGj5VjPM7X8UJMbKeaECUYeaB7MFJCe8MXVeYgF7q0NAu1/bN2+y5
kwIDAQAB
-----END PUBLIC KEY-----`;

// Allow overriding the public key for testing or self-hosted license servers.
// Read at call time (not import time) so env var overrides work in tests.
function getPublicKey(): string {
  return process.env.KCODE_LICENSE_PUBLIC_KEY ?? KULVEX_LICENSE_PUBLIC_KEY;
}

// ─── Base64URL Helpers ──────────────────────────────────────────

function base64UrlDecode(str: string): Buffer {
  // Replace URL-safe chars and add padding
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

// ─── JWT Parsing & Verification ─────────────────────────────────

/**
 * Parse and verify a JWT license token using RS256.
 * Does NOT make any network calls — fully local verification.
 */
export function verifyLicenseJwt(token: string): LicenseValidationResult {
  try {
    const parts = token.trim().split(".");
    if (parts.length !== 3) {
      return { valid: false, claims: null, error: "Invalid JWT format: expected 3 parts" };
    }

    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    // Parse header
    const header = JSON.parse(base64UrlDecode(headerB64).toString("utf-8"));
    if (header.alg !== "RS256") {
      return { valid: false, claims: null, error: `Unsupported algorithm: ${header.alg}` };
    }

    // Verify signature
    const signedData = `${headerB64}.${payloadB64}`;
    const signature = base64UrlDecode(signatureB64);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(signedData);

    if (!verifier.verify(getPublicKey(), signature)) {
      return { valid: false, claims: null, error: "Invalid signature — license may be tampered" };
    }

    // Parse payload
    const payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf-8"));

    // Validate required fields
    if (payload.iss !== "kulvex.ai") {
      return { valid: false, claims: null, error: `Invalid issuer: ${payload.iss}` };
    }

    if (!payload.sub || typeof payload.sub !== "string") {
      return { valid: false, claims: null, error: "Missing subject (sub) claim" };
    }

    if (!Array.isArray(payload.features)) {
      return { valid: false, claims: null, error: "Missing features claim" };
    }

    if (typeof payload.exp !== "number") {
      return { valid: false, claims: null, error: "Missing expiry (exp) claim" };
    }

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (now > payload.exp) {
      const expDate = new Date(payload.exp * 1000).toISOString().split("T")[0];
      return { valid: false, claims: null, error: `License expired on ${expDate}` };
    }

    // Check not-before (if present)
    if (typeof payload.nbf === "number" && now < payload.nbf) {
      return { valid: false, claims: null, error: "License is not yet valid (nbf)" };
    }

    const claims: LicenseClaims = {
      iss: payload.iss,
      sub: payload.sub,
      features: payload.features,
      seats: typeof payload.seats === "number" ? payload.seats : 0,
      exp: payload.exp,
      iat: typeof payload.iat === "number" ? payload.iat : 0,
      offline: payload.offline !== false,
      hardware: typeof payload.hardware === "string" ? payload.hardware : null,
      orgName: typeof payload.orgName === "string" ? payload.orgName : undefined,
      tier: ["pro", "team", "enterprise"].includes(payload.tier) ? payload.tier : "pro",
    };

    return { valid: true, claims };
  } catch (err) {
    return {
      valid: false,
      claims: null,
      error: `License parse error: ${err instanceof Error ? err.message : err}`,
    };
  }
}

// ─── License File Discovery ────────────────────────────────────

/**
 * Find and load a license file from known locations.
 * Returns the raw JWT string or null if no license file is found.
 */
export function loadLicenseFile(): string | null {
  const candidates: string[] = [];

  // 1. Env var override (highest priority)
  if (process.env.KCODE_LICENSE_FILE) {
    candidates.push(process.env.KCODE_LICENSE_FILE);
  }

  // 2. User-level license
  candidates.push(kcodePath("license.jwt"));

  // 3. Enterprise directory
  candidates.push(kcodePath("enterprise", "license.jwt"));

  // 4. Project-level license
  candidates.push(join(process.cwd(), ".kcode", "license.jwt"));

  for (const path of candidates) {
    try {
      if (existsSync(path)) {
        const content = readFileSync(path, "utf-8").trim();
        if (content.length > 0) {
          log.debug("license", `Found license file at ${path}`);
          return content;
        }
      }
    } catch (err) {
      log.debug("license", `Failed to read license file ${path}: ${err}`);
    }
  }

  return null;
}

// ─── High-Level API ─────────────────────────────────────────────

let _cachedResult: LicenseValidationResult | null = null;

/**
 * Check if a valid offline license file is present.
 * Results are cached for the session lifetime (no repeated disk reads).
 */
export function checkOfflineLicense(): LicenseValidationResult {
  if (_cachedResult) return _cachedResult;

  const token = loadLicenseFile();
  if (!token) {
    _cachedResult = { valid: false, claims: null, error: "No license file found" };
    return _cachedResult;
  }

  _cachedResult = verifyLicenseJwt(token);

  if (_cachedResult.valid) {
    log.debug(
      "license",
      `Valid license: ${_cachedResult.claims!.sub} (tier: ${_cachedResult.claims!.tier}, ` +
        `expires: ${new Date(_cachedResult.claims!.exp * 1000).toISOString().split("T")[0]})`,
    );
  } else {
    log.debug("license", `License validation failed: ${_cachedResult.error}`);
  }

  return _cachedResult;
}

/**
 * Check if a specific feature is granted by the offline license.
 */
export function hasLicenseFeature(feature: string): boolean {
  const result = checkOfflineLicense();
  if (!result.valid || !result.claims) return false;
  // "enterprise" tier grants all features
  if (result.claims.tier === "enterprise") return true;
  // "team" grants all pro features plus team-specific ones
  if (result.claims.tier === "team" && !feature.startsWith("enterprise-")) return true;
  // Otherwise check explicit feature list
  return result.claims.features.includes(feature) || result.claims.features.includes("pro");
}

/**
 * Get the license tier, or null if no valid license.
 */
export function getLicenseTier(): "pro" | "team" | "enterprise" | null {
  const result = checkOfflineLicense();
  if (!result.valid || !result.claims) return null;
  return result.claims.tier ?? "pro";
}

/**
 * Get days until license expiry, or -1 if no valid license.
 */
export function getLicenseDaysRemaining(): number {
  const result = checkOfflineLicense();
  if (!result.valid || !result.claims) return -1;
  const remaining = result.claims.exp - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / (60 * 60 * 24));
}

/** Clear cached license result (e.g. after installing a new license file). */
export function clearLicenseCache(): void {
  _cachedResult = null;
}

/**
 * Format a human-readable license status string for display.
 */
export function formatLicenseStatus(): string {
  const result = checkOfflineLicense();

  if (!result.valid) {
    return `  License: none (${result.error ?? "no license file"})`;
  }

  const c = result.claims!;
  const daysLeft = getLicenseDaysRemaining();
  const expDate = new Date(c.exp * 1000).toISOString().split("T")[0];
  const seatsStr = c.seats === 0 ? "unlimited" : `${c.seats}`;

  const lines = [
    `  License: ${c.tier?.toUpperCase() ?? "PRO"} (offline)`,
    `  Organization: ${c.orgName ?? c.sub}`,
    `  Seats: ${seatsStr}`,
    `  Expires: ${expDate} (${daysLeft} days remaining)`,
    `  Features: ${c.features.join(", ")}`,
  ];

  if (daysLeft <= 30) {
    lines.push(`  ⚠ License expires in ${daysLeft} days — contact sales@kulvex.ai to renew`);
  }

  return lines.join("\n");
}
