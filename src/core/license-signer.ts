// KCode — License JWT Signer
//
// Generates RS256-signed JWT licenses compatible with the verifier in
// src/core/license.ts. Private key reads from:
//   1. KCODE_LICENSE_PRIVATE_KEY env var (path to PEM file), or
//   2. ~/.kcode/license-signing.pem
//
// The public key (for pasting into license.ts) comes from
// `generateKeypair()` which writes both halves to ~/.kcode/.
//
// Security: the private key NEVER leaves the local filesystem.
// Signing happens in-process; no network calls.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
} from "node:crypto";
import { chmodSync } from "node:fs";
import { dirname } from "node:path";
import { kcodePath } from "./paths";

// ─── Types (mirror src/core/license.ts::LicenseClaims) ──────────

export interface LicenseInput {
  /** Issuer — e.g. "kulvex-licensing". */
  iss?: string;
  /** Subject — typically the customer email. */
  sub: string;
  /** Features granted — e.g. ["pro", "enterprise", "swarm"]. */
  features: string[];
  /** Number of seats (1 for individual). */
  seats: number;
  /** Expiry as ISO string or Unix timestamp. */
  expiresAt: string | number;
  /** Whether the license allows offline / air-gapped activation. */
  offline?: boolean;
  /** Hardware fingerprint to bind this license to a specific machine.
   *  `null` = not hardware-bound (portable license). */
  hardware?: string | null;
  /** Display name of the customer's organization. */
  orgName?: string;
  /** Tier (pro / team / enterprise). */
  tier?: "pro" | "team" | "enterprise";
}

// ─── Paths ──────────────────────────────────────────────────────

const PRIVATE_KEY_PATH = () =>
  process.env.KCODE_LICENSE_PRIVATE_KEY ?? kcodePath("license-signing.pem");
const PUBLIC_KEY_PATH = () => kcodePath("license-signing.pub.pem");

// ─── Keypair generation ─────────────────────────────────────────

export interface KeypairResult {
  privateKeyPath: string;
  publicKeyPath: string;
  publicKeyPem: string;
  /** True if an existing keypair was found and preserved. */
  preserved: boolean;
}

export function generateKeypair(opts?: { force?: boolean }): KeypairResult {
  const privPath = PRIVATE_KEY_PATH();
  const pubPath = PUBLIC_KEY_PATH();

  if (!opts?.force && existsSync(privPath)) {
    // Preserve existing keypair — signing keys shouldn't be
    // casually regenerated since that invalidates all prior licenses.
    const existingPub = existsSync(pubPath)
      ? readFileSync(pubPath, "utf-8")
      : derivePublicKey(readFileSync(privPath, "utf-8"));
    return {
      privateKeyPath: privPath,
      publicKeyPath: pubPath,
      publicKeyPem: existingPub,
      preserved: true,
    };
  }

  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  mkdirSync(dirname(privPath), { recursive: true });
  writeFileSync(privPath, privateKey, "utf-8");
  try {
    chmodSync(privPath, 0o600);
  } catch {
    // Non-POSIX — best effort
  }
  writeFileSync(pubPath, publicKey, "utf-8");

  return {
    privateKeyPath: privPath,
    publicKeyPath: pubPath,
    publicKeyPem: publicKey,
    preserved: false,
  };
}

function derivePublicKey(privatePem: string): string {
  const keyObj = createPrivateKey(privatePem);
  const pub = createPublicKey(keyObj);
  return pub.export({ type: "spki", format: "pem" }).toString();
}

// ─── Signing ────────────────────────────────────────────────────

/** Load the configured private key or throw with a clear message. */
export function loadPrivateKey(): string {
  const path = PRIVATE_KEY_PATH();
  if (!existsSync(path)) {
    throw new Error(
      `No signing key found at ${path}. Run \`kcode license init-keypair\` first, or set KCODE_LICENSE_PRIVATE_KEY to point at an existing PEM file.`,
    );
  }
  return readFileSync(path, "utf-8");
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Sign a set of license claims into a JWT compatible with
 * src/core/license.ts::verifyLicenseJwt. Returns the compact JWT string.
 */
export function signLicense(input: LicenseInput, privateKeyOverride?: string): string {
  const privateKeyPem = privateKeyOverride ?? loadPrivateKey();

  const now = Math.floor(Date.now() / 1000);
  const exp =
    typeof input.expiresAt === "number"
      ? Math.floor(input.expiresAt)
      : Math.floor(new Date(input.expiresAt).getTime() / 1000);

  if (!Number.isFinite(exp) || exp <= now) {
    throw new Error(
      `Invalid expiresAt: must be a future date. Got ${input.expiresAt}`,
    );
  }

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    // Default matches the hardcoded verifier check in license.ts:113
    iss: input.iss ?? "kulvex.ai",
    sub: input.sub,
    features: input.features,
    seats: input.seats,
    iat: now,
    exp,
    offline: input.offline ?? false,
    hardware: input.hardware ?? null,
    orgName: input.orgName,
    tier: input.tier ?? "pro",
  };

  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = base64UrlEncode(signer.sign(privateKeyPem));

  return `${signingInput}.${signature}`;
}

/** Same as signLicense but returns the full JWT plus a summary of claims. */
export function signLicenseWithSummary(
  input: LicenseInput,
): { jwt: string; claims: Record<string, unknown>; expiresInDays: number } {
  const jwt = signLicense(input);
  const parts = jwt.split(".");
  const payload = JSON.parse(
    Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
  );
  const now = Math.floor(Date.now() / 1000);
  return {
    jwt,
    claims: payload,
    expiresInDays: Math.floor((payload.exp - now) / 86400),
  };
}
