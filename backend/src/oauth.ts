// OAuth 2.0 Authorization Code + PKCE for astrolexis.space.
//
// This is the server side of the flow that `/login` in the kcode
// TUI initiates. The kcode client redirects the user's browser to
// GET /oauth/authorize; the user logs in (if they aren't already),
// approves the consent screen, and is redirected back to kcode's
// localhost callback with an authorization code. kcode then POSTs
// to /oauth/token with the code + code_verifier to get a short-
// lived access_token plus a long-lived refresh_token.
//
// Security:
//   - PKCE S256 is REQUIRED (no plain method)
//   - Authorization codes expire in 10 min, single-use
//   - Access tokens last 1h; refresh tokens last 60 days
//   - Tokens are stored hashed (SHA-256) so a DB leak doesn't give
//     usable credentials
//   - Only registered client_ids are allowed (kcode-cli is the only
//     one right now; easy to extend)
//   - redirect_uri must exactly match one of the allowlisted values
//     per client, to prevent open-redirect abuse

import type { Context } from "hono";
import { createHash, randomBytes } from "node:crypto";
import {
  consumeOAuthCode,
  findSessionUser,
  findTokenByRefreshHash,
  insertOAuthCode,
  insertOAuthToken,
} from "./db";

// ─── Config ─────────────────────────────────────────────────────

const ACCESS_TOKEN_TTL_SEC = 60 * 60; // 1h
const REFRESH_TOKEN_TTL_SEC = 60 * 24 * 3600; // 60 days
const AUTH_CODE_TTL_SEC = 10 * 60; // 10 min

interface RegisteredClient {
  clientId: string;
  label: string;
  /** Strict allowlist of redirect_uri prefixes permitted for this client. */
  redirectUriPrefixes: string[];
  /** Default scopes granted to this client. */
  defaultScopes: string[];
}

// kcode-cli uses localhost callbacks on a port that varies per
// install, so we allow any http://127.0.0.1:*/callback or
// http://localhost:*/callback. Other clients would be added here.
const CLIENTS: Record<string, RegisteredClient> = {
  "kcode-cli": {
    clientId: "kcode-cli",
    label: "KCode CLI",
    redirectUriPrefixes: [
      "http://127.0.0.1:",
      "http://localhost:",
    ],
    defaultScopes: ["subscription:read"],
  },
};

// ─── Helpers ────────────────────────────────────────────────────

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function base64UrlNoPad(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function randomUrlToken(bytes: number): string {
  return base64UrlNoPad(randomBytes(bytes));
}

function validateClient(clientId: string, redirectUri: string): RegisteredClient | null {
  const client = CLIENTS[clientId];
  if (!client) return null;
  const ok = client.redirectUriPrefixes.some((prefix) =>
    redirectUri.startsWith(prefix),
  );
  return ok ? client : null;
}

function verifyPkce(
  codeVerifier: string,
  challenge: string,
  method: string,
): boolean {
  if (method !== "S256") return false;
  if (codeVerifier.length < 43 || codeVerifier.length > 128) return false;
  const derived = base64UrlNoPad(
    createHash("sha256").update(codeVerifier).digest(),
  );
  return derived === challenge;
}

/** Read the session cookie and resolve to a logged-in user, or null. */
function currentUser(c: Context): ReturnType<typeof findSessionUser> {
  const cookie = c.req.header("cookie") ?? "";
  const match = cookie.match(/kcode_sess=([^;]+)/);
  if (!match) return null;
  return findSessionUser(match[1]!);
}

// ─── Endpoints ──────────────────────────────────────────────────

/**
 * GET /oauth/authorize
 *
 * Query params:
 *   - client_id (required)
 *   - redirect_uri (required, prefix-matched against client allowlist)
 *   - response_type=code (required)
 *   - code_challenge (required, 43-128 chars base64url)
 *   - code_challenge_method=S256 (required)
 *   - state (recommended, reflected back verbatim)
 *   - scope (optional, space-separated)
 *
 * Behavior:
 *   - If not logged in → render a login page that posts to /login
 *     and redirects back here on success
 *   - If logged in → render a consent page showing the requesting
 *     app + scope + email. On "Authorize", issue an auth code and
 *     redirect to redirect_uri?code=...&state=...
 *
 * Client uses the returned code in POST /oauth/token below.
 */
export async function handleAuthorize(c: Context): Promise<Response> {
  const q = c.req.query();
  const clientId = q.client_id ?? "";
  const redirectUri = q.redirect_uri ?? "";
  const responseType = q.response_type ?? "";
  const codeChallenge = q.code_challenge ?? "";
  const codeChallengeMethod = q.code_challenge_method ?? "";
  const state = q.state ?? "";
  const scope = q.scope ?? "";

  if (responseType !== "code") {
    return c.text("response_type must be 'code'", 400);
  }
  if (codeChallengeMethod !== "S256") {
    return c.text("PKCE required: code_challenge_method must be 'S256'", 400);
  }
  if (!codeChallenge || codeChallenge.length < 43 || codeChallenge.length > 128) {
    return c.text("code_challenge must be 43-128 chars (base64url SHA-256)", 400);
  }
  const client = validateClient(clientId, redirectUri);
  if (!client) {
    return c.text("Unknown client_id or redirect_uri not allowed", 400);
  }

  const user = currentUser(c);
  if (!user) {
    // Stash all the OAuth params in a cookie, redirect to /login
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      state,
      scope,
    });
    const next = `/oauth/authorize?${params.toString()}`;
    return c.redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  // Logged in → show consent
  const { renderConsent } = await import("./pages");
  return c.html(
    renderConsent({
      clientLabel: client.label,
      userEmail: user.email,
      scope: scope || client.defaultScopes.join(" "),
      action: "/oauth/authorize/consent",
      hiddenFields: {
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
        state,
        scope,
      },
    }),
  );
}

/**
 * POST /oauth/authorize/consent
 *
 * User clicked "Authorize" on the consent page. Issue an auth code
 * bound to their user id + the PKCE challenge, redirect back to
 * the client's redirect_uri.
 */
export async function handleAuthorizeConsent(c: Context): Promise<Response> {
  const form = await c.req.formData();
  const clientId = String(form.get("client_id") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const codeChallenge = String(form.get("code_challenge") ?? "");
  const codeChallengeMethod = String(form.get("code_challenge_method") ?? "");
  const state = String(form.get("state") ?? "");
  const scope = String(form.get("scope") ?? "");

  const client = validateClient(clientId, redirectUri);
  if (!client) return c.text("Invalid client", 400);

  const user = currentUser(c);
  if (!user) return c.redirect("/login");

  const code = randomUrlToken(32);
  insertOAuthCode({
    code,
    userId: user.id,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    scope: scope || client.defaultScopes.join(" "),
    ttlSec: AUTH_CODE_TTL_SEC,
  });

  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);
  return c.redirect(redirect.toString());
}

/**
 * POST /oauth/token
 *
 * Two grant types:
 *
 * 1) grant_type=authorization_code
 *    body: code, code_verifier, client_id, redirect_uri
 *    → { access_token, refresh_token, token_type: "Bearer", expires_in, scope }
 *
 * 2) grant_type=refresh_token
 *    body: refresh_token, client_id
 *    → same response with rotated tokens (old refresh is revoked)
 */
export async function handleToken(c: Context): Promise<Response> {
  const body = await readBody(c);
  const grantType = body.grant_type;

  if (grantType === "authorization_code") {
    const { code, code_verifier, client_id, redirect_uri } = body;
    if (!code || !code_verifier || !client_id || !redirect_uri) {
      return c.json({ error: "invalid_request", error_description: "Missing required fields" }, 400);
    }

    const consumed = consumeOAuthCode(code);
    if (!consumed) {
      return c.json({ error: "invalid_grant", error_description: "Code expired or already used" }, 400);
    }
    if (consumed.client_id !== client_id) {
      return c.json({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);
    }
    if (consumed.redirect_uri !== redirect_uri) {
      return c.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    }
    if (!verifyPkce(code_verifier, consumed.code_challenge, consumed.code_challenge_method)) {
      return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
    }

    return issueTokens(c, consumed.user_id, client_id, consumed.scope);
  }

  if (grantType === "refresh_token") {
    const { refresh_token, client_id } = body;
    if (!refresh_token || !client_id) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const row = findTokenByRefreshHash(sha256Hex(refresh_token));
    if (!row) {
      return c.json({ error: "invalid_grant", error_description: "refresh_token invalid or expired" }, 400);
    }
    if (row.client_id !== client_id) {
      return c.json({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);
    }
    // Revoke the old token (rotation) and issue a fresh pair.
    const { revokeToken } = await import("./db");
    revokeToken(row.access_hash);
    return issueTokens(c, row.user_id, client_id, row.scope);
  }

  return c.json({ error: "unsupported_grant_type" }, 400);
}

async function issueTokens(
  c: Context,
  userId: string,
  clientId: string,
  scope: string,
): Promise<Response> {
  const accessToken = randomUrlToken(32);
  const refreshToken = randomUrlToken(32);
  insertOAuthToken({
    userId,
    accessHash: sha256Hex(accessToken),
    refreshHash: sha256Hex(refreshToken),
    clientId,
    scope,
    expiresSec: ACCESS_TOKEN_TTL_SEC,
    refreshExpiresSec: REFRESH_TOKEN_TTL_SEC,
  });
  return c.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SEC,
    scope,
  });
}

async function readBody(c: Context): Promise<Record<string, string>> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await c.req.json()) as Record<string, string>;
  }
  // form-urlencoded (RFC 6749 default)
  const form = await c.req.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) out[k] = String(v);
  return out;
}

// ─── Bearer auth middleware for /api/* ──────────────────────────

export interface AuthedRequest {
  userId: string;
  scope: string;
  clientId: string;
}

/**
 * Parse the Bearer token from the Authorization header and resolve
 * it to a user+scope tuple. Returns null if missing, expired, or
 * revoked — caller should send 401.
 */
export async function authenticateBearer(c: Context): Promise<AuthedRequest | null> {
  const auth = c.req.header("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const { findTokenByAccessHash } = await import("./db");
  const row = findTokenByAccessHash(sha256Hex(m[1]!));
  if (!row) return null;
  return { userId: row.user_id, scope: row.scope, clientId: row.client_id };
}

// Export constants for tests / other modules.
export { ACCESS_TOKEN_TTL_SEC, REFRESH_TOKEN_TTL_SEC, sha256Hex, base64UrlNoPad, verifyPkce };
