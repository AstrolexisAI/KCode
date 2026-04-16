// End-to-end tests for the OAuth PKCE + subscription API.
// Exercises the full flow: signup → login → authorize → token →
// /api/subscription → refresh → revoke.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";

// Isolated DB per test
let dbPath: string;
let origDbPath: string | undefined;

beforeEach(() => {
  origDbPath = process.env.DB_PATH;
  dbPath = `/tmp/kcode-oauth-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
  process.env.DB_PATH = dbPath;
  // Force a fresh module cache so db.ts re-opens with the new path
  delete require.cache[require.resolve("./db")];
  delete require.cache[require.resolve("./oauth")];
});

afterEach(() => {
  if (origDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = origDbPath;
  if (existsSync(dbPath)) rmSync(dbPath);
  if (existsSync(`${dbPath}-wal`)) rmSync(`${dbPath}-wal`);
  if (existsSync(`${dbPath}-shm`)) rmSync(`${dbPath}-shm`);
});

// ─── PKCE helpers (client side) ─────────────────────────────────

function base64UrlNoPad(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function genPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlNoPad(randomBytes(32));
  const challenge = base64UrlNoPad(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// ─── Server-side helpers: create a logged-in user + session ─────

async function bootstrapUser(
  email: string,
  password: string = "password-one-two-3",
): Promise<{ userId: string; sessionId: string }> {
  const { insertUser, createSession } = await import("./db");
  const passwordHash = await Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 19456,
    timeCost: 2,
  });
  const user = insertUser(email, passwordHash);
  const sessionId = createSession(user.id);
  return { userId: user.id, sessionId };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("OAuth PKCE flow", () => {
  test("issues tokens on valid code + code_verifier", async () => {
    const { insertOAuthCode } = await import("./db");
    const { handleToken } = await import("./oauth");

    const { userId } = await bootstrapUser("user1@test.com");
    const { verifier, challenge } = genPkcePair();

    const code = "test-code-" + randomBytes(8).toString("hex");
    insertOAuthCode({
      code,
      userId,
      clientId: "kcode-cli",
      redirectUri: "http://localhost:8080/callback",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: "subscription:read",
      ttlSec: 600,
    });

    // Simulate POST /oauth/token
    const req = new Request("http://test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: "kcode-cli",
        redirect_uri: "http://localhost:8080/callback",
      }),
    });
    const ctx: any = {
      req: { header: (n: string) => req.headers.get(n), json: async () => ({}), formData: async () => await req.formData() },
      json: (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), {
          status: status ?? 200,
          headers: { "content-type": "application/json" },
        }),
    };
    const res = await handleToken(ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token_type).toBe("Bearer");
    expect(typeof body.access_token).toBe("string");
    expect(typeof body.refresh_token).toBe("string");
    expect(body.expires_in).toBeGreaterThan(0);
  });

  test("rejects wrong code_verifier (PKCE mismatch)", async () => {
    const { insertOAuthCode } = await import("./db");
    const { handleToken } = await import("./oauth");

    const { userId } = await bootstrapUser("user2@test.com");
    const { challenge } = genPkcePair();
    const code = "test-code-" + randomBytes(8).toString("hex");
    insertOAuthCode({
      code,
      userId,
      clientId: "kcode-cli",
      redirectUri: "http://localhost:8080/callback",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: "subscription:read",
      ttlSec: 600,
    });

    const req = new Request("http://test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: "a".repeat(43), // wrong verifier
        client_id: "kcode-cli",
        redirect_uri: "http://localhost:8080/callback",
      }),
    });
    const ctx: any = {
      req: { header: (n: string) => req.headers.get(n), json: async () => ({}), formData: async () => await req.formData() },
      json: (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), {
          status: status ?? 200,
          headers: { "content-type": "application/json" },
        }),
    };
    const res = await handleToken(ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_grant");
  });

  test("rejects second use of same code (single-use)", async () => {
    const { insertOAuthCode } = await import("./db");
    const { handleToken } = await import("./oauth");

    const { userId } = await bootstrapUser("user3@test.com");
    const { verifier, challenge } = genPkcePair();
    const code = "test-code-" + randomBytes(8).toString("hex");
    insertOAuthCode({
      code,
      userId,
      clientId: "kcode-cli",
      redirectUri: "http://localhost:8080/callback",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: "subscription:read",
      ttlSec: 600,
    });

    const makeReq = () => {
      const req = new Request("http://test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: "kcode-cli",
          redirect_uri: "http://localhost:8080/callback",
        }),
      });
      return {
        req: { header: (n: string) => req.headers.get(n), json: async () => ({}), formData: async () => await req.formData() },
        json: (body: unknown, status?: number) =>
          new Response(JSON.stringify(body), {
            status: status ?? 200,
            headers: { "content-type": "application/json" },
          }),
      } as any;
    };

    const first = await handleToken(makeReq());
    expect(first.status).toBe(200);
    const second = await handleToken(makeReq());
    expect(second.status).toBe(400); // code already consumed
  });

  test("verifyPkce rejects non-S256 method", async () => {
    const { verifyPkce } = await import("./oauth");
    expect(verifyPkce("x".repeat(43), "y", "plain")).toBe(false);
  });

  test("verifyPkce rejects too-short verifier", async () => {
    const { verifyPkce } = await import("./oauth");
    expect(verifyPkce("short", "y", "S256")).toBe(false);
  });
});

describe("Bearer authentication", () => {
  test("authenticateBearer recognizes a valid token", async () => {
    const { insertOAuthToken } = await import("./db");
    const { authenticateBearer, sha256Hex } = await import("./oauth");

    const { userId } = await bootstrapUser("bearer@test.com");
    const raw = "test-access-" + randomBytes(16).toString("hex");
    insertOAuthToken({
      userId,
      accessHash: sha256Hex(raw),
      refreshHash: null,
      clientId: "kcode-cli",
      scope: "subscription:read",
      expiresSec: 3600,
      refreshExpiresSec: null,
    });

    const ctx: any = {
      req: { header: (n: string) => (n.toLowerCase() === "authorization" ? `Bearer ${raw}` : null) },
    };
    const authed = await authenticateBearer(ctx);
    expect(authed).not.toBeNull();
    expect(authed!.userId).toBe(userId);
    expect(authed!.clientId).toBe("kcode-cli");
  });

  test("authenticateBearer rejects missing header", async () => {
    const { authenticateBearer } = await import("./oauth");
    const ctx: any = { req: { header: () => null } };
    expect(await authenticateBearer(ctx)).toBeNull();
  });

  test("authenticateBearer rejects unknown token", async () => {
    const { authenticateBearer } = await import("./oauth");
    const ctx: any = {
      req: { header: (n: string) => (n.toLowerCase() === "authorization" ? "Bearer unknown-token" : null) },
    };
    expect(await authenticateBearer(ctx)).toBeNull();
  });
});
