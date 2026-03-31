// KCode - P2P Agent Mesh Security
// Team token generation, peer verification, and file encryption for mesh communication.

import { log } from "../logger";

// ─── Constants ─────────────────────────────────────────────────

const TEAM_TOKEN_BYTES = 32;
const AES_ALGORITHM = "AES-GCM";
const AES_KEY_LENGTH = 256;
const IV_BYTES = 12;

// ─── Team Token ────────────────────────────────────────────────

/**
 * Generate a cryptographically secure team token (hex string).
 * This is the shared secret that authorizes peers in the mesh.
 */
export function generateTeamToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TEAM_TOKEN_BYTES));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Validate that a token has the expected format (64 hex chars = 32 bytes).
 */
export function isValidTeamToken(token: string): boolean {
  return /^[0-9a-f]{64}$/i.test(token);
}

// ─── Peer Verification ─────────────────────────────────────────

/**
 * Verify that an incoming request carries a valid team token.
 * Returns true if the X-Team-Token header matches the expected token.
 */
export function verifyPeerToken(
  headers: { get(name: string): string | null },
  expectedToken: string,
): boolean {
  const provided = headers.get("X-Team-Token");
  if (!provided || !expectedToken) return false;

  // Constant-time comparison to prevent timing attacks
  if (provided.length !== expectedToken.length) return false;

  let mismatch = 0;
  for (let i = 0; i < provided.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ expectedToken.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Build the authorization headers for outgoing mesh requests.
 */
export function buildAuthHeaders(teamToken: string): Record<string, string> {
  return {
    "X-Team-Token": teamToken,
    "Content-Type": "application/json",
  };
}

// ─── Node Identity ─────────────────────────────────────────────

/**
 * Generate a unique node ID.
 * Uses crypto.randomUUID (Web Crypto API available in Bun).
 */
export function generateNodeId(): string {
  return crypto.randomUUID();
}

// ─── File Encryption ───────────────────────────────────────────

/**
 * Derive an AES-256 key from the team token using PBKDF2.
 */
async function deriveKey(teamToken: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(teamToken),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: AES_ALGORITHM, length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt data using AES-256-GCM with a key derived from the team token.
 * Returns a buffer containing: salt (16 bytes) || iv (12 bytes) || ciphertext.
 */
export async function encryptData(
  data: Uint8Array,
  teamToken: string,
): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(teamToken, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: AES_ALGORITHM, iv },
    key,
    data,
  );

  // Concatenate: salt + iv + ciphertext
  const result = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
  result.set(salt, 0);
  result.set(iv, salt.length);
  result.set(new Uint8Array(ciphertext), salt.length + iv.length);
  return result;
}

/**
 * Decrypt data that was encrypted with encryptData.
 * Expects the format: salt (16 bytes) || iv (12 bytes) || ciphertext.
 */
export async function decryptData(
  encrypted: Uint8Array,
  teamToken: string,
): Promise<Uint8Array> {
  if (encrypted.length < 16 + IV_BYTES + 1) {
    throw new Error("Encrypted data too short");
  }

  const salt = encrypted.slice(0, 16);
  const iv = encrypted.slice(16, 16 + IV_BYTES);
  const ciphertext = encrypted.slice(16 + IV_BYTES);
  const key = await deriveKey(teamToken, salt);

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: AES_ALGORITHM, iv },
      key,
      ciphertext,
    );
    return new Uint8Array(plaintext);
  } catch (err) {
    log.debug("mesh-security", `Decryption failed: ${err}`);
    throw new Error("Decryption failed — wrong team token or corrupted data");
  }
}
