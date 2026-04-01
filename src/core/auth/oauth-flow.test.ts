import { test, expect, describe } from "bun:test";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  buildAuthUrl,
  isTokenExpired,
  PROVIDER_CONFIGS,
} from "./oauth-flow";
import type { OAuthConfig, OAuthTokens } from "./types";

describe("oauth-flow", () => {
  describe("PKCE", () => {
    test("generateCodeVerifier creates 43-char alphanumeric string", () => {
      const verifier = generateCodeVerifier();
      expect(verifier).toMatch(/^[a-zA-Z0-9]{43}$/);
    });

    test("generateCodeVerifier is random", () => {
      const a = generateCodeVerifier();
      const b = generateCodeVerifier();
      expect(a).not.toBe(b);
    });

    test("generateCodeChallenge is deterministic for same input", async () => {
      const verifier = "test123456789012345678901234567890123456789";
      const a = await generateCodeChallenge(verifier);
      const b = await generateCodeChallenge(verifier);
      expect(a).toBe(b);
    });

    test("generateCodeChallenge is base64url (no +, /, =)", async () => {
      const verifier = generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);
      expect(challenge).not.toContain("+");
      expect(challenge).not.toContain("/");
      expect(challenge).not.toContain("=");
    });

    test("generateState creates 32-char hex", () => {
      const state = generateState();
      expect(state).toMatch(/^[0-9a-f]{32}$/);
    });

    test("generateState is random", () => {
      const a = generateState();
      const b = generateState();
      expect(a).not.toBe(b);
    });
  });

  describe("buildAuthUrl", () => {
    const config: OAuthConfig = {
      provider: "kcode-cloud",
      authorizationUrl: "https://cloud.kcode.dev/oauth/authorize",
      tokenUrl: "https://cloud.kcode.dev/oauth/token",
      clientId: "kcode-cli",
      scopes: ["api", "sync"],
      redirectPort: 19284,
    };

    test("builds valid URL with all required params", () => {
      const url = buildAuthUrl(config, "test-challenge", "test-state");
      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://cloud.kcode.dev");
      expect(parsed.pathname).toBe("/oauth/authorize");
      expect(parsed.searchParams.get("response_type")).toBe("code");
      expect(parsed.searchParams.get("client_id")).toBe("kcode-cli");
      expect(parsed.searchParams.get("scope")).toBe("api sync");
      expect(parsed.searchParams.get("state")).toBe("test-state");
      expect(parsed.searchParams.get("code_challenge")).toBe("test-challenge");
      expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    });

    test("includes correct redirect_uri", () => {
      const url = buildAuthUrl(config, "ch", "st");
      const parsed = new URL(url);
      expect(parsed.searchParams.get("redirect_uri")).toBe(
        "http://127.0.0.1:19284/callback",
      );
    });

    test("uses default port when not specified", () => {
      const noPort = { ...config, redirectPort: 0 };
      const url = buildAuthUrl(noPort, "ch", "st");
      // redirectPort 0 → falls to default path in buildAuthUrl
      expect(url).toContain("callback");
    });
  });

  describe("isTokenExpired", () => {
    test("returns false when no expiry", () => {
      const tokens: OAuthTokens = {
        accessToken: "test",
        tokenType: "Bearer",
      };
      expect(isTokenExpired(tokens)).toBe(false);
    });

    test("returns false when far from expiry", () => {
      const tokens: OAuthTokens = {
        accessToken: "test",
        tokenType: "Bearer",
        expiresAt: Date.now() + 3600_000, // 1 hour from now
      };
      expect(isTokenExpired(tokens)).toBe(false);
    });

    test("returns true when past expiry", () => {
      const tokens: OAuthTokens = {
        accessToken: "test",
        tokenType: "Bearer",
        expiresAt: Date.now() - 1000,
      };
      expect(isTokenExpired(tokens)).toBe(true);
    });

    test("returns true within 1-minute buffer", () => {
      const tokens: OAuthTokens = {
        accessToken: "test",
        tokenType: "Bearer",
        expiresAt: Date.now() + 30_000, // 30 seconds — within 1-minute buffer
      };
      expect(isTokenExpired(tokens)).toBe(true);
    });
  });

  describe("PROVIDER_CONFIGS", () => {
    test("kcode-cloud config exists", () => {
      const config = PROVIDER_CONFIGS["kcode-cloud"];
      expect(config).toBeDefined();
      expect(config.provider).toBe("kcode-cloud");
      expect(config.clientId).toBe("kcode-cli");
      expect(config.scopes).toContain("api");
    });
  });
});
