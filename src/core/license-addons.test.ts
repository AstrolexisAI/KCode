// KCode - Tests for paid-addon gating in the license module
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearLicenseCache, hasLicenseAddon } from "./license";
import { signLicense } from "./license-signer";

// Generate a test keypair once. The verifier picks up the public
// half via KCODE_LICENSE_PUBLIC_KEY env var (same pattern as
// license.test.ts), and the signer picks up the private half via
// KCODE_LICENSE_PRIVATE_KEY env var (path to PEM).
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

let tmpHome: string;
let prevKcodeHome: string | undefined;
let prevPubKey: string | undefined;
let prevPrivKey: string | undefined;
let privateKeyPath: string;

beforeEach(() => {
  tmpHome = join(
    "/tmp",
    `kcode-license-addon-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  prevKcodeHome = process.env.KCODE_HOME;
  prevPubKey = process.env.KCODE_LICENSE_PUBLIC_KEY;
  prevPrivKey = process.env.KCODE_LICENSE_PRIVATE_KEY;
  process.env.KCODE_HOME = tmpHome;
  process.env.KCODE_LICENSE_PUBLIC_KEY = publicKey as string;
  privateKeyPath = join(tmpHome, "test-priv.pem");
  writeFileSync(privateKeyPath, privateKey as string);
  process.env.KCODE_LICENSE_PRIVATE_KEY = privateKeyPath;
  clearLicenseCache();
});

afterEach(() => {
  if (prevKcodeHome === undefined) delete process.env.KCODE_HOME;
  else process.env.KCODE_HOME = prevKcodeHome;
  if (prevPubKey === undefined) delete process.env.KCODE_LICENSE_PUBLIC_KEY;
  else process.env.KCODE_LICENSE_PUBLIC_KEY = prevPubKey;
  if (prevPrivKey === undefined) delete process.env.KCODE_LICENSE_PRIVATE_KEY;
  else process.env.KCODE_LICENSE_PRIVATE_KEY = prevPrivKey;
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  clearLicenseCache();
});

function installLicense(jwt: string): void {
  const dir = join(tmpHome, "enterprise");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "license.jwt"), jwt);
  clearLicenseCache();
}

describe("hasLicenseAddon", () => {
  test("returns false with no license installed", () => {
    expect(hasLicenseAddon("ane-embedder")).toBe(false);
  });

  test("returns false when enterprise license has NO addons array (intentional design)", () => {
    const jwt = signLicense({
      sub: "test@example.com",
      features: ["pro", "enterprise"],
      seats: 1,
      tier: "enterprise",
      offline: true,
      expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    });
    installLicense(jwt);
    // Enterprise grants all FEATURES but addons require explicit listing.
    expect(hasLicenseAddon("ane-embedder")).toBe(false);
    expect(hasLicenseAddon("voice-pro")).toBe(false);
  });

  test("returns true when addon is explicitly listed", () => {
    const jwt = signLicense({
      sub: "test@example.com",
      features: ["pro", "enterprise"],
      addons: ["ane-embedder"],
      seats: 1,
      tier: "enterprise",
      offline: true,
      expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    });
    installLicense(jwt);
    expect(hasLicenseAddon("ane-embedder")).toBe(true);
    expect(hasLicenseAddon("voice-pro")).toBe(false);
  });

  test("multiple addons all check independently", () => {
    const jwt = signLicense({
      sub: "test@example.com",
      features: ["enterprise"],
      addons: ["ane-embedder", "voice-pro", "vision-ocr"],
      seats: 1,
      tier: "enterprise",
      offline: true,
      expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    });
    installLicense(jwt);
    expect(hasLicenseAddon("ane-embedder")).toBe(true);
    expect(hasLicenseAddon("voice-pro")).toBe(true);
    expect(hasLicenseAddon("vision-ocr")).toBe(true);
    expect(hasLicenseAddon("not-purchased")).toBe(false);
  });

  test("pro tier with addon also works (addons aren't tier-locked, just not auto-granted)", () => {
    const jwt = signLicense({
      sub: "test@example.com",
      features: ["pro"],
      addons: ["ane-embedder"],
      seats: 1,
      tier: "pro",
      offline: true,
      expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    });
    installLicense(jwt);
    expect(hasLicenseAddon("ane-embedder")).toBe(true);
  });
});
