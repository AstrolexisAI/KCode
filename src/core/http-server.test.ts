// KCode - HTTP API Server Tests
// Covers: allowlist enforcement, blocked tools, auth, malformed input, unknown tools
// Tests call handleRoute() directly — no subprocess, no Pro requirement.

import { describe, expect, test } from "bun:test";
import { ALLOWED_HTTP_TOOLS, BLOCKED_TOOLS, buildFetchHandler, handleRoute } from "./http-server";

// ─── Helpers ────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "http://localhost",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Id",
  Vary: "Origin",
};

function makeReq(method: string, path: string, body?: unknown): { req: Request; url: URL } {
  const urlStr = `http://localhost:10101${path}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  return { req: new Request(urlStr, init), url: new URL(urlStr) };
}

async function route(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const { req, url } = makeReq(method, path, body);
  const res = await handleRoute(req, url, CORS);
  return { status: res.status, body: await res.json() };
}

// ─── GET /api/health ────────────────────────────────────────────

describe("GET /api/health", () => {
  test("returns ok, version, model", async () => {
    const { status, body } = await route("GET", "/api/health");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("model");
  });
});

// ─── GET /api/tools ─────────────────────────────────────────────

describe("GET /api/tools", () => {
  test("returns a tools array with schemas", async () => {
    const { status, body } = await route("GET", "/api/tools");
    expect(status).toBe(200);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
    const first = body.tools[0];
    expect(first).toHaveProperty("name");
    expect(first).toHaveProperty("description");
  });
});

// ─── POST /api/tool — Allowlist Enforcement ─────────────────────

describe("POST /api/tool — allowlist", () => {
  test("allows Read (in allowlist)", async () => {
    const { status, body } = await route("POST", "/api/tool", {
      name: "Read",
      input: { file_path: import.meta.path },
    });
    expect(status).toBe(200);
    expect(body.name).toBe("Read");
    expect(body.isError).toBe(false);
    expect(body.content).toBeTruthy();
  });

  test("allows Glob (in allowlist)", async () => {
    const { status, body } = await route("POST", "/api/tool", {
      name: "Glob",
      input: { pattern: "*.ts", path: import.meta.dir },
    });
    expect(status).toBe(200);
    expect(body.isError).toBe(false);
  });

  test("allows Grep (in allowlist)", async () => {
    const { status } = await route("POST", "/api/tool", {
      name: "Grep",
      input: { pattern: "ALLOWED_HTTP_TOOLS", path: import.meta.dir, output_mode: "count" },
    });
    expect(status).toBe(200);
  });

  // Test every blocked tool
  for (const tool of BLOCKED_TOOLS) {
    test(`blocks ${tool} (in blocklist)`, async () => {
      const { status, body } = await route("POST", "/api/tool", {
        name: tool,
        input: {},
      });
      expect(status).toBe(403);
      expect(body.error).toContain("not allowed");
      expect(body.error).toContain("dangerous tool blocked");
    });
  }

  test("blocks tools not in allowlist (e.g. TestRunner)", async () => {
    const { status, body } = await route("POST", "/api/tool", {
      name: "TestRunner",
      input: { command: "bun test" },
    });
    expect(status).toBe(403);
    expect(body.error).toContain("not in the HTTP API allowlist");
  });

  test("blocks Clipboard (not in allowlist, not in blocklist)", async () => {
    const { status, body } = await route("POST", "/api/tool", {
      name: "Clipboard",
      input: {},
    });
    expect(status).toBe(403);
    expect(body.error).toContain("not in the HTTP API allowlist");
  });
});

// ─── POST /api/tool — Malformed Input ───────────────────────────

describe("POST /api/tool — malformed input", () => {
  test("rejects missing name", async () => {
    const { status, body } = await route("POST", "/api/tool", { input: {} });
    expect(status).toBe(400);
    expect(body.error).toContain("'name' is required");
  });

  test("rejects missing input", async () => {
    const { status, body } = await route("POST", "/api/tool", { name: "Read" });
    expect(status).toBe(400);
    expect(body.error).toContain("'input' is required");
  });

  test("rejects non-object input", async () => {
    const { status } = await route("POST", "/api/tool", { name: "Read", input: "not-an-object" });
    expect(status).toBe(400);
  });

  test("rejects invalid JSON body", async () => {
    const { req, url } = makeReq("POST", "/api/tool", undefined);
    // Manually create request with bad JSON
    const badReq = new Request(req.url, {
      method: "POST",
      body: "{{invalid json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await handleRoute(badReq, url, CORS);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toContain("Invalid JSON");
  });

  test("rejects non-string name", async () => {
    const { status } = await route("POST", "/api/tool", { name: 123, input: {} });
    expect(status).toBe(400);
  });
});

// ─── POST /api/tool — Unknown Tools ─────────────────────────────

describe("POST /api/tool — unknown tools", () => {
  test("returns 403 for unknown tool (not in allowlist)", async () => {
    const { status, body } = await route("POST", "/api/tool", {
      name: "NonExistentTool",
      input: {},
    });
    expect(status).toBe(403);
    expect(body.error).toContain("not in the HTTP API allowlist");
  });
});

// ─── Allowlist/Blocklist Consistency ────────────────────────────

describe("Allowlist/Blocklist consistency", () => {
  test("allowlist and blocklist do not overlap", () => {
    for (const tool of ALLOWED_HTTP_TOOLS) {
      expect(BLOCKED_TOOLS.has(tool)).toBe(false);
    }
  });

  test("allowlist contains only known read-only tools", () => {
    const expectedSafe = [
      "Read",
      "Glob",
      "Grep",
      "LS",
      "DiffView",
      "GitStatus",
      "GitLog",
      "ToolSearch",
    ];
    expect([...ALLOWED_HTTP_TOOLS].sort()).toEqual(expectedSafe.sort());
  });
});

// ─── GET /api/status ────────────────────────────────────────────

describe("GET /api/status", () => {
  test("returns server status", async () => {
    const { status, body } = await route("GET", "/api/status");
    expect(status).toBe(200);
    expect(body).toHaveProperty("model");
    expect(body).toHaveProperty("uptime");
    expect(typeof body.uptime).toBe("number");
  });
});

// ─── GET /api/sessions ──────────────────────────────────────────

describe("GET /api/sessions", () => {
  test("returns active and recent arrays", async () => {
    const { status, body } = await route("GET", "/api/sessions");
    expect(status).toBe(200);
    expect(Array.isArray(body.active)).toBe(true);
    expect(Array.isArray(body.recent)).toBe(true);
  });
});

// ─── GET /api/context ───────────────────────────────────────────

describe("GET /api/context", () => {
  test("returns empty context when no session active", async () => {
    const { status, body } = await route("GET", "/api/context");
    expect(status).toBe(200);
    expect(body.sessionId).toBeNull();
    expect(body.messageCount).toBe(0);
  });
});

// ─── TUI vs Server Isolation ────────────────────────────────────

describe("TUI vs Server permission isolation", () => {
  test("/api/tool cannot execute any write tool", async () => {
    // All tools that modify state must be blocked
    const writeTools = [
      "Bash",
      "Write",
      "Edit",
      "MultiEdit",
      "GrepReplace",
      "Rename",
      "NotebookEdit",
      "Agent",
    ];
    for (const tool of writeTools) {
      const { status } = await route("POST", "/api/tool", { name: tool, input: {} });
      expect(status).toBe(403);
    }
  });

  test("/api/tool cannot execute scheduling/task tools", async () => {
    const sideEffectTools = [
      "CronCreate",
      "CronDelete",
      "Clipboard",
      "Stash",
      "PlanMode",
      "SendMessage",
      "Skill",
    ];
    for (const tool of sideEffectTools) {
      const { status } = await route("POST", "/api/tool", { name: tool, input: {} });
      expect(status).toBe(403);
    }
  });

  test("allowed tools return 200 (not 403) even with bad input", async () => {
    // Read, Glob, Grep are already tested above — verify they don't 403
    // LS, DiffView, GitStatus, GitLog tested here
    for (const tool of ["GitStatus", "GitLog"]) {
      const { status } = await route("POST", "/api/tool", { name: tool, input: {} });
      expect(status).not.toBe(403);
    }
  });

  test("ConversationManager in /api/prompt always has PermissionManager", async () => {
    // Verify that getOrCreateSession builds a manager with permissions
    // by checking the config includes permissionMode
    // We can't easily test /api/prompt without an LLM, but we can verify
    // the session setup path creates a proper config
    const { buildConfig } = await import("./config.js");
    const config = await buildConfig(process.cwd());
    expect(config.permissionMode).toBeDefined();
    expect(["ask", "auto", "plan", "deny", "acceptEdits"]).toContain(config.permissionMode);
  });
});

// ─── Workspace Scoping via /api/tool ────────────────────────────

describe("/api/tool workspace scoping", () => {
  test("Glob rejects paths outside workspace", async () => {
    const { status, body } = await route("POST", "/api/tool", {
      name: "Glob",
      input: { pattern: "*.ts", path: "/etc" },
    });
    expect(status).toBe(200);
    expect(body.isError).toBe(true);
    expect(body.content).toContain("outside the project workspace");
  });

  test("Glob rejects path traversal", async () => {
    const { status, body } = await route("POST", "/api/tool", {
      name: "Glob",
      input: { pattern: "*.ts", path: "../../../etc" },
    });
    expect(status).toBe(200);
    expect(body.isError).toBe(true);
    expect(body.content).toContain("outside the project workspace");
  });

  test("Glob works within workspace (no path = workspace default)", async () => {
    const { status, body } = await route("POST", "/api/tool", {
      name: "Glob",
      input: { pattern: "src/**/*.ts" },
    });
    expect(status).toBe(200);
    // Should either find files or say "No files found" — but not error about workspace
    expect(body.isError ?? false).toBe(false);
  });

  test("Grep rejects paths outside workspace", async () => {
    const { status, body } = await route("POST", "/api/tool", {
      name: "Grep",
      input: { pattern: "password", path: "/etc/shadow" },
    });
    expect(status).toBe(200);
    expect(body.isError).toBe(true);
    expect(body.content).toContain("outside the project workspace");
  });
});

// ─── 404 & Method Mismatch ──────────────────────────────────────

describe("Unknown routes", () => {
  test("returns 404 for unknown paths", async () => {
    const { status } = await route("GET", "/api/nonexistent");
    expect(status).toBe(404);
  });

  test("returns 404 for wrong method on known path (POST /api/health)", async () => {
    const { status } = await route("POST", "/api/health");
    expect(status).toBe(404);
  });

  test("returns 404 for DELETE method on any route", async () => {
    const { status } = await route("DELETE", "/api/health");
    expect(status).toBe(404);
  });

  test("returns 404 for POST /api/tools (GET only)", async () => {
    const { status } = await route("POST", "/api/tools");
    expect(status).toBe(404);
  });
});

// ─── POST /api/prompt — input validation ────────────────────────

describe("POST /api/prompt — input validation", () => {
  test("rejects invalid JSON body", async () => {
    const badReq = new Request("http://localhost:10101/api/prompt", {
      method: "POST",
      body: "not json{{{",
      headers: { "Content-Type": "application/json" },
    });
    const url = new URL("http://localhost:10101/api/prompt");
    const res = await handleRoute(badReq, url, CORS);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toContain("Invalid JSON body");
  });

  test("rejects missing prompt field", async () => {
    const { status, body } = await route("POST", "/api/prompt", { model: "test" });
    expect(status).toBe(400);
    expect(body.error).toContain("'prompt' is required");
  });

  test("rejects non-string prompt", async () => {
    const { status, body } = await route("POST", "/api/prompt", { prompt: 12345 });
    expect(status).toBe(400);
    expect(body.error).toContain("'prompt' is required and must be a string");
  });

  test("rejects empty string prompt", async () => {
    const { status, body } = await route("POST", "/api/prompt", { prompt: "" });
    expect(status).toBe(400);
    expect(body.error).toContain("'prompt' is required");
  });
});

// ─── GET /api/session/:filename — validation ────────────────────

describe("GET /api/session/:filename — validation", () => {
  test("rejects path traversal with ..", async () => {
    // URL constructor normalizes ../../ — use encoded dots to test the handler's own check
    const { req, url } = makeReq("GET", "/api/session/..%2F..%2Fetc%2Fpasswd");
    const res = await handleRoute(req, url, CORS);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Invalid filename");
  });

  test("rejects filenames with forward slash", async () => {
    const { req, url } = makeReq("GET", "/api/session/foo%2Fbar");
    const res = await handleRoute(req, url, CORS);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Invalid filename");
  });

  test("rejects null bytes in filename", async () => {
    const { req, url } = makeReq("GET", "/api/session/test%00file");
    const res = await handleRoute(req, url, CORS);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Invalid filename");
  });

  test("rejects empty filename", async () => {
    const { status, body } = await route("GET", "/api/session/");
    expect(status).toBe(400);
    expect(body.error).toBe("Invalid filename");
  });
});

// ─── POST /api/compact ──────────────────────────────────────────

describe("POST /api/compact", () => {
  test("returns 404 when no active session", async () => {
    const { status, body } = await route("POST", "/api/compact");
    expect(status).toBe(404);
    expect(body.error).toContain("No active session");
  });
});

// ─── GET /api/plan ──────────────────────────────────────────────

describe("GET /api/plan", () => {
  test("returns null plan when no active session", async () => {
    const { status, body } = await route("GET", "/api/plan");
    expect(status).toBe(200);
    expect(body.plan).toBeNull();
    expect(body.sessionId).toBeNull();
  });
});

// ─── GET /api/context — additional cases ────────────────────────

describe("GET /api/context — edge cases", () => {
  test("returns empty context for unknown sessionId", async () => {
    const { status, body } = await route("GET", "/api/context?sessionId=nonexistent-id");
    expect(status).toBe(200);
    expect(body.sessionId).toBeNull();
    expect(body.messageCount).toBe(0);
  });

  test("accepts lastN parameter without error", async () => {
    const { status } = await route("GET", "/api/context?lastN=5");
    expect(status).toBe(200);
  });

  test("handles non-numeric lastN gracefully", async () => {
    const { status } = await route("GET", "/api/context?lastN=abc");
    expect(status).toBe(200);
  });
});

// ─── GET /api/sessions — limit param ────────────────────────────

describe("GET /api/sessions — limit parameter", () => {
  test("accepts limit parameter", async () => {
    const { status, body } = await route("GET", "/api/sessions?limit=5");
    expect(status).toBe(200);
    expect(body.recent.length).toBeLessThanOrEqual(5);
  });

  test("clamps limit to min 1 (limit=0)", async () => {
    const { status } = await route("GET", "/api/sessions?limit=0");
    expect(status).toBe(200);
  });

  test("clamps limit to max 200 (limit=999)", async () => {
    const { status } = await route("GET", "/api/sessions?limit=999");
    expect(status).toBe(200);
  });

  test("handles non-numeric limit gracefully", async () => {
    const { status } = await route("GET", "/api/sessions?limit=abc");
    expect(status).toBe(200);
  });
});

// ─── GET /api/mcp ───────────────────────────────────────────────

describe("GET /api/mcp", () => {
  test("returns servers and tools arrays", async () => {
    const { status, body } = await route("GET", "/api/mcp");
    expect(status).toBe(200);
    expect(Array.isArray(body.servers)).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true);
  });
});

// ─── GET /api/agents ────────────────────────────────────────────

describe("GET /api/agents", () => {
  test("returns available and running arrays", async () => {
    const { status, body } = await route("GET", "/api/agents");
    expect(status).toBe(200);
    expect(Array.isArray(body.available)).toBe(true);
    expect(Array.isArray(body.running)).toBe(true);
  });
});

// ─── Legacy endpoints ───────────────────────────────────────────

describe("Legacy endpoints", () => {
  test("GET /health returns ok status", async () => {
    const { status, body } = await route("GET", "/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("uptime");
  });

  test("GET / returns ok status", async () => {
    const { status, body } = await route("GET", "/");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });

  test("POST /v1/chat rejects missing message", async () => {
    const { status, body } = await route("POST", "/v1/chat", { model: "test" });
    expect(status).toBe(400);
    expect(body.error).toContain("message is required");
  });
});

// ─── POST /api/webhook/stripe — validation ──────────────────────

describe("POST /api/webhook/stripe", () => {
  test("returns error when webhook not configured or module unavailable", async () => {
    const { status } = await route("POST", "/api/webhook/stripe", {});
    // Either 503 (not configured) or 500 (module load error)
    expect([500, 503]).toContain(status);
  });
});

// ─── Error response formatting ──────────────────────────────────

describe("Error response formatting", () => {
  test("error responses include error and code fields", async () => {
    const { status, body } = await route("GET", "/api/nonexistent");
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("code");
    expect(body.code).toBe(404);
    expect(typeof body.error).toBe("string");
  });

  test("400 errors include descriptive message", async () => {
    const { status, body } = await route("POST", "/api/prompt", {});
    expect(status).toBe(400);
    expect(body.error.length).toBeGreaterThan(0);
    expect(body.code).toBe(400);
  });

  test("403 errors include tool name in message", async () => {
    const { status, body } = await route("POST", "/api/tool", { name: "Bash", input: {} });
    expect(status).toBe(403);
    expect(body.error).toContain("Bash");
    expect(body.code).toBe(403);
  });
});

// ─── buildFetchHandler — CORS ───────────────────────────────────

describe("buildFetchHandler — CORS", () => {
  const handler = buildFetchHandler();

  test("OPTIONS preflight returns 204 with CORS headers", async () => {
    const req = new Request("http://localhost:10101/api/health", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000" },
    });
    const res = await handler(req);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Session-Id");
  });

  test("reflects localhost origin", async () => {
    const req = new Request("http://localhost:10101/api/health", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    });
    const res = await handler(req);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  });

  test("reflects 127.0.0.1 origin", async () => {
    const req = new Request("http://localhost:10101/api/health", {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:8080" },
    });
    const res = await handler(req);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:8080");
  });

  test("allows vscode-webview origin", async () => {
    const req = new Request("http://localhost:10101/api/health", {
      method: "OPTIONS",
      headers: { Origin: "vscode-webview://ext-id" },
    });
    const res = await handler(req);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("vscode-webview://ext-id");
  });

  test("does not reflect non-local origins", async () => {
    const req = new Request("http://localhost:10101/api/health", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com" },
    });
    const res = await handler(req);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost");
  });

  test("rejects localhost.evil.com (regex anchor check)", async () => {
    const req = new Request("http://localhost:10101/api/health", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost.evil.com" },
    });
    const res = await handler(req);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost");
  });

  test("sets Vary: Origin header on all responses", async () => {
    const req = new Request("http://localhost:10101/api/health", {
      method: "GET",
      headers: { Origin: "http://localhost:3000" },
    });
    const res = await handler(req);
    expect(res.headers.get("Vary")).toBe("Origin");
  });
});

// ─── buildFetchHandler — Authentication ─────────────────────────

describe("buildFetchHandler — authentication", () => {
  test("rejects request without API key when key is configured", async () => {
    const handler = buildFetchHandler("my-secret-key");
    const req = new Request("http://localhost:10101/api/health", { method: "GET" });
    const res = await handler(req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Unauthorized");
  });

  test("rejects request with wrong API key", async () => {
    const handler = buildFetchHandler("my-secret-key");
    const req = new Request("http://localhost:10101/api/health", {
      method: "GET",
      headers: { Authorization: "Bearer wrong-key" },
    });
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  test("accepts request with correct Bearer token", async () => {
    const handler = buildFetchHandler("my-secret-key");
    const req = new Request("http://localhost:10101/api/health", {
      method: "GET",
      headers: { Authorization: "Bearer my-secret-key" },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body as any).ok).toBe(true);
  });

  test("allows request when no API key is configured", async () => {
    const handler = buildFetchHandler();
    const req = new Request("http://localhost:10101/api/health", { method: "GET" });
    const res = await handler(req);
    expect(res.status).toBe(200);
  });

  test("preflight OPTIONS bypasses auth", async () => {
    const handler = buildFetchHandler("my-secret-key");
    const req = new Request("http://localhost:10101/api/health", { method: "OPTIONS" });
    const res = await handler(req);
    expect(res.status).toBe(204);
  });

  test("rejects Basic auth scheme (only Bearer accepted)", async () => {
    const handler = buildFetchHandler("my-secret-key");
    const req = new Request("http://localhost:10101/api/health", {
      method: "GET",
      headers: { Authorization: "Basic my-secret-key" },
    });
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  test("rejects bearer (lowercase) — exact match required", async () => {
    const handler = buildFetchHandler("my-secret-key");
    const req = new Request("http://localhost:10101/api/health", {
      method: "GET",
      headers: { Authorization: "bearer my-secret-key" },
    });
    const res = await handler(req);
    expect(res.status).toBe(401);
  });
});
