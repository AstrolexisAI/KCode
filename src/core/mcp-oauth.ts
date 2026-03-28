// KCode - MCP OAuth 2.0 Client
// Implements OAuth 2.0 Authorization Code flow with PKCE for MCP server authentication.
// Supports: authorization URL generation, callback handling, token storage/refresh,
// token encryption, browser-based auth flow, and token revocation.

import { randomBytes, createHash, createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { createServer, type Server } from "node:http";
import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export interface OAuthConfig {
  clientId: string;
  clientSecret?: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes?: string[];
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
  tokens: EncryptedTokens | OAuthTokens;
  config: { clientId: string; tokenUrl: string };
  encrypted?: boolean;
}

interface EncryptedTokens {
  iv: string;
  data: string;
  tag: string;
}

const DEFAULT_CALLBACK_PORT = 19876;
const DEFAULT_REDIRECT_URI = `http://localhost:${DEFAULT_CALLBACK_PORT}/callback`;

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

// ─── Encryption ─────────────────────────────────────────────────

// Persistent random salt for key derivation — NOT guessable from public info
const OAUTH_SALT_FILE = join(homedir(), ".kcode", ".oauth-key-salt");

function getOrCreateOAuthSalt(): string {
  try {
    const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
    if (existsSync(OAUTH_SALT_FILE)) {
      return readFileSync(OAUTH_SALT_FILE, "utf-8").trim();
    }
    const salt = randomBytes(32).toString("hex");
    mkdirSync(join(homedir(), ".kcode"), { recursive: true });
    writeFileSync(OAUTH_SALT_FILE, salt + "\n", { mode: 0o600 });
    return salt;
  } catch (err) {
    log.debug("mcp-oauth", "Failed to read/write OAuth salt file: " + err);
    // Fallback: use a hash of machine-specific data plus randomness (less secure but functional)
    const { hostname } = require("node:os") as typeof import("node:os");
    return createHash("sha256")
      .update(`${homedir()}:${process.env.USER ?? "kcode"}:${hostname()}:${process.getuid?.() ?? 0}:${Date.now()}`)
      .digest("hex");
  }
}

let _oauthEncKey: Buffer | null = null;

function deriveEncryptionKey(): Buffer {
  if (_oauthEncKey) return _oauthEncKey;
  const salt = getOrCreateOAuthSalt();
  // Include hostname and uid for additional entropy beyond homedir/user
  const { hostname } = require("node:os") as typeof import("node:os");
  const material = `${homedir()}:${process.env.USER ?? "kcode"}:${hostname()}:${process.getuid?.() ?? 0}:mcp-oauth-enc`;
  _oauthEncKey = pbkdf2Sync(material, salt, 100_000, 32, "sha256");
  return _oauthEncKey;
}

function encryptTokens(tokens: OAuthTokens): EncryptedTokens {
  const key = deriveEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(tokens);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    data: encrypted.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decryptTokens(encrypted: EncryptedTokens): OAuthTokens {
  const key = deriveEncryptionKey();
  const iv = Buffer.from(encrypted.iv, "base64");
  const data = Buffer.from(encrypted.data, "base64");
  const tag = Buffer.from(encrypted.tag, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

// ─── Token Storage ───────────────────────────────────────────────

const TOKEN_FILE = join(homedir(), ".kcode", "oauth-tokens.json");
const LEGACY_TOKEN_FILE = join(homedir(), ".kcode", "mcp-tokens.json");

async function loadTokenStore(): Promise<Map<string, TokenStorageEntry>> {
  const store = new Map<string, TokenStorageEntry>();

  // Try new file first, then legacy
  for (const path of [TOKEN_FILE, LEGACY_TOKEN_FILE]) {
    try {
      const file = Bun.file(path);
      if (await file.exists()) {
        const data = await file.json() as Record<string, TokenStorageEntry>;
        for (const [key, entry] of Object.entries(data)) {
          if (store.has(key)) continue;
          if (entry?.encrypted) {
            try {
              const tokens = decryptTokens(entry.tokens as EncryptedTokens);
              if (tokens.accessToken) {
                store.set(key, { ...entry, tokens });
              }
            } catch (err) {
              log.debug("mcp-oauth", "Token decryption failed for key " + key + ": " + err);
            }
          } else {
            const tokens = entry?.tokens as OAuthTokens;
            if (tokens?.accessToken) {
              store.set(key, entry);
            }
          }
        }
        break;
      }
    } catch (err) {
      log.debug("mcp-oauth", "Failed to load stored OAuth tokens: " + err);
    }
  }
  return store;
}

async function saveTokenStore(store: Map<string, TokenStorageEntry>): Promise<void> {
  const data: Record<string, TokenStorageEntry> = {};
  for (const [key, entry] of store) {
    data[key] = {
      ...entry,
      tokens: encryptTokens(entry.tokens as OAuthTokens),
      encrypted: true,
    };
  }
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(homedir(), ".kcode"), { recursive: true });
  await Bun.write(TOKEN_FILE, JSON.stringify(data, null, 2), { mode: 0o600 } as never);
}

// ─── Browser Opening ─────────────────────────────────────────────

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("bun");
  const os = platform();
  let cmd: string[];
  if (os === "darwin") {
    cmd = ["open", url];
  } else if (os === "win32") {
    cmd = ["cmd", "/c", "start", url];
  } else {
    cmd = ["xdg-open", url];
  }
  try {
    const proc = spawn({ cmd, stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  } catch (err) {
    log.warn("mcp-oauth", `Could not open browser automatically (${err}). Visit: ${url}`);
  }
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

  async getStoredTokens(): Promise<OAuthTokens | null> {
    const store = await loadTokenStore();
    const entry = store.get(this.serverName);
    if (!entry) return null;

    const tokens = entry.tokens as OAuthTokens;

    if (tokens.expiresAt && Date.now() >= tokens.expiresAt - 60_000) {
      if (tokens.refreshToken) {
        try {
          const refreshed = await this.refreshTokens(tokens.refreshToken);
          await this.storeTokens(refreshed);
          return refreshed;
        } catch (err) {
          log.warn("mcp-oauth", `Token refresh failed for "${this.serverName}": ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }
      return null;
    }

    return tokens;
  }

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

  async clearTokens(): Promise<void> {
    const store = await loadTokenStore();
    store.delete(this.serverName);
    await saveTokenStore(store);
  }

  async startAuthFlow(): Promise<{ url: string; port: number; waitForCallback: () => Promise<OAuthTokens> }> {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();
    this.codeVerifier = codeVerifier;

    const { server, port } = await startCallbackServer(
      this.config.redirectUri ? undefined : DEFAULT_CALLBACK_PORT
    );
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

  async refreshTokens(refreshToken: string): Promise<OAuthTokens> {
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

// ─── McpOAuthManager ─────────────────────────────────────────────

export class McpOAuthManager {
  private tokenStorePath: string;

  constructor(tokenStorePath: string = TOKEN_FILE) {
    this.tokenStorePath = tokenStorePath;
  }

  async authorize(serverName: string, config: OAuthConfig): Promise<OAuthTokens> {
    const client = new McpOAuthClient(serverName, {
      ...config,
      redirectUri: config.redirectUri ?? DEFAULT_REDIRECT_URI,
    });

    const { url, waitForCallback } = await client.startAuthFlow();
    log.info("mcp-oauth", `Opening browser for "${serverName}" OAuth authorization...`);
    await openBrowser(url);

    return waitForCallback();
  }

  async getToken(serverName: string): Promise<string | null> {
    const store = await loadTokenStore();
    const entry = store.get(serverName);
    if (!entry) return null;

    const tokens = entry.tokens as OAuthTokens;

    if (tokens.expiresAt && Date.now() >= tokens.expiresAt - 60_000) {
      if (tokens.refreshToken && entry.config) {
        try {
          const client = new McpOAuthClient(serverName, {
            clientId: entry.config.clientId,
            authorizationUrl: "",
            tokenUrl: entry.config.tokenUrl,
          });
          const refreshed = await client.refreshTokens(tokens.refreshToken);
          await client.storeTokens(refreshed);
          return refreshed.accessToken;
        } catch (err) {
          log.warn("mcp-oauth", "Token refresh failed for server: " + err);
          return null;
        }
      }
      return null;
    }

    return tokens.accessToken;
  }

  async refreshToken(serverName: string, config: OAuthConfig): Promise<OAuthTokens> {
    const store = await loadTokenStore();
    const entry = store.get(serverName);
    if (!entry) {
      throw new Error(`No stored tokens for server "${serverName}"`);
    }

    const tokens = entry.tokens as OAuthTokens;
    if (!tokens.refreshToken) {
      throw new Error(`No refresh token available for server "${serverName}"`);
    }

    const client = new McpOAuthClient(serverName, config);
    const refreshed = await client.refreshTokens(tokens.refreshToken);
    await client.storeTokens(refreshed);
    return refreshed;
  }

  async revokeToken(serverName: string): Promise<void> {
    const client = new McpOAuthClient(serverName, {
      clientId: "",
      authorizationUrl: "",
      tokenUrl: "",
    });
    await client.clearTokens();
    log.info("mcp-oauth", `Revoked tokens for "${serverName}"`);
  }

  async isAuthenticated(serverName: string): Promise<boolean> {
    const token = await this.getToken(serverName);
    return token !== null;
  }
}

// ─── Callback Server ─────────────────────────────────────────────

function startCallbackServer(preferredPort?: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const port = preferredPort ?? 0;

    const tryListen = (p: number) => {
      server.listen(p, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          server.close();
          reject(new Error("Failed to start callback server"));
          return;
        }
        log.info("mcp-oauth", `OAuth callback server listening on port ${addr.port}`);
        resolve({ server, port: addr.port });
      });
    };

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && preferredPort) {
        log.warn("mcp-oauth", `Port ${preferredPort} in use, falling back to dynamic port`);
        server.removeAllListeners("error");
        server.on("error", reject);
        tryListen(0);
      } else {
        reject(err);
      }
    });

    tryListen(port);
  });
}

// ─── MCP OAuth Discovery ────────────────────────────────────────

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
      clientId: "",
      authorizationUrl,
      tokenUrl,
      scopes: Array.isArray(data.scopes_supported) ? data.scopes_supported as string[] : undefined,
    };
  } catch (err) {
    log.debug("mcp-oauth", "OAuth auto-discovery failed: " + err);
    return null;
  }
}

export async function getAccessToken(serverName: string, oauthConfig?: OAuthConfig): Promise<string | null> {
  if (!oauthConfig) return null;

  const client = new McpOAuthClient(serverName, oauthConfig);
  const tokens = await client.getStoredTokens();
  return tokens?.accessToken ?? null;
}
