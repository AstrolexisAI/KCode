// KCode - OAuth2 PKCE Flow
// Full OAuth2 Authorization Code flow with PKCE for secure CLI authentication.
// Supports Kulvex Console, GitHub, and custom enterprise IdP.

import { log } from "../../core/logger";
import type { OAuthConfig, OAuthTokens } from "../types";
import { clearTokens, loadTokens, saveTokens } from "./token-store";

// ─── Constants ──────────────────────────────────────────────────

const PORT_RANGE_START = 19000;
const PORT_RANGE_END = 19999;
const FLOW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const REFRESH_LOCK_TIMEOUT_MS = 10_000;
const TOKEN_EXPIRY_BUFFER_MS = 60_000; // Refresh 60s before expiry

// ─── State ──────────────────────────────────────────────────────

let _refreshLock: Promise<OAuthTokens | null> | null = null;

// ─── PKCE Helpers ───────────────────────────────────────────────

/**
 * Generate a cryptographically random base64url string.
 */
function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(buffer: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generate PKCE code verifier (128 random bytes, base64url encoded).
 */
export function generateCodeVerifier(): string {
  return randomBase64Url(96); // 96 bytes -> 128 chars base64url
}

/**
 * Generate PKCE code challenge (SHA256 of verifier, base64url encoded).
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

/**
 * Generate a CSRF state parameter.
 */
export function generateState(): string {
  return randomBase64Url(32);
}

// ─── Port Discovery ─────────────────────────────────────────────

async function findAvailablePort(): Promise<number> {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    try {
      // Try to listen on the port briefly to check availability
      const server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch() {
          return new Response("");
        },
      });
      server.stop(true);
      return port;
    } catch {
      // Port already in use — try next port. Intentionally silent, expected during scan.
    }
  }
  throw new Error(`No available port found in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
}

// ─── OAuth Flow ─────────────────────────────────────────────────

/**
 * Start the full OAuth2 PKCE authorization flow.
 * 1. Generate PKCE verifier/challenge and state
 * 2. Open browser with authorization URL
 * 3. Start temporary HTTP server to receive callback
 * 4. Exchange authorization code for tokens
 * 5. Store tokens securely
 *
 * @returns The obtained tokens, or null if the flow was cancelled/timed out
 */
export async function startOAuthFlow(config: OAuthConfig): Promise<OAuthTokens | null> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  const port = await findAvailablePort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // Build authorization URL
  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  const authUrl = `${config.authUrl}?${authParams.toString()}`;

  // Open browser — unless KCODE_OAUTH_NO_BROWSER=1 is set, which tests
  // (and headless CI) use to prevent this function from spawning xdg-open
  // and flashing a real browser window on the user's desktop. The
  // fallback path below prints the URL to stderr, so manual flows still
  // work in that mode.
  if (process.env.KCODE_OAUTH_NO_BROWSER === "1") {
    log.info("oauth", `KCODE_OAUTH_NO_BROWSER=1 — not opening browser. URL:\n${authUrl}`);
  } else {
    try {
      const openCmd =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "start"
            : "xdg-open";
      Bun.spawn([openCmd, authUrl], { stdout: "ignore", stderr: "ignore" });
    } catch (err) {
      log.warn("config", `Failed to open browser for OAuth: ${err}`);
      console.error(`Please open this URL in your browser:\n${authUrl}`);
    }
  }

  // Wait for callback
  const authCode = await waitForCallback(port, state);
  if (!authCode) return null;

  // Exchange code for tokens
  const tokens = await exchangeCodeForTokens(config, authCode, codeVerifier, redirectUri);
  if (!tokens) return null;

  // Compute absolute expiry time
  tokens.expires_at = Date.now() + tokens.expires_in * 1000;

  // Store tokens
  await saveTokens(tokens);

  return tokens;
}

/**
 * Start a temporary HTTP server and wait for the OAuth callback.
 * Returns the authorization code, or null on timeout/error.
 */
async function waitForCallback(port: number, expectedState: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let resolved = false;
    let server: ReturnType<typeof Bun.serve> | null = null;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        server?.stop(true);
        log.warn("config", "OAuth flow timed out after 5 minutes");
        resolve(null);
      }
    }, FLOW_TIMEOUT_MS);

    server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname !== "/callback") {
          return new Response("Not found", { status: 404 });
        }

        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          const desc = url.searchParams.get("error_description") ?? error;
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            setTimeout(() => server?.stop(true), 500);
            log.warn("config", `OAuth error: ${desc}`);
            resolve(null);
          }
          return new Response(
            `<html><body><h1>Authentication Failed</h1><p>${desc}</p><p>You can close this window.</p></body></html>`,
            { headers: { "Content-Type": "text/html" } },
          );
        }

        // Validate state (CSRF protection)
        if (returnedState !== expectedState) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            setTimeout(() => server?.stop(true), 500);
            log.warn("config", "OAuth state mismatch - possible CSRF attack");
            resolve(null);
          }
          return new Response(
            `<html><body><h1>Authentication Failed</h1><p>State parameter mismatch.</p></body></html>`,
            { headers: { "Content-Type": "text/html" } },
          );
        }

        if (!code) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            setTimeout(() => server?.stop(true), 500);
            resolve(null);
          }
          return new Response(
            `<html><body><h1>Authentication Failed</h1><p>No authorization code received.</p></body></html>`,
            { headers: { "Content-Type": "text/html" } },
          );
        }

        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          setTimeout(() => server?.stop(true), 500);
          resolve(code);
        }

        return new Response(
          `<html><body><h1>Authentication Successful</h1><p>You can close this window and return to the terminal.</p></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
  });
}

/**
 * Exchange an authorization code for tokens via the token endpoint.
 */
async function exchangeCodeForTokens(
  config: OAuthConfig,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<OAuthTokens | null> {
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      code_verifier: codeVerifier,
    });

    const resp = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => `HTTP ${resp.status}`);
      log.warn("config", `OAuth token exchange failed: ${errText}`);
      return null;
    }

    const tokens = (await resp.json()) as OAuthTokens;
    if (!tokens.access_token) {
      log.warn("config", "OAuth token response missing access_token");
      return null;
    }

    return tokens;
  } catch (err) {
    log.warn("config", `OAuth token exchange error: ${err}`);
    return null;
  }
}

// ─── Token Refresh ──────────────────────────────────────────────

/**
 * Refresh the access token using the refresh token.
 * Uses a lock to prevent concurrent refresh attempts.
 */
export async function refreshToken(config: OAuthConfig): Promise<OAuthTokens | null> {
  // If a refresh is already in progress, wait for it
  if (_refreshLock) {
    try {
      const result = await Promise.race([
        _refreshLock,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), REFRESH_LOCK_TIMEOUT_MS)),
      ]);
      return result;
    } catch {
      return null;
    }
  }

  const doRefresh = async (): Promise<OAuthTokens | null> => {
    try {
      const stored = await loadTokens();
      if (!stored?.refresh_token) {
        log.warn("config", "No refresh token available, re-login required");
        return null;
      }

      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: stored.refresh_token,
        client_id: config.clientId,
      });

      const resp = await fetch(config.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (resp.status === 401) {
        log.warn("config", "Refresh token is invalid, clearing tokens");
        await clearTokens();
        return null;
      }

      if (!resp.ok) {
        log.warn("config", `Token refresh failed: HTTP ${resp.status}`);
        return null;
      }

      const tokens = (await resp.json()) as OAuthTokens;
      if (!tokens.access_token) {
        log.warn("config", "Refresh response missing access_token");
        return null;
      }

      tokens.expires_at = Date.now() + tokens.expires_in * 1000;
      // Preserve refresh token if new one not provided
      if (!tokens.refresh_token && stored.refresh_token) {
        tokens.refresh_token = stored.refresh_token;
      }

      await saveTokens(tokens);
      return tokens;
    } catch (err) {
      log.warn("config", `Token refresh error: ${err}`);
      return null;
    } finally {
      _refreshLock = null;
    }
  };

  _refreshLock = doRefresh();
  return _refreshLock;
}

// ─── Token Access ───────────────────────────────────────────────

/**
 * Get a valid access token, refreshing if necessary.
 * Returns null if no tokens are available or refresh fails.
 */
export async function getAccessToken(config: OAuthConfig): Promise<string | null> {
  const stored = await loadTokens();
  if (!stored) return null;

  // Check if token is expired (with buffer)
  if (stored.expires_at && stored.expires_at < Date.now() - TOKEN_EXPIRY_BUFFER_MS) {
    const refreshed = await refreshToken(config);
    return refreshed?.access_token ?? null;
  }

  return stored.access_token;
}
