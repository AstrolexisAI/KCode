// OAuth 2.0 PKCE Flow — Secure browser-based authentication for KCode.
// Supports KCode Cloud, Anthropic, OpenAI, and custom providers.

import { randomBytes } from "node:crypto";
import { deleteSecret, getSecret, setSecret } from "./keychain";
import type { OAuthConfig, OAuthTokens } from "./types";

const DEFAULT_REDIRECT_PORT = 19284;
const TOKEN_ACCOUNT_PREFIX = "oauth-token-";
const REFRESH_ACCOUNT_PREFIX = "oauth-refresh-";

export const PROVIDER_CONFIGS: Record<string, Partial<OAuthConfig>> = {
  "kcode-cloud": {
    provider: "kcode-cloud",
    authorizationUrl: "https://cloud.kcode.dev/oauth/authorize",
    tokenUrl: "https://cloud.kcode.dev/oauth/token",
    clientId: "kcode-cli",
    scopes: ["api", "sync"],
    label: "KCode Cloud",
  },
  astrolexis: {
    // Astrolexis licensing: OAuth PKCE against astrolexis.space.
    // The site handles login/signup, binds the kcode install to the
    // user's subscription, and returns an access_token. The access
    // token is later used to hit GET /api/subscription for tier +
    // feature + seat info — see src/core/subscription.ts.
    provider: "astrolexis",
    authorizationUrl: "https://astrolexis.space/oauth/authorize",
    tokenUrl: "https://astrolexis.space/oauth/token",
    clientId: "kcode-cli",
    scopes: ["subscription:read"],
    label: "Astrolexis",
  },
  anthropic: {
    provider: "anthropic",
    authorizationUrl: "https://console.anthropic.com/oauth/authorize",
    tokenUrl: "https://console.anthropic.com/v1/oauth/token",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    scopes: ["org:create_api_key", "user:profile", "user:inference"],
    exchangeForApiKey: true,
    label: "Anthropic (Claude)",
    // Anthropic uses their own console callback — not a local server.
    // The user must copy the code from the browser and paste it back.
    extraAuthParams: { code: "true" },
    redirectUri: "https://console.anthropic.com/oauth/code/callback",
  },
  "openai-codex": {
    provider: "openai-codex",
    authorizationUrl: "https://auth.openai.com/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientId: "app_scp_oBpBLzrq1HEMbGwMtasMuKGz",
    scopes: ["openai.chat", "openai.responses", "offline_access"],
    extraAuthParams: { audience: "https://api.openai.com/v1" },
    label: "OpenAI (Codex)",
  },
  gemini: {
    provider: "gemini",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: "236695937910-gk2b1hkqshrfr0l2dp9ih3n8t0mnoeqg.apps.googleusercontent.com",
    scopes: [
      "https://www.googleapis.com/auth/generative-language",
      "https://www.googleapis.com/auth/cloud-platform",
    ],
    extraAuthParams: { access_type: "offline", prompt: "consent" },
    label: "Google Gemini",
  },
};

/** Get all supported OAuth provider names */
export function getOAuthProviderNames(): string[] {
  return Object.keys(PROVIDER_CONFIGS);
}

/** Resolve provider config to a full OAuthConfig */
export function resolveProviderConfig(provider: string): OAuthConfig | null {
  const partial = PROVIDER_CONFIGS[provider];
  if (!partial) return null;
  return {
    provider: partial.provider ?? "custom",
    authorizationUrl: partial.authorizationUrl ?? "",
    tokenUrl: partial.tokenUrl ?? "",
    clientId: partial.clientId ?? "",
    scopes: partial.scopes ?? [],
    redirectPort: partial.redirectPort ?? DEFAULT_REDIRECT_PORT,
    extraAuthParams: partial.extraAuthParams,
    exchangeForApiKey: partial.exchangeForApiKey,
    label: partial.label,
    redirectUri: partial.redirectUri,
  } as OAuthConfig;
}

// ── PKCE utilities ──

function generateCodeVerifier(): string {
  // Generate enough random bytes to guarantee 43+ alphanumeric chars after filtering
  return randomBytes(48)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 43)
    .padEnd(43, "x");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateState(): string {
  return randomBytes(16).toString("hex");
}

// ── OAuth Flow ──

export interface OAuthFlowResult {
  tokens: OAuthTokens;
  provider: string;
}

/**
 * Start the full OAuth 2.0 PKCE flow:
 * 1. Generate code_verifier + code_challenge
 * 2. Open browser with authorization URL
 * 3. Start local callback server
 * 4. Wait for callback with authorization code
 * 5. Exchange code for tokens
 * 6. Store tokens in keychain
 */
export async function startOAuthFlow(
  config: OAuthConfig,
  opts?: { onAuthUrl?: (url: string) => void },
): Promise<OAuthFlowResult> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();
  const redirectPort = config.redirectPort || DEFAULT_REDIRECT_PORT;
  const redirectUri = config.redirectUri ?? `http://127.0.0.1:${redirectPort}/callback`;

  // Build authorization URL
  const authUrlObj = new URL(config.authorizationUrl);
  authUrlObj.searchParams.set("response_type", "code");
  authUrlObj.searchParams.set("client_id", config.clientId);
  authUrlObj.searchParams.set("redirect_uri", redirectUri);
  authUrlObj.searchParams.set("scope", config.scopes.join(" "));
  authUrlObj.searchParams.set("state", state);
  authUrlObj.searchParams.set("code_challenge", codeChallenge);
  authUrlObj.searchParams.set("code_challenge_method", "S256");

  // Append provider-specific extra params (e.g., access_type=offline for Google)
  if (config.extraAuthParams) {
    for (const [key, value] of Object.entries(config.extraAuthParams)) {
      authUrlObj.searchParams.set(key, value);
    }
  }

  const authUrl = authUrlObj.toString();

  // Notify caller with the URL (for display in UI) before opening browser
  opts?.onAuthUrl?.(authUrl);

  // Try to open browser automatically
  await openBrowser(authUrl);

  // Wait for the callback
  const code = await waitForCallback(redirectPort, state);

  // Exchange code for tokens
  const tokens = await exchangeCode(config, code, codeVerifier, redirectUri);

  // Store in keychain
  await storeTokens(config.provider, tokens);

  return { tokens, provider: config.provider };
}

/** Build the authorization URL without starting the flow */
export function buildAuthUrl(config: OAuthConfig, codeChallenge: string, state: string): string {
  const redirectUri =
    config.redirectUri ??
    `http://127.0.0.1:${config.redirectPort || DEFAULT_REDIRECT_PORT}/callback`;
  const authUrl = new URL(config.authorizationUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", config.scopes.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  if (config.extraAuthParams) {
    for (const [key, value] of Object.entries(config.extraAuthParams)) {
      authUrl.searchParams.set(key, value);
    }
  }

  return authUrl.toString();
}

/** Open browser (platform-aware) */
export async function openBrowser(url: string): Promise<void> {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", url]
        : ["xdg-open", url];
  try {
    const proc = Bun.spawn(cmd, { stderr: "pipe" });
    await proc.exited;
  } catch {
    // Ignore — user may not have a desktop environment
  }
}

/** Start temporary HTTP server and wait for OAuth callback */
async function waitForCallback(port: number, expectedState: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        server.stop();
        reject(new Error("OAuth callback timed out after 5 minutes"));
      },
      5 * 60 * 1000,
    );

    const server = Bun.serve({
      port,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/callback") {
          return new Response("Not Found", { status: 404 });
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          clearTimeout(timeout);
          server.stop();
          reject(new Error(`OAuth error: ${error}`));
          return new Response(
            "<html><body><h2>Authentication failed</h2><p>You can close this tab.</p></body></html>",
            { headers: { "Content-Type": "text/html" } },
          );
        }

        if (state !== expectedState) {
          clearTimeout(timeout);
          server.stop();
          reject(new Error("OAuth state mismatch — possible CSRF"));
          return new Response("State mismatch", { status: 400 });
        }

        if (!code) {
          clearTimeout(timeout);
          server.stop();
          reject(new Error("No authorization code in callback"));
          return new Response("Missing code", { status: 400 });
        }

        clearTimeout(timeout);
        server.stop();
        resolve(code);
        return new Response(
          "<html><body><h2>Authenticated!</h2><p>You can close this tab and return to KCode.</p></body></html>",
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
  });
}

/** Exchange authorization code for tokens */
async function exchangeCode(
  config: OAuthConfig,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<OAuthTokens> {
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string | undefined,
    expiresAt: data.expires_in ? Date.now() + (data.expires_in as number) * 1000 : undefined,
    tokenType: (data.token_type as string) ?? "Bearer",
    scope: data.scope as string | undefined,
  };
}

// ── Token management ──

/** Store tokens securely in keychain */
export async function storeTokens(provider: string, tokens: OAuthTokens): Promise<void> {
  await setSecret(`${TOKEN_ACCOUNT_PREFIX}${provider}`, JSON.stringify(tokens));
}

/** Retrieve stored tokens from keychain */
export async function getStoredTokens(provider: string): Promise<OAuthTokens | null> {
  const raw = await getSecret(`${TOKEN_ACCOUNT_PREFIX}${provider}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OAuthTokens;
  } catch {
    return null;
  }
}

/** Check if tokens are expired */
export function isTokenExpired(tokens: OAuthTokens): boolean {
  if (!tokens.expiresAt) return false;
  return Date.now() >= tokens.expiresAt - 60_000; // 1 minute buffer
}

/** Refresh an expired access token using the refresh token */
export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
): Promise<OAuthTokens> {
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status})`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  return {
    accessToken: data.access_token as string,
    refreshToken: (data.refresh_token as string) ?? refreshToken,
    expiresAt: data.expires_in ? Date.now() + (data.expires_in as number) * 1000 : undefined,
    tokenType: (data.token_type as string) ?? "Bearer",
    scope: data.scope as string | undefined,
  };
}

/** Clear stored tokens for a provider */
export async function clearTokens(provider: string): Promise<void> {
  await deleteSecret(`${TOKEN_ACCOUNT_PREFIX}${provider}`);
  await deleteSecret(`${REFRESH_ACCOUNT_PREFIX}${provider}`);
}

// ── Anthropic OAuth → API Key ──

/**
 * Complete the Anthropic OAuth flow:
 * 1. Run PKCE OAuth flow via browser
 * 2. Use the obtained token to create a permanent API key
 * Returns the permanent API key string.
 */
export async function anthropicOAuthLogin(opts?: {
  onAuthUrl?: (url: string) => void;
  onWaitingForCode?: () => void;
}): Promise<string> {
  const providerConfig = PROVIDER_CONFIGS.anthropic!;
  const config = resolveProviderConfig("anthropic")!;

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Anthropic uses their own console callback — not a local server
  const redirectUri = config.redirectUri ?? `http://127.0.0.1:${config.redirectPort}/callback`;

  const authUrl = buildAuthUrl(config, codeChallenge, state);
  opts?.onAuthUrl?.(authUrl);
  await openBrowser(authUrl);

  let code: string;

  if (config.redirectUri) {
    // Manual code paste flow: Anthropic redirects to their console page
    // which displays the authorization code for the user to copy
    opts?.onWaitingForCode?.();
    code = await waitForManualCode();
  } else {
    // Local callback server flow
    code = await waitForCallback(config.redirectPort, state);
  }

  // Exchange code for token
  const tokens = await exchangeCode(config, code, codeVerifier, redirectUri);

  // Use the token to create a permanent API key
  const apiKey = await createAnthropicApiKey(tokens.accessToken);
  return apiKey;
}

/** Wait for the user to paste the authorization code from the browser */
async function waitForManualCode(): Promise<string> {
  const { createInterface } = await import("node:readline");
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        rl.close();
        reject(new Error("Timed out waiting for authorization code (5 minutes)"));
      },
      5 * 60 * 1000,
    );

    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question("\n  Paste the authorization code from the browser: ", (answer) => {
      clearTimeout(timeout);
      rl.close();
      const code = answer.trim();
      if (!code) {
        reject(new Error("No authorization code provided"));
      } else {
        resolve(code);
      }
    });
  });
}

/** Use Anthropic OAuth token to create a permanent API key */
async function createAnthropicApiKey(accessToken: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/api/oauth/claude_cli/create_api_key", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "KCode CLI" }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create Anthropic API key (${response.status}): ${text}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const apiKey = data.api_key as string;
  if (!apiKey) {
    throw new Error("Anthropic OAuth response did not contain an API key");
  }
  return apiKey;
}

// ── Generic provider login ──

/**
 * Login to any supported OAuth provider.
 * - For Anthropic: runs OAuth → creates permanent API key → stores in keychain
 * - For OpenAI Codex / Gemini: runs OAuth → stores access + refresh tokens
 * Returns { provider, method: "oauth" | "api_key", key?: string }
 */
export async function loginProvider(
  providerName: string,
  opts?: { onAuthUrl?: (url: string) => void },
): Promise<{
  provider: string;
  method: "oauth" | "api_key";
  key?: string;
}> {
  const config = resolveProviderConfig(providerName);
  if (!config) {
    throw new Error(
      `Unknown OAuth provider: "${providerName}". Supported: ${getOAuthProviderNames().join(", ")}`,
    );
  }

  if (config.exchangeForApiKey) {
    // Anthropic flow: OAuth → permanent API key
    const apiKey = await anthropicOAuthLogin({ onAuthUrl: opts?.onAuthUrl });
    await migrateApiKey(providerName, apiKey);
    return { provider: providerName, method: "api_key", key: apiKey };
  }

  // Standard OAuth flow: store access + refresh tokens
  const result = await startOAuthFlow(config, { onAuthUrl: opts?.onAuthUrl });
  return { provider: providerName, method: "oauth" };
}

/**
 * Get provider auth status: checks OAuth tokens first, then API key.
 */
export async function getProviderAuthStatus(providerName: string): Promise<{
  provider: string;
  label: string;
  authenticated: boolean;
  method: "oauth" | "api_key" | "env" | "claude-code" | "none";
  expiresAt?: number;
  detail?: string;
}> {
  const partial = PROVIDER_CONFIGS[providerName];
  const label = partial?.label ?? providerName;

  // Check CLI bridges first (Claude Code for Anthropic, Codex for OpenAI)
  if (providerName === "anthropic") {
    try {
      const { isClaudeCodeAuthenticated, getClaudeCodeAuthInfo } = await import(
        "./claude-code-bridge.js"
      );
      if (isClaudeCodeAuthenticated()) {
        const info = getClaudeCodeAuthInfo();
        return {
          provider: providerName,
          label,
          authenticated: true,
          method: "claude-code",
          expiresAt: info.expiresAt,
          detail: info.subscriptionType ? `${info.subscriptionType} plan` : undefined,
        };
      }
    } catch {
      /* not available */
    }
  }

  if (providerName === "openai-codex") {
    try {
      const { isCodexAuthenticated, getCodexAuthInfo } = await import("./claude-code-bridge.js");
      if (isCodexAuthenticated()) {
        const info = getCodexAuthInfo();
        return {
          provider: providerName,
          label,
          authenticated: true,
          method: "claude-code" as const,
          detail: info.authMode === "chatgpt" ? "ChatGPT subscription" : info.authMode,
        };
      }
    } catch {
      /* not available */
    }
  }

  // Check OAuth tokens
  const tokens = await getStoredTokens(providerName);
  if (tokens) {
    return {
      provider: providerName,
      label,
      authenticated: !isTokenExpired(tokens),
      method: "oauth",
      expiresAt: tokens.expiresAt,
    };
  }

  // Check keychain API key
  const apiKey = await getApiKey(providerName);
  if (apiKey) {
    return { provider: providerName, label, authenticated: true, method: "api_key" };
  }

  // Check env var
  const envMap: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    "openai-codex": "OPENAI_API_KEY",
    gemini: "GEMINI_API_KEY",
  };
  const envVar = envMap[providerName];
  if (envVar && process.env[envVar]) {
    return { provider: providerName, label, authenticated: true, method: "env" };
  }

  return { provider: providerName, label, authenticated: false, method: "none" };
}

// ── API key migration ──

/** Migrate a plaintext API key to keychain storage */
export async function migrateApiKey(provider: string, apiKey: string): Promise<boolean> {
  return setSecret(`apikey-${provider}`, apiKey);
}

/** Retrieve an API key from keychain */
export async function getApiKey(provider: string): Promise<string | null> {
  return getSecret(`apikey-${provider}`);
}

// Re-export PKCE helpers for testing
export { generateCodeChallenge, generateCodeVerifier, generateState };
