// KCode - P2P Agent Mesh Security Tests

import { describe, expect, test } from "bun:test";
import {
  buildAuthHeaders,
  decryptData,
  encryptData,
  generateNodeId,
  generateTeamToken,
  isValidTeamToken,
  verifyPeerToken,
} from "./security";

// ─── generateTeamToken ─────────────────────────────────────────

describe("generateTeamToken", () => {
  test("generates a 64-char hex string (32 bytes)", () => {
    const token = generateTeamToken();
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
  });

  test("generates unique tokens each time", () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateTeamToken()));
    expect(tokens.size).toBe(20);
  });
});

// ─── isValidTeamToken ──────────────────────────────────────────

describe("isValidTeamToken", () => {
  test("accepts valid 64-char hex token", () => {
    const token = generateTeamToken();
    expect(isValidTeamToken(token)).toBe(true);
  });

  test("accepts uppercase hex", () => {
    const token = "A".repeat(64);
    expect(isValidTeamToken(token)).toBe(true);
  });

  test("rejects too-short string", () => {
    expect(isValidTeamToken("abcdef")).toBe(false);
  });

  test("rejects too-long string", () => {
    expect(isValidTeamToken("a".repeat(65))).toBe(false);
  });

  test("rejects non-hex characters", () => {
    expect(isValidTeamToken("g".repeat(64))).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidTeamToken("")).toBe(false);
  });
});

// ─── verifyPeerToken ───────────────────────────────────────────

describe("verifyPeerToken", () => {
  const expectedToken = generateTeamToken();

  test("returns true for matching token", () => {
    const headers = new Headers({ "X-Team-Token": expectedToken });
    expect(verifyPeerToken(headers, expectedToken)).toBe(true);
  });

  test("returns false for wrong token", () => {
    const headers = new Headers({ "X-Team-Token": "wrong" });
    expect(verifyPeerToken(headers, expectedToken)).toBe(false);
  });

  test("returns false when header is missing", () => {
    const headers = new Headers();
    expect(verifyPeerToken(headers, expectedToken)).toBe(false);
  });

  test("returns false when expected token is empty", () => {
    const headers = new Headers({ "X-Team-Token": "something" });
    expect(verifyPeerToken(headers, "")).toBe(false);
  });

  test("returns false for different-length tokens (timing-safe)", () => {
    const headers = new Headers({ "X-Team-Token": "short" });
    expect(verifyPeerToken(headers, expectedToken)).toBe(false);
  });
});

// ─── buildAuthHeaders ──────────────────────────────────────────

describe("buildAuthHeaders", () => {
  test("includes X-Team-Token and Content-Type", () => {
    const token = "test-token-123";
    const headers = buildAuthHeaders(token);
    expect(headers["X-Team-Token"]).toBe(token);
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

// ─── generateNodeId ────────────────────────────────────────────

describe("generateNodeId", () => {
  test("generates a valid UUID format", () => {
    const id = generateNodeId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateNodeId()));
    expect(ids.size).toBe(20);
  });
});

// ─── Encryption / Decryption ───────────────────────────────────

describe("encryptData / decryptData", () => {
  const teamToken = generateTeamToken();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  test("round-trips text data correctly", async () => {
    const plaintext = encoder.encode("Hello, mesh world!");
    const encrypted = await encryptData(plaintext, teamToken);
    const decrypted = await decryptData(encrypted, teamToken);
    expect(decoder.decode(decrypted)).toBe("Hello, mesh world!");
  });

  test("encrypted data is different from plaintext", async () => {
    const plaintext = encoder.encode("secret data");
    const encrypted = await encryptData(plaintext, teamToken);
    expect(encrypted).not.toEqual(plaintext);
    expect(encrypted.length).toBeGreaterThan(plaintext.length);
  });

  test("different tokens produce different ciphertext", async () => {
    const plaintext = encoder.encode("same input");
    const token1 = generateTeamToken();
    const token2 = generateTeamToken();
    const enc1 = await encryptData(plaintext, token1);
    const enc2 = await encryptData(plaintext, token2);
    // Very unlikely to be equal (different keys + random IVs)
    expect(Buffer.from(enc1).equals(Buffer.from(enc2))).toBe(false);
  });

  test("decryption with wrong token throws", async () => {
    const plaintext = encoder.encode("secret");
    const encrypted = await encryptData(plaintext, teamToken);
    const wrongToken = generateTeamToken();
    await expect(decryptData(encrypted, wrongToken)).rejects.toThrow();
  });

  test("decryption of truncated data throws", async () => {
    const tooShort = new Uint8Array(10);
    await expect(decryptData(tooShort, teamToken)).rejects.toThrow("Encrypted data too short");
  });

  test("handles empty-ish data (just salt+iv, no ciphertext) gracefully", async () => {
    const minimal = new Uint8Array(16 + 12); // salt + iv but no ciphertext
    await expect(decryptData(minimal, teamToken)).rejects.toThrow("Encrypted data too short");
  });

  test("round-trips binary data", async () => {
    const binary = new Uint8Array([0, 1, 2, 255, 128, 64]);
    const encrypted = await encryptData(binary, teamToken);
    const decrypted = await decryptData(encrypted, teamToken);
    expect(Array.from(decrypted)).toEqual(Array.from(binary));
  });

  test("round-trips large data", async () => {
    const large = new Uint8Array(10_000);
    for (let i = 0; i < large.length; i++) large[i] = i % 256;
    const encrypted = await encryptData(large, teamToken);
    const decrypted = await decryptData(encrypted, teamToken);
    expect(decrypted.length).toBe(large.length);
    expect(Array.from(decrypted)).toEqual(Array.from(large));
  });
});
