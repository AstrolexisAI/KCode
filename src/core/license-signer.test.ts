// License signer tests. Uses a temporary KCODE_HOME to avoid
// touching the real keypair.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateKeypair,
  signLicense,
  signLicenseWithSummary,
} from "./license-signer";
import { verifyLicenseJwt } from "./license";

let testHome: string;
let origHome: string | undefined;
let origPubKey: string | undefined;

beforeEach(() => {
  origHome = process.env.KCODE_HOME;
  origPubKey = process.env.KCODE_LICENSE_PUBLIC_KEY;
  testHome = join(tmpdir(), `kcode-signer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testHome, { recursive: true });
  process.env.KCODE_HOME = testHome;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.KCODE_HOME;
  else process.env.KCODE_HOME = origHome;
  if (origPubKey === undefined) delete process.env.KCODE_LICENSE_PUBLIC_KEY;
  else process.env.KCODE_LICENSE_PUBLIC_KEY = origPubKey;
  if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
});

describe("generateKeypair", () => {
  test("creates new keypair when none exists", () => {
    const r = generateKeypair();
    expect(r.preserved).toBe(false);
    expect(existsSync(r.privateKeyPath)).toBe(true);
    expect(existsSync(r.publicKeyPath)).toBe(true);
    expect(r.publicKeyPem).toContain("BEGIN PUBLIC KEY");
  });

  test("preserves existing keypair without --force", () => {
    const first = generateKeypair();
    const second = generateKeypair();
    expect(second.preserved).toBe(true);
    expect(second.publicKeyPem).toBe(first.publicKeyPem);
  });

  test("regenerates with force=true", () => {
    const first = generateKeypair();
    const second = generateKeypair({ force: true });
    expect(second.preserved).toBe(false);
    expect(second.publicKeyPem).not.toBe(first.publicKeyPem);
  });
});

describe("signLicense round-trip", () => {
  test("signs a JWT that passes verifyLicenseJwt", () => {
    const kp = generateKeypair();
    process.env.KCODE_LICENSE_PUBLIC_KEY = kp.publicKeyPem;

    const jwt = signLicense({
      sub: "user@example.com",
      features: ["pro", "swarm"],
      seats: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 86400, // tomorrow
      tier: "pro",
    });

    const verified = verifyLicenseJwt(jwt);
    expect(verified.valid).toBe(true);
    expect(verified.claims?.sub).toBe("user@example.com");
    expect(verified.claims?.features).toEqual(["pro", "swarm"]);
    expect(verified.claims?.tier).toBe("pro");
  });

  test("rejects past expiry dates", () => {
    generateKeypair();
    expect(() =>
      signLicense({
        sub: "user@example.com",
        features: ["pro"],
        seats: 1,
        expiresAt: Math.floor(Date.now() / 1000) - 100, // past
      }),
    ).toThrow(/Invalid expiresAt/);
  });

  test("accepts ISO date strings for expiresAt", () => {
    const kp = generateKeypair();
    process.env.KCODE_LICENSE_PUBLIC_KEY = kp.publicKeyPem;
    const nextYear = new Date();
    nextYear.setFullYear(nextYear.getFullYear() + 1);

    const jwt = signLicense({
      sub: "user@example.com",
      features: ["pro"],
      seats: 1,
      expiresAt: nextYear.toISOString(),
    });
    const verified = verifyLicenseJwt(jwt);
    expect(verified.valid).toBe(true);
  });

  test("hardware binding shows up in claims", () => {
    const kp = generateKeypair();
    process.env.KCODE_LICENSE_PUBLIC_KEY = kp.publicKeyPem;
    const jwt = signLicense({
      sub: "user@example.com",
      features: ["pro"],
      seats: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      hardware: "abc123fingerprint",
    });
    const verified = verifyLicenseJwt(jwt);
    expect(verified.claims?.hardware).toBe("abc123fingerprint");
  });
});

describe("signLicenseWithSummary", () => {
  test("returns jwt + claims + expiresInDays", () => {
    generateKeypair();
    const r = signLicenseWithSummary({
      sub: "user@example.com",
      features: ["pro"],
      seats: 5,
      expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
      tier: "team",
      orgName: "Acme",
    });
    expect(r.jwt.split(".")).toHaveLength(3);
    expect(r.claims.sub).toBe("user@example.com");
    expect(r.claims.orgName).toBe("Acme");
    expect(r.claims.tier).toBe("team");
    expect(r.expiresInDays).toBeGreaterThanOrEqual(29);
    expect(r.expiresInDays).toBeLessThanOrEqual(30);
  });
});
