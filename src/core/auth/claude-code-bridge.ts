// CLI Auth Bridge — Reuse existing authentication from Claude Code and OpenAI Codex.
// Reads credentials from:
//   - Claude Code: ~/.claude/.credentials.json
//   - OpenAI Codex: ~/.codex/auth.json
// and provides them to KCode's request pipeline.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger";

// ─── Paths ──────────────────────────────────────────────────────

const CLAUDE_CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");

// ─── Token refresh endpoints ────────────────────────────────────

const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

// ─── Types ──────────────────────────────────────────────────────

interface ClaudeCodeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

interface CodexCredentials {
  auth_mode?: string;
  tokens?: {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

// ─── Cache ──────────────────────────────────────────────────────

const CACHE_TTL = 30_000;

let _claudeCache: ClaudeCodeCredentials | null = null;
let _claudeCacheTime = 0;

let _codexCache: CodexCredentials | null = null;
let _codexCacheTime = 0;

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function getCachedClaude(): ClaudeCodeCredentials | null {
  if (_claudeCache && Date.now() - _claudeCacheTime < CACHE_TTL) return _claudeCache;
  _claudeCache = readJsonFile<ClaudeCodeCredentials>(CLAUDE_CREDENTIALS_PATH);
  _claudeCacheTime = Date.now();
  return _claudeCache;
}

function getCachedCodex(): CodexCredentials | null {
  if (_codexCache && Date.now() - _codexCacheTime < CACHE_TTL) return _codexCache;
  _codexCache = readJsonFile<CodexCredentials>(CODEX_AUTH_PATH);
  _codexCacheTime = Date.now();
  return _codexCache;
}

// ─── Claude Code (Anthropic) ────────────────────────────────────

export function isClaudeCodeAuthenticated(): boolean {
  return !!getCachedClaude()?.claudeAiOauth?.accessToken;
}

export function getClaudeCodeAuthInfo(): {
  authenticated: boolean;
  subscriptionType?: string;
  expiresAt?: number;
  scopes?: string[];
} {
  const creds = getCachedClaude();
  if (!creds?.claudeAiOauth) return { authenticated: false };
  return {
    authenticated: true,
    subscriptionType: creds.claudeAiOauth.subscriptionType,
    expiresAt: creds.claudeAiOauth.expiresAt,
    scopes: creds.claudeAiOauth.scopes,
  };
}

/**
 * Get a valid Anthropic access token from Claude Code credentials.
 * Auto-refreshes if expired, writes refreshed token back to disk.
 */
export async function getClaudeCodeToken(): Promise<string | null> {
  const creds = getCachedClaude();
  if (!creds?.claudeAiOauth) return null;

  const { accessToken, refreshToken, expiresAt } = creds.claudeAiOauth;

  if (Date.now() < expiresAt - 60_000) return accessToken;

  if (!refreshToken) {
    log.debug("claude-bridge", "Claude Code token expired, no refresh token");
    return null;
  }

  log.debug("claude-bridge", "Claude Code token expired, refreshing...");

  try {
    const response = await fetch(ANTHROPIC_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: ANTHROPIC_CLIENT_ID,
      }),
    });

    if (!response.ok) {
      log.debug("claude-bridge", `Claude Code token refresh failed (${response.status})`);
      return null;
    }

    const data = (await response.json()) as Record<string, unknown>;
    const newToken = data.access_token as string;
    creds.claudeAiOauth.accessToken = newToken;
    creds.claudeAiOauth.refreshToken = (data.refresh_token as string) ?? refreshToken;
    creds.claudeAiOauth.expiresAt = data.expires_in
      ? Date.now() + (data.expires_in as number) * 1000
      : expiresAt;

    try {
      writeFileSync(CLAUDE_CREDENTIALS_PATH, JSON.stringify(creds), { mode: 0o600 });
      _claudeCache = null;
      _claudeCacheTime = 0;
    } catch (err) {
      log.debug("claude-bridge", `Failed to persist Claude Code token: ${err}`);
    }

    return newToken;
  } catch (err) {
    log.debug("claude-bridge", `Claude Code refresh error: ${err}`);
    return null;
  }
}

// ─── OpenAI Codex ───────────────────────────────────────────────

export function isCodexAuthenticated(): boolean {
  const creds = getCachedCodex();
  return !!creds?.tokens?.access_token;
}

export function getCodexAuthInfo(): {
  authenticated: boolean;
  authMode?: string;
  accountId?: string;
} {
  const creds = getCachedCodex();
  if (!creds?.tokens?.access_token) return { authenticated: false };
  return {
    authenticated: true,
    authMode: creds.auth_mode,
    accountId: creds.tokens.account_id,
  };
}

/**
 * Get a valid OpenAI access token from Codex CLI credentials.
 * Auto-refreshes if expired, writes refreshed token back to disk.
 */
export async function getCodexToken(): Promise<string | null> {
  const creds = getCachedCodex();
  if (!creds?.tokens?.access_token) return null;

  const { access_token, refresh_token } = creds.tokens;

  // Check if JWT is expired by decoding the payload
  try {
    const payload = JSON.parse(Buffer.from(access_token.split(".")[1]!, "base64").toString()) as {
      exp?: number;
    };
    if (payload.exp && Date.now() < payload.exp * 1000 - 60_000) {
      return access_token;
    }
  } catch {
    // Can't decode — try using it anyway
    return access_token;
  }

  // Token expired — refresh
  if (!refresh_token) {
    log.debug("codex-bridge", "Codex token expired, no refresh token");
    return null;
  }

  log.debug("codex-bridge", "Codex token expired, refreshing...");

  try {
    const response = await fetch(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh_token,
        client_id: OPENAI_CODEX_CLIENT_ID,
      }),
    });

    if (!response.ok) {
      log.debug("codex-bridge", `Codex token refresh failed (${response.status})`);
      return null;
    }

    const data = (await response.json()) as Record<string, unknown>;
    const newToken = data.access_token as string;
    creds.tokens.access_token = newToken;
    if (data.refresh_token) creds.tokens.refresh_token = data.refresh_token as string;
    creds.last_refresh = new Date().toISOString();

    try {
      writeFileSync(CODEX_AUTH_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
      _codexCache = null;
      _codexCacheTime = 0;
    } catch (err) {
      log.debug("codex-bridge", `Failed to persist Codex token: ${err}`);
    }

    return newToken;
  } catch (err) {
    log.debug("codex-bridge", `Codex refresh error: ${err}`);
    return null;
  }
}
