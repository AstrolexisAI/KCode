// KCode - Extension API Middleware Tests

import { describe, test, expect, beforeEach } from "bun:test";
import {
  createAuthMiddleware,
  createRateLimitMiddleware,
  createCorsMiddleware,
  createLoggingMiddleware,
  getCorsHeaders,
} from "./middleware";

// ─── Helpers ───────────────────────────────────────────────────

function makeReq(opts: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
}): Request {
  const { method = "GET", path = "/test", headers = {} } = opts;
  return new Request(`http://localhost:19300${path}`, { method, headers });
}

// ─── Auth Middleware ───────────────────────────────────────────

describe("auth middleware", () => {
  const auth = createAuthMiddleware("secret-token-123");

  test("rejects request with no Authorization header", async () => {
    const res = await auth(makeReq({}));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const body = await res!.json();
    expect(body.code).toBe("AUTH_REQUIRED");
  });

  test("rejects request with invalid token", async () => {
    const res = await auth(makeReq({
      headers: { Authorization: "Bearer wrong-token" },
    }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const body = await res!.json();
    expect(body.code).toBe("AUTH_INVALID");
  });

  test("rejects request with non-Bearer auth format", async () => {
    const res = await auth(makeReq({
      headers: { Authorization: "Basic abc123" },
    }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  test("passes request with valid Bearer token", async () => {
    const res = await auth(makeReq({
      headers: { Authorization: "Bearer secret-token-123" },
    }));
    expect(res).toBeNull();
  });
});

// ─── Rate Limit Middleware ─────────────────────────────────────

describe("rate limit middleware", () => {
  test("allows requests under the limit", async () => {
    const limiter = createRateLimitMiddleware(5);

    for (let i = 0; i < 5; i++) {
      const res = await limiter(makeReq({}));
      expect(res).toBeNull();
    }
  });

  test("blocks requests over the limit", async () => {
    const limiter = createRateLimitMiddleware(3);

    // Use up the limit
    for (let i = 0; i < 3; i++) {
      await limiter(makeReq({}));
    }

    // Next request should be blocked
    const res = await limiter(makeReq({}));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    const body = await res!.json();
    expect(body.code).toBe("RATE_LIMITED");
  });

  test("returns Retry-After header when rate limited", async () => {
    const limiter = createRateLimitMiddleware(1);
    await limiter(makeReq({}));

    const res = await limiter(makeReq({}));
    expect(res).not.toBeNull();
    expect(res!.headers.get("Retry-After")).toBeTruthy();
  });

  test("tracks different clients separately via X-Forwarded-For", async () => {
    const limiter = createRateLimitMiddleware(1);

    const res1 = await limiter(makeReq({
      headers: { "X-Forwarded-For": "1.2.3.4" },
    }));
    expect(res1).toBeNull();

    const res2 = await limiter(makeReq({
      headers: { "X-Forwarded-For": "5.6.7.8" },
    }));
    expect(res2).toBeNull();

    // Same client again should be blocked
    const res3 = await limiter(makeReq({
      headers: { "X-Forwarded-For": "1.2.3.4" },
    }));
    expect(res3).not.toBeNull();
    expect(res3!.status).toBe(429);
  });
});

// ─── CORS Middleware ───────────────────────────────────────────

describe("cors middleware", () => {
  test("handles OPTIONS preflight with wildcard origins", async () => {
    const cors = createCorsMiddleware(["*"]);
    const res = await cors(makeReq({
      method: "OPTIONS",
      headers: { Origin: "http://example.com" },
    }));

    expect(res).not.toBeNull();
    expect(res!.status).toBe(204);
    expect(res!.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res!.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(res!.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  test("handles OPTIONS preflight with specific allowed origin", async () => {
    const cors = createCorsMiddleware(["http://localhost:3000"]);
    const res = await cors(makeReq({
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000" },
    }));

    expect(res).not.toBeNull();
    expect(res!.status).toBe(204);
    expect(res!.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
  });

  test("rejects OPTIONS preflight from disallowed origin", async () => {
    const cors = createCorsMiddleware(["http://localhost:3000"]);
    const res = await cors(makeReq({
      method: "OPTIONS",
      headers: { Origin: "http://evil.com" },
    }));

    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  test("passes through non-OPTIONS requests", async () => {
    const cors = createCorsMiddleware(["*"]);
    const res = await cors(makeReq({
      method: "GET",
      headers: { Origin: "http://example.com" },
    }));

    expect(res).toBeNull();
  });
});

// ─── getCorsHeaders ────────────────────────────────────────────

describe("getCorsHeaders", () => {
  test("returns wildcard headers for wildcard config", () => {
    const headers = getCorsHeaders(["*"], "http://example.com");
    expect(headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  test("returns matching origin headers for specific config", () => {
    const headers = getCorsHeaders(["http://localhost:3000"], "http://localhost:3000");
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:3000");
  });

  test("returns empty object for non-matching origin", () => {
    const headers = getCorsHeaders(["http://localhost:3000"], "http://evil.com");
    expect(Object.keys(headers)).toHaveLength(0);
  });
});

// ─── Logging Middleware ────────────────────────────────────────

describe("logging middleware", () => {
  test("always passes through (returns null)", async () => {
    const logging = createLoggingMiddleware();
    const res = await logging(makeReq({ path: "/api/ext/v1/health" }));
    expect(res).toBeNull();
  });
});
