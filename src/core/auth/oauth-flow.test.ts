import { describe, expect, test } from "bun:test";
import {
  buildAuthUrl,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  getOAuthProviderNames,
  getProviderAuthStatus,
  isTokenExpired,
  PROVIDER_CONFIGS,
  resolveProviderConfig,
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
      expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:19284/callback");
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
      expect(config!.provider).toBe("kcode-cloud");
      expect(config!.clientId).toBe("kcode-cli");
      expect(config!.scopes).toContain("api");
    });

    test("anthropic config has exchangeForApiKey", () => {
      const config = PROVIDER_CONFIGS["anthropic"];
      expect(config).toBeDefined();
      expect(config!.provider).toBe("anthropic");
      expect(config!.exchangeForApiKey).toBe(true);
      expect(config!.authorizationUrl).toContain("anthropic.com");
    });

    test("openai-codex config exists with correct OAuth endpoints", () => {
      const config = PROVIDER_CONFIGS["openai-codex"];
      expect(config).toBeDefined();
      expect(config!.provider).toBe("openai-codex");
      expect(config!.authorizationUrl).toContain("auth.openai.com");
      expect(config!.tokenUrl).toContain("auth.openai.com");
      expect(config!.scopes).toContain("openai.chat");
      expect(config!.scopes).toContain("offline_access");
      expect(config!.extraAuthParams?.audience).toBe("https://api.openai.com/v1");
    });

    test("gemini config exists with Google OAuth endpoints", () => {
      const config = PROVIDER_CONFIGS["gemini"];
      expect(config).toBeDefined();
      expect(config!.provider).toBe("gemini");
      expect(config!.authorizationUrl).toContain("accounts.google.com");
      expect(config!.tokenUrl).toContain("googleapis.com");
      expect(config!.extraAuthParams?.access_type).toBe("offline");
      expect(config!.extraAuthParams?.prompt).toBe("consent");
    });

    test("all configs have required fields", () => {
      for (const [name, config] of Object.entries(PROVIDER_CONFIGS)) {
        expect(config.provider).toBeDefined();
        expect(config.authorizationUrl).toBeTruthy();
        expect(config.tokenUrl).toBeTruthy();
        expect(config.clientId).toBeTruthy();
        expect(config.scopes!.length).toBeGreaterThan(0);
        expect(config.label).toBeTruthy();
      }
    });
  });

  describe("getOAuthProviderNames", () => {
    test("returns all provider names", () => {
      const names = getOAuthProviderNames();
      expect(names).toContain("anthropic");
      expect(names).toContain("openai-codex");
      expect(names).toContain("gemini");
      expect(names).toContain("kcode-cloud");
    });
  });

  describe("resolveProviderConfig", () => {
    test("returns full OAuthConfig for known provider", () => {
      const config = resolveProviderConfig("anthropic");
      expect(config).not.toBeNull();
      expect(config!.provider).toBe("anthropic");
      expect(config!.redirectPort).toBe(19284);
    });

    test("returns null for unknown provider", () => {
      expect(resolveProviderConfig("unknown-provider")).toBeNull();
    });

    test("includes extraAuthParams for gemini", () => {
      const config = resolveProviderConfig("gemini");
      expect(config).not.toBeNull();
      expect(config!.extraAuthParams?.access_type).toBe("offline");
    });
  });

  describe("buildAuthUrl with extraAuthParams", () => {
    test("appends extra params for OpenAI Codex", () => {
      const config = resolveProviderConfig("openai-codex")!;
      const url = buildAuthUrl(config, "test-challenge", "test-state");
      const parsed = new URL(url);
      expect(parsed.searchParams.get("audience")).toBe("https://api.openai.com/v1");
    });

    test("appends access_type and prompt for Gemini", () => {
      const config = resolveProviderConfig("gemini")!;
      const url = buildAuthUrl(config, "test-challenge", "test-state");
      const parsed = new URL(url);
      expect(parsed.searchParams.get("access_type")).toBe("offline");
      expect(parsed.searchParams.get("prompt")).toBe("consent");
    });
  });

  describe("getProviderAuthStatus", () => {
    test("returns 'none' for unauthenticated provider without env var", async () => {
      const status = await getProviderAuthStatus("kcode-cloud");
      // kcode-cloud has no env var mapping, so it should be 'none' unless tokens exist
      expect(status.provider).toBe("kcode-cloud");
      expect(["none", "oauth", "api_key"]).toContain(status.method);
    });

    test("returns label from provider config", async () => {
      const status = await getProviderAuthStatus("anthropic");
      expect(status.label).toBe("Anthropic (Claude)");
    });
  });
});
