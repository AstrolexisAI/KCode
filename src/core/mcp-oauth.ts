// KCode - MCP OAuth 2.0 Client
// Implements OAuth 2.0 Authorization Code flow with PKCE for MCP server authentication.
// Supports: authorization URL generation, callback handling, token storage/refresh.

import { randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { createServer, type Server } from "node:http";
import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export interface OAuthConfig {
  /** OAuth 2.0 client ID */
  clientId: string;
  /** OAuth 2.0 client secret (optional for public clients) */
  clientSecret?: string;
  /** Authorization endpoint URL */
  authorizationUrl: string;
  /** Token endpoint URL */
  tokenUrl: string;
  /** Scopes to request */
  scopes?: string[];
  /** Redirect URI (default: http://localhost with dynamic port) */
  redirectUri?: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: string;
  scope?: string;
}

interface TokenStorageEntry {
  serverName: string;
  tokens: OAuthTokens;
  config: { clientId: string; tokenUrl: string };
}

// ─── PKCE Helpers ────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return randomBytes(16).toString("hex");
}

// ─── Token Storage ───────────────────────────────────────────────

const TOKEN_FILE = join(homedir(), ".kcode", "mcp-tokens.json");

async function loadTokenStore(): Promise<Map<string, TokenStorageEntry>> {
  const store = new Map<string, TokenStorageEntry>();
  try {
    const file = Bun.file(TOKEN_FILE);
    if (await file.exists()) {
      const data = await file.json() as Record<string, TokenStorageEntry>;
      for (const [key, entry] of Object.entries(data)) {
        if (entry?.tokens?.accessToken) {
          store.set(key, entry);
        }
      }
    }
  } catch {
    // No stored tokens or corrupt file
  }
  return store;
}

async function saveTokenStore(store: Map<string, TokenStorageEntry>): Promise<void> {
  const data: Record<string, TokenStorageEntry> = {};
  for (const [key, entry] of store) {
    data[key] = entry;
  }
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(homedir(), ".kcode"), { recursive: true });
  await Bun.write(TOKEN_FILE, JSON.stringify(data, null, 2), { mode: 0o600 } as never);
}

// ─── OAuth Flow ──────────────────────────────────────────────────

export class McpOAuthClient {
  private config: OAuthConfig;
  private serverName: string;
  private codeVerifier: string | null = null;

  constructor(serverName: string, config: OAuthConfig) {
    this.serverName = serverName;
    this.config = config;
  }

  /**
   * Get stored tokens for this server (if any, and if not expired).
   */
  async getStoredTokens(): Promise<OAuthTokens | null> {
    const store = await loadTokenStore();
    const entry = store.get(this.serverName);
    if (!entry) return null;

    // Check expiry (with 60s buffer)
    if (entry.tokens.expiresAt && Date.now() >= entry.tokens.expiresAt - 60_000) {
      // Try refresh
      if (entry.tokens.refreshToken) {
        try {
          const refreshed = await this.refreshTokens(entry.tokens.refreshToken);
          await this.storeTokens(refreshed);
          return refreshed;
        } catch (err) {
          log.warn("mcp-oauth", `Token refresh failed for "${this.serverName}": ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }
      return null;
    }

    return entry.tokens;
  }

  /**
   * Store tokens for this server.
   */
  async storeTokens(tokens: OAuthTokens): Promise<void> {
    const store = await loadTokenStore();
    store.set(this.serverName, {
      serverName: this.serverName,
      tokens,
      config: {
        clientId: this.config.clientId,
        tokenUrl: this.config.tokenUrl,
      },
    });
    await saveTokenStore(store);
  }

  /**
   * Remove stored tokens for this server.
   */
  async clearTokens(): Promise<void> {
    const store = await loadTokenStore();
    store.delete(this.serverName);
    await saveTokenStore(store);
  }

  /**
   * Build the authorization URL for the OAuth flow.
   * Returns the URL and the local callback server port.
   */
  async startAuthFlow(): Promise<{ url: string; port: number; waitForCallback: () => Promise<OAuthTokens> }> {
    // Use local variables for PKCE to support concurrent flows safely
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();
    // Store for exchangeCode — last-wins is acceptable for single-user CLI
    this.codeVerifier = codeVerifier;

    // Start a local HTTP server to receive the callback
    const { server, port } = await startCallbackServer();
    const redirectUri = this.config.redirectUri ?? `http://localhost:${port}/callback`;

    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    if (this.config.scopes && this.config.scopes.length > 0) {
      params.set("scope", this.config.scopes.join(" "));
    }

    const authUrl = `${this.config.authorizationUrl}?${params.toString()}`;

    const waitForCallback = (): Promise<OAuthTokens> => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          server.close();
          reject(new Error("OAuth callback timed out after 5 minutes"));
        }, 5 * 60 * 1000);

        (server as Server & { _oauthResolve?: (code: string) => void }).on("request", async (req, res) => {
          const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);

          if (reqUrl.pathname === "/callback") {
            const code = reqUrl.searchParams.get("code");
            const returnedState = reqUrl.searchParams.get("state");
            const error = reqUrl.searchParams.get("error");

            if (error) {
              const safeError = String(error).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
              res.writeHead(400, { "Content-Type": "text/html" });
              res.end(`<html><body><h2>OAuth Error</h2><p>${safeError}</p></body></html>`);
              clearTimeout(timeout);
              server.close();
              reject(new Error(`OAuth error: ${error}`));
              return;
            }

            if (!code || returnedState !== state) {
              res.writeHead(400, { "Content-Type": "text/html" });
              res.end("<html><body><h2>Invalid callback</h2><p>State mismatch or missing authorization code.</p></body></html>");
              clearTimeout(timeout);
              server.close();
              reject(new Error("Invalid OAuth callback: state mismatch or missing authorization code"));
              return;
            }

            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<html><body><h2>Authorization successful!</h2><p>You can close this tab and return to KCode.</p></body></html>");

            clearTimeout(timeout);
            server.close();

            try {
              const tokens = await this.exchangeCode(code, redirectUri);
              await this.storeTokens(tokens);
              resolve(tokens);
            } catch (err) {
              reject(err);
            }
          }
        });
      });
    };

    return { url: authUrl, port, waitForCallback };
  }

  /**
   * Exchange an authorization code for tokens.
   */
  private async exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens> {
    if (!this.codeVerifier) {
      throw new Error("No code verifier available — startAuthFlow must be called first");
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: this.config.clientId,
      code_verifier: this.codeVerifier,
    });

    if (this.config.clientSecret) {
      body.set("client_secret", this.config.clientSecret);
    }

    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Token exchange failed: HTTP ${response.status} — ${errorText}`);
    }

    const data = await response.json() as Record<string, unknown>;
    return this.parseTokenResponse(data);
  }

  /**
   * Refresh an expired access token.
   */
  private async refreshTokens(refreshToken: string): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.clientId,
    });

    if (this.config.clientSecret) {
      body.set("client_secret", this.config.clientSecret);
    }

    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`Token refresh failed: HTTP ${response.status}`);
    }

    const data = await response.json() as Record<string, unknown>;
    const tokens = this.parseTokenResponse(data);
    // Preserve the refresh token if the server didn't return a new one
    if (!tokens.refreshToken) {
      tokens.refreshToken = refreshToken;
    }
    return tokens;
  }

  private parseTokenResponse(data: Record<string, unknown>): OAuthTokens {
    const accessToken = data.access_token;
    if (typeof accessToken !== "string" || !accessToken) {
      throw new Error("Token response missing access_token");
    }

    const tokens: OAuthTokens = {
      accessToken,
      tokenType: typeof data.token_type === "string" ? data.token_type : "Bearer",
    };

    if (typeof data.refresh_token === "string") {
      tokens.refreshToken = data.refresh_token;
    }

    if (typeof data.expires_in === "number") {
      tokens.expiresAt = Date.now() + data.expires_in * 1000;
    }

    if (typeof data.scope === "string") {
      tokens.scope = data.scope;
    }

    return tokens;
  }
}

// ─── Callback Server ─────────────────────────────────────────────

function startCallbackServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    // Listen on dynamic port (0 = OS picks a free port)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to start callback server"));
        return;
      }
      log.info("mcp-oauth", `OAuth callback server listening on port ${addr.port}`);
      resolve({ server, port: addr.port });
    });
    server.on("error", (err) => {
      reject(err);
    });
  });
}

// ─── MCP OAuth Discovery ────────────────────────────────────────

/**
 * Discover OAuth configuration from an MCP server's well-known endpoint.
 * Per the MCP spec, servers may expose /.well-known/oauth-authorization-server
 */
export async function discoverOAuthConfig(serverUrl: string): Promise<OAuthConfig | null> {
  try {
    const url = new URL(serverUrl);
    const wellKnownUrl = `${url.origin}/.well-known/oauth-authorization-server`;

    const response = await fetch(wellKnownUrl, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;

    const data = await response.json() as Record<string, unknown>;

    const authorizationUrl = data.authorization_endpoint;
    const tokenUrl = data.token_endpoint;

    if (typeof authorizationUrl !== "string" || typeof tokenUrl !== "string") {
      return null;
    }

    return {
      clientId: "", // Must be configured by user
      authorizationUrl,
      tokenUrl,
      scopes: Array.isArray(data.scopes_supported) ? data.scopes_supported as string[] : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Try to get a valid access token for an MCP server.
 * Returns null if no OAuth is configured or tokens are unavailable.
 */
export async function getAccessToken(serverName: string, oauthConfig?: OAuthConfig): Promise<string | null> {
  if (!oauthConfig) return null;

  const client = new McpOAuthClient(serverName, oauthConfig);
  const tokens = await client.getStoredTokens();
  return tokens?.accessToken ?? null;
}
