// KCode - HTTP Server E2E Tests
// Spins up a real Bun.serve using the production fetch handler (buildFetchHandler).
// Uses port 0 for OS-assigned port to avoid collisions.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildFetchHandler } from "./http-server";

// ─── Real Server Setup ──────────────────────────────────────────

const TEST_API_KEY = "e2e-test-key-" + Date.now();
let server: ReturnType<typeof Bun.serve> | null = null;
let BASE = "";

beforeAll(() => {
  const handler = buildFetchHandler(TEST_API_KEY);
  // Try port 0 (OS-assigned); if that somehow fails, try an explicit high port
  for (const port of [0, 19900 + (Date.now() % 100)]) {
    try {
      server = Bun.serve({ port, hostname: "127.0.0.1", fetch: handler });
      BASE = `http://127.0.0.1:${server.port}`;
      return;
    } catch {
      // Port busy — try next
    }
  }
  throw new Error("Failed to start E2E test server on any port");
});

afterAll(() => {
  try { server?.stop(true); } catch { /* ignore cleanup errors */ }
  server = null;
});

// ─── Helpers ────────────────────────────────────────────────────

async function api(
  path: string,
  opts: RequestInit & { noAuth?: boolean; origin?: string } = {},
): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (!opts.noAuth && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${TEST_API_KEY}`);
  }
  if (opts.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (opts.origin) {
    headers.set("Origin", opts.origin);
  }
  const { noAuth, origin, ...fetchOpts } = opts;
  return fetch(`${BASE}${path}`, { ...fetchOpts, headers });
}

// ─── Auth (production code path) ────────────────────────────────

describe("E2E: Auth", () => {
  test("rejects request with no auth header", async () => {
    const res = await api("/api/health", { noAuth: true });
    expect(res.status).toBe(401);
  });

  test("rejects request with wrong Bearer token", async () => {
    const res = await fetch(`${BASE}/api/health`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  test("accepts request with correct Bearer token", async () => {
    const res = await api("/api/health");
    expect(res.status).toBe(200);
  });
});

// ─── CORS (production code path) ────────────────────────────────

describe("E2E: CORS", () => {
  test("preflight OPTIONS returns 204 with CORS headers", async () => {
    const res = await fetch(`${BASE}/api/health`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  test("localhost origin is reflected back", async () => {
    const res = await api("/api/health", { origin: "http://localhost:5173" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  });

  test("127.0.0.1 origin is reflected back", async () => {
    const res = await api("/api/health", { origin: "http://127.0.0.1:8080" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:8080");
  });

  test("vscode-webview origin is reflected back", async () => {
    const res = await api("/api/health", { origin: "vscode-webview://abc123" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("vscode-webview://abc123");
  });

  test("non-local origin gets default localhost", async () => {
    const res = await api("/api/health", { origin: "https://evil.com" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost");
  });

  test("no origin header gets default localhost", async () => {
    const res = await api("/api/health");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost");
  });
});

// ─── Endpoints (real HTTP) ──────────────────────────────────────

describe("E2E: GET /api/health", () => {
  test("returns JSON with ok, version, model", async () => {
    const res = await api("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("model");
  });
});

describe("E2E: GET /api/status", () => {
  test("returns uptime and model", async () => {
    const res = await api("/api/status");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.uptime).toBe("number");
    expect(body).toHaveProperty("model");
  });
});

describe("E2E: GET /api/tools", () => {
  test("returns array of tool definitions", async () => {
    const res = await api("/api/tools");
    expect(res.status).toBe(200);
    const body = await res.json() as { tools: unknown[] };
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
  });
});

describe("E2E: GET /api/sessions", () => {
  test("returns active and recent arrays", async () => {
    const res = await api("/api/sessions");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Array.isArray(body.active)).toBe(true);
    expect(Array.isArray(body.recent)).toBe(true);
  });
});

// ─── Tool Execution (real HTTP) ─────────────────────────────────

describe("E2E: POST /api/tool", () => {
  test("executes Read tool over real HTTP", async () => {
    const res = await api("/api/tool", {
      method: "POST",
      body: JSON.stringify({
        name: "Read",
        input: { file_path: import.meta.path },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.name).toBe("Read");
    expect(body.isError).toBe(false);
    expect(typeof body.content).toBe("string");
  });

  test("blocks Bash over real HTTP", async () => {
    const res = await api("/api/tool", {
      method: "POST",
      body: JSON.stringify({
        name: "Bash",
        input: { command: "id" },
      }),
    });
    expect(res.status).toBe(403);
  });

  test("returns proper Content-Type header", async () => {
    const res = await api("/api/tool", {
      method: "POST",
      body: JSON.stringify({ name: "Read", input: { file_path: import.meta.path } }),
    });
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });
});

// ─── Error Handling (real HTTP) ─────────────────────────────────

describe("E2E: Error handling", () => {
  test("returns 404 JSON for unknown routes", async () => {
    const res = await api("/api/does-not-exist");
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("Not Found");
  });

  test("returns 400 for malformed POST body", async () => {
    const res = await api("/api/tool", {
      method: "POST",
      body: "not json at all",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });
});

// ─── Session Isolation ──────────────────────────────────────────

describe("E2E: Session headers", () => {
  test("X-Session-Id header is accepted", async () => {
    const res = await api("/api/context", {
      headers: { "X-Session-Id": "test-session-abc" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.messageCount).toBe(0);
  });
});

// ─── Legacy Endpoints ───────────────────────────────────────────

describe("E2E: Legacy endpoints", () => {
  test("GET /health returns ok", async () => {
    const res = await api("/health");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
  });

  test("GET /v1/tools returns tools", async () => {
    const res = await api("/v1/tools");
    expect(res.status).toBe(200);
    const body = await res.json() as { tools: unknown[] };
    expect(Array.isArray(body.tools)).toBe(true);
  });

  test("GET /v1/skills returns skills", async () => {
    const res = await api("/v1/skills");
    expect(res.status).toBe(200);
    const body = await res.json() as { skills: unknown[] };
    expect(Array.isArray(body.skills)).toBe(true);
  });
});

// ─── Workspace Scoping (real HTTP) ──────────────────────────────

describe("E2E: Workspace scoping", () => {
  test("Glob rejects absolute path outside workspace", async () => {
    const res = await api("/api/tool", {
      method: "POST",
      body: JSON.stringify({ name: "Glob", input: { pattern: "*.ts", path: "/etc" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.isError).toBe(true);
    expect(body.content).toContain("outside the project workspace");
  });

  test("Glob rejects path traversal", async () => {
    const res = await api("/api/tool", {
      method: "POST",
      body: JSON.stringify({ name: "Glob", input: { pattern: "*.ts", path: "../../../etc" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.isError).toBe(true);
    expect(body.content).toContain("outside the project workspace");
  });

  test("Grep rejects path outside workspace", async () => {
    const res = await api("/api/tool", {
      method: "POST",
      body: JSON.stringify({ name: "Grep", input: { pattern: "root", path: "/etc/passwd" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.isError).toBe(true);
    expect(body.content).toContain("outside the project workspace");
  });

  test("Glob works within workspace over real HTTP", async () => {
    const res = await api("/api/tool", {
      method: "POST",
      body: JSON.stringify({ name: "Glob", input: { pattern: "src/**/*.ts" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.isError ?? false).toBe(false);
  });
});
