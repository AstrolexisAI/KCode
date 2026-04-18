import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkOfflineLicense,
  clearLicenseCache,
  formatLicenseFailureGuide,
  formatLicenseStatus,
  getLicenseDaysRemaining,
  getLicenseTier,
  hasLicenseFeature,
  loadLicenseFile,
  verifyLicenseJwt,
} from "./license";

const TEST_HOME = join(tmpdir(), `kcode-license-test-${Date.now()}`);

// Generate a test RSA key pair
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function base64UrlEncode(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createTestJwt(
  payload: Record<string, unknown>,
  key: string = privateKey,
  alg: string = "RS256",
): string {
  const header = base64UrlEncode(JSON.stringify({ alg, typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const signedData = `${header}.${body}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signedData);
  const signature = base64UrlEncode(signer.sign(key));

  return `${signedData}.${signature}`;
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "kulvex.ai",
    sub: "org-test-corp",
    features: ["pro"],
    seats: 50,
    exp: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60, // 1 year from now
    iat: Math.floor(Date.now() / 1000),
    offline: true,
    hardware: null,
    tier: "pro",
    orgName: "Test Corp",
    ...overrides,
  };
}

describe("license", () => {
  beforeEach(() => {
    process.env.KCODE_HOME = TEST_HOME;
    process.env.KCODE_LICENSE_PUBLIC_KEY = publicKey as string;
    mkdirSync(TEST_HOME, { recursive: true });
    clearLicenseCache();
  });

  afterEach(() => {
    try {
      rmSync(TEST_HOME, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    delete process.env.KCODE_HOME;
    delete process.env.KCODE_LICENSE_FILE;
    delete process.env.KCODE_LICENSE_PUBLIC_KEY;
    clearLicenseCache();
  });

  describe("verifyLicenseJwt", () => {
    test("accepts a valid JWT signed with the test key", () => {
      const jwt = createTestJwt(validPayload());
      const result = verifyLicenseJwt(jwt);
      expect(result.valid).toBe(true);
      expect(result.claims).not.toBeNull();
      expect(result.claims!.sub).toBe("org-test-corp");
      expect(result.claims!.tier).toBe("pro");
      expect(result.claims!.seats).toBe(50);
      expect(result.claims!.offline).toBe(true);
      expect(result.claims!.orgName).toBe("Test Corp");
    });

    test("rejects JWT with invalid format", () => {
      const result = verifyLicenseJwt("not-a-jwt");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("expected 3 parts");
    });

    test("rejects JWT with wrong issuer", () => {
      const jwt = createTestJwt(validPayload({ iss: "evil.com" }));
      const result = verifyLicenseJwt(jwt);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid issuer");
    });

    test("rejects expired JWT", () => {
      const jwt = createTestJwt(validPayload({ exp: Math.floor(Date.now() / 1000) - 3600 }));
      const result = verifyLicenseJwt(jwt);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("expired");
    });

    test("rejects JWT with missing features", () => {
      const payload = validPayload();
      delete payload.features;
      const jwt = createTestJwt(payload);
      const result = verifyLicenseJwt(jwt);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("features");
    });

    test("rejects JWT with tampered payload", () => {
      const jwt = createTestJwt(validPayload());
      const parts = jwt.split(".");
      // Tamper with payload
      const tampered =
        parts[0] +
        "." +
        base64UrlEncode(JSON.stringify(validPayload({ seats: 999 }))) +
        "." +
        parts[2];
      const result = verifyLicenseJwt(tampered);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid signature");
    });

    test("rejects JWT signed with a different key", () => {
      const { privateKey: wrongKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      const jwt = createTestJwt(validPayload(), wrongKey as string);
      const result = verifyLicenseJwt(jwt);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid signature");
    });

    test("rejects JWT with unsupported algorithm", () => {
      // Create a JWT with HS256 header but RS256 signature (should be rejected)
      const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const body = base64UrlEncode(JSON.stringify(validPayload()));
      const signer = createSign("RSA-SHA256");
      signer.update(`${header}.${body}`);
      const signature = base64UrlEncode(signer.sign(privateKey));
      const jwt = `${header}.${body}.${signature}`;

      const result = verifyLicenseJwt(jwt);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Unsupported algorithm");
    });

    test("handles enterprise tier granting all features", () => {
      const jwt = createTestJwt(validPayload({ tier: "enterprise", features: ["enterprise"] }));
      const result = verifyLicenseJwt(jwt);
      expect(result.valid).toBe(true);
      expect(result.claims!.tier).toBe("enterprise");
    });

    test("handles not-before (nbf) claim", () => {
      const jwt = createTestJwt(validPayload({ nbf: Math.floor(Date.now() / 1000) + 3600 }));
      const result = verifyLicenseJwt(jwt);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not yet valid");
    });
  });

  describe("loadLicenseFile", () => {
    test("loads license from KCODE_LICENSE_FILE env var", () => {
      const licensePath = join(TEST_HOME, "custom-license.jwt");
      const jwt = createTestJwt(validPayload());
      writeFileSync(licensePath, jwt);
      process.env.KCODE_LICENSE_FILE = licensePath;

      const loaded = loadLicenseFile();
      expect(loaded).toBe(jwt);
    });

    test("loads license from ~/.kcode/license.jwt", () => {
      const jwt = createTestJwt(validPayload());
      writeFileSync(join(TEST_HOME, "license.jwt"), jwt);

      const loaded = loadLicenseFile();
      expect(loaded).toBe(jwt);
    });

    test("returns null when no license file exists", () => {
      const loaded = loadLicenseFile();
      expect(loaded).toBeNull();
    });

    test("skips empty license files", () => {
      writeFileSync(join(TEST_HOME, "license.jwt"), "");
      const loaded = loadLicenseFile();
      expect(loaded).toBeNull();
    });
  });

  describe("checkOfflineLicense", () => {
    test("returns valid result when license file is present and valid", () => {
      const jwt = createTestJwt(validPayload());
      writeFileSync(join(TEST_HOME, "license.jwt"), jwt);

      const result = checkOfflineLicense();
      expect(result.valid).toBe(true);
      expect(result.claims!.sub).toBe("org-test-corp");
    });

    test("caches result across calls", () => {
      const jwt = createTestJwt(validPayload());
      writeFileSync(join(TEST_HOME, "license.jwt"), jwt);

      const result1 = checkOfflineLicense();
      // Delete the file — cached result should still work
      rmSync(join(TEST_HOME, "license.jwt"));
      const result2 = checkOfflineLicense();

      expect(result1.valid).toBe(true);
      expect(result2.valid).toBe(true);
      expect(result1).toBe(result2); // Same reference
    });

    test("clearLicenseCache forces re-read", () => {
      const jwt = createTestJwt(validPayload());
      writeFileSync(join(TEST_HOME, "license.jwt"), jwt);

      const result1 = checkOfflineLicense();
      expect(result1.valid).toBe(true);

      rmSync(join(TEST_HOME, "license.jwt"));
      clearLicenseCache();

      const result2 = checkOfflineLicense();
      expect(result2.valid).toBe(false);
    });
  });

  describe("hasLicenseFeature", () => {
    test("returns true for pro features with pro license", () => {
      const jwt = createTestJwt(validPayload({ features: ["pro", "swarm"] }));
      writeFileSync(join(TEST_HOME, "license.jwt"), jwt);

      expect(hasLicenseFeature("swarm")).toBe(true);
      expect(hasLicenseFeature("pro")).toBe(true);
    });

    test("enterprise tier grants all features", () => {
      const jwt = createTestJwt(validPayload({ tier: "enterprise", features: ["enterprise"] }));
      writeFileSync(join(TEST_HOME, "license.jwt"), jwt);

      expect(hasLicenseFeature("swarm")).toBe(true);
      expect(hasLicenseFeature("http-server")).toBe(true);
      expect(hasLicenseFeature("anything")).toBe(true);
    });

    test("returns false when no license", () => {
      expect(hasLicenseFeature("pro")).toBe(false);
    });
  });

  describe("getLicenseTier", () => {
    test("returns tier from valid license", () => {
      const jwt = createTestJwt(validPayload({ tier: "team" }));
      writeFileSync(join(TEST_HOME, "license.jwt"), jwt);

      expect(getLicenseTier()).toBe("team");
    });

    test("returns null when no license", () => {
      expect(getLicenseTier()).toBeNull();
    });
  });

  describe("getLicenseDaysRemaining", () => {
    test("returns positive days for future expiry", () => {
      const jwt = createTestJwt(validPayload());
      writeFileSync(join(TEST_HOME, "license.jwt"), jwt);

      const days = getLicenseDaysRemaining();
      expect(days).toBeGreaterThan(360);
      expect(days).toBeLessThanOrEqual(366);
    });

    test("returns -1 when no license", () => {
      expect(getLicenseDaysRemaining()).toBe(-1);
    });
  });

  describe("formatLicenseStatus", () => {
    test("shows license info when valid", () => {
      const jwt = createTestJwt(validPayload());
      writeFileSync(join(TEST_HOME, "license.jwt"), jwt);

      const status = formatLicenseStatus();
      expect(status).toContain("PRO");
      expect(status).toContain("Test Corp");
      expect(status).toContain("50");
    });

    test("shows no license when invalid", () => {
      const status = formatLicenseStatus();
      expect(status).toContain("none");
    });
  });

  describe("formatLicenseFailureGuide", () => {
    test("includes the reason, plain", () => {
      const out = formatLicenseFailureGuide(
        "License is bound to a different machine",
        { color: false },
      );
      expect(out).toContain("License is bound to a different machine");
      expect(out).toContain("✗ License error:");
    });

    test("lists all four recovery paths", () => {
      const out = formatLicenseFailureGuide("Expired on 2099-01-01", { color: false });
      expect(out).toContain("kcode auth login astrolexis");
      expect(out).toContain("https://kulvex.ai/account/devices");
      expect(out).toContain("~/.kcode/license.jwt");
      expect(out).toContain("kcode pro trial");
    });

    test("reassures user that free mode still works", () => {
      const out = formatLicenseFailureGuide("any reason", { color: false });
      expect(out).toContain("KCode keeps working in free mode");
    });

    test("strips trailing punctuation from the reason so we can add our own", () => {
      // "Expired." + "." from the format string would read "Expired.."
      const out = formatLicenseFailureGuide("Expired.", { color: false });
      expect(out).toContain("License error: Expired.");
      expect(out).not.toContain("Expired..");
    });

    test("color=false omits ANSI escape codes", () => {
      const out = formatLicenseFailureGuide("Invalid signature", { color: false });
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes on purpose
      expect(out).not.toMatch(/\x1b\[/);
    });

    test("color=true (default) includes ANSI escape codes", () => {
      const out = formatLicenseFailureGuide("Invalid signature");
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes on purpose
      expect(out).toMatch(/\x1b\[/);
    });
  });
});
