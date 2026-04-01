// KCode - Extension API Tests
// Covers: routing, middleware pipeline, SSE streaming, endpoint behavior

import { beforeEach, describe, expect, test } from "bun:test";
import { ExtensionAPI } from "./api";
import { createAuthMiddleware } from "./middleware";
import type { Middleware } from "./types";

// ─── Helpers ───────────────────────────────────────────────────

const BASE = "http://localhost:19300/api/ext/v1";

function makeReq(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  return new Request(`${BASE}${path}`, init);
}

async function call(
  api: ExtensionAPI,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any; headers: Headers }> {
  const req = makeReq(method, path, body, headers);
  const res = await api.handle(req);
  let resBody: any;
  const ct = res.headers.get("Content-Type") || "";
  if (ct.includes("json")) {
    resBody = await res.json();
  } else if (ct.includes("event-stream")) {
    resBody = null; // SSE streams are tested separately
  } else {
    resBody = await res.text();
  }
  return { status: res.status, body: resBody, headers: res.headers };
}

let api: ExtensionAPI;

beforeEach(() => {
  api = new ExtensionAPI();
});

// ─── GET /health ───────────────────────────────────────────────

describe("GET /health", () => {
  test("returns correct structure", async () => {
    const { status, body } = await call(api, "GET", "/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("uptime");
    expect(body).toHaveProperty("model");
    expect(body).toHaveProperty("sessionId");
    expect(typeof body.uptime).toBe("number");
  });
});

// ─── GET /info ─────────────────────────────────────────────────

describe("GET /info", () => {
  test("returns version, tools, models, features", async () => {
    const { status, body } = await call(api, "GET", "/info");
    expect(status).toBe(200);
    expect(body).toHaveProperty("version");
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
    expect(Array.isArray(body.models)).toBe(true);
    expect(Array.isArray(body.features)).toBe(true);
  });
});

// ─── Auth middleware ───────────────────────────────────────────

describe("auth middleware", () => {
  test("blocks unauthorized requests", async () => {
    const secureApi = new ExtensionAPI({ authToken: "my-secret" });
    secureApi.use(createAuthMiddleware("my-secret"));

    const { status, body } = await call(secureApi, "GET", "/health");
    expect(status).toBe(401);
    expect(body.code).toBe("AUTH_REQUIRED");
  });

  test("allows authorized requests", async () => {
    const secureApi = new ExtensionAPI({ authToken: "my-secret" });
    secureApi.use(createAuthMiddleware("my-secret"));

    const { status, body } = await call(secureApi, "GET", "/health", undefined, {
      Authorization: "Bearer my-secret",
    });
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });
});

// ─── POST /messages ────────────────────────────────────────────

describe("POST /messages", () => {
  test("accepts JSON body with content", async () => {
    const { status, body } = await call(api, "POST", "/messages", {
      content: "Hello, KCode!",
    });
    expect(status).toBe(200);
    expect(body).toHaveProperty("id");
    expect(body.role).toBe("assistant");
    expect(body.content).toContain("Hello, KCode!");
  });

  test("returns 400 for missing content", async () => {
    const { status, body } = await call(api, "POST", "/messages", {});
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_INPUT");
  });
});

// ─── GET /stream ───────────────────────────────────────────────

describe("GET /stream", () => {
  test("returns text/event-stream content type", async () => {
    const req = makeReq("GET", "/stream");
    const res = await api.handle(req);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  test("SSE stream format includes keepalive", async () => {
    const req = makeReq("GET", "/stream");
    const res = await api.handle(req);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain(": keepalive");
    reader.releaseLock();
  });
});

// ─── POST /tools/:name ────────────────────────────────────────

describe("POST /tools/:name", () => {
  test("routes to correct tool name", async () => {
    const { status, body } = await call(api, "POST", "/tools/Read", {
      file_path: "/tmp/test.txt",
    });
    expect(status).toBe(200);
    expect(body.name).toBe("Read");
    expect(body.success).toBe(true);
  });

  test("emits tool events", async () => {
    const events: string[] = [];
    api.getEventEmitter().on("tool.started", (e) => events.push(e.type));
    api.getEventEmitter().on("tool.completed", (e) => events.push(e.type));

    await call(api, "POST", "/tools/Bash", { command: "echo hi" });

    expect(events).toContain("tool.started");
    expect(events).toContain("tool.completed");
  });
});

// ─── 404 for unknown paths ─────────────────────────────────────

describe("unknown paths", () => {
  test("returns 404 for unknown route", async () => {
    const { status, body } = await call(api, "GET", "/nonexistent");
    expect(status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("returns 404 for path outside API prefix", async () => {
    const req = new Request("http://localhost:19300/wrong/path");
    const res = await api.handle(req);
    expect(res.status).toBe(404);
  });
});

// ─── Middleware pipeline ───────────────────────────────────────

describe("middleware pipeline", () => {
  test("runs middlewares in order", async () => {
    const order: number[] = [];

    const mw1: Middleware = async () => {
      order.push(1);
      return null;
    };
    const mw2: Middleware = async () => {
      order.push(2);
      return null;
    };

    api.use(mw1);
    api.use(mw2);

    await call(api, "GET", "/health");

    expect(order).toEqual([1, 2]);
  });

  test("short-circuits when middleware returns a Response", async () => {
    const order: number[] = [];

    const mw1: Middleware = async () => {
      order.push(1);
      return new Response(JSON.stringify({ blocked: true }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    };
    const mw2: Middleware = async () => {
      order.push(2);
      return null;
    };

    api.use(mw1);
    api.use(mw2);

    const { status, body } = await call(api, "GET", "/health");

    expect(status).toBe(403);
    expect(body.blocked).toBe(true);
    expect(order).toEqual([1]); // mw2 never ran
  });
});

// ─── GET /tools ────────────────────────────────────────────────

describe("GET /tools", () => {
  test("returns an array of tools", async () => {
    const { status, body } = await call(api, "GET", "/tools");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toHaveProperty("name");
    expect(body[0]).toHaveProperty("description");
  });
});

// ─── Memory endpoints ──────────────────────────────────────────

describe("memory endpoints", () => {
  test("POST /memories creates a memory", async () => {
    const { status, body } = await call(api, "POST", "/memories", {
      type: "note",
      title: "Test memory",
      content: "Some content",
    });
    expect(status).toBe(201);
    expect(body).toHaveProperty("id");
    expect(body.title).toBe("Test memory");
  });

  test("POST /memories returns 400 for missing fields", async () => {
    const { status } = await call(api, "POST", "/memories", { type: "note" });
    expect(status).toBe(400);
  });

  test("GET /memories returns array", async () => {
    const { status, body } = await call(api, "GET", "/memories");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  test("DELETE /memories/:id returns ok", async () => {
    const { status, body } = await call(api, "DELETE", "/memories/mem-123");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });
});

// ─── Config endpoints ──────────────────────────────────────────

describe("config endpoints", () => {
  test("GET /config returns config without authToken", async () => {
    const secureApi = new ExtensionAPI({ authToken: "secret" });
    const req = makeReq("GET", "/config");
    const res = await secureApi.handle(req);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("authToken");
    expect(body).toHaveProperty("port");
  });

  test("PATCH /config updates config", async () => {
    const { status, body } = await call(api, "PATCH", "/config", { rateLimit: 120 });
    expect(status).toBe(200);
    expect(body.rateLimit).toBe(120);
  });
});

// ─── Session endpoints ─────────────────────────────────────────

describe("session endpoints", () => {
  test("POST /sessions creates a session", async () => {
    const { status, body } = await call(api, "POST", "/sessions", { model: "gpt-4" });
    expect(status).toBe(201);
    expect(body).toHaveProperty("id");
    expect(body.model).toBe("gpt-4");
  });

  test("GET /sessions returns array", async () => {
    const { status, body } = await call(api, "GET", "/sessions");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });
});

// ─── OpenAPI schema ────────────────────────────────────────────

describe("GET /openapi.json", () => {
  test("returns valid OpenAPI schema", async () => {
    const { status, body } = await call(api, "GET", "/openapi.json");
    expect(status).toBe(200);
    expect(body.openapi).toBe("3.0.3");
    expect(body).toHaveProperty("paths");
    expect(body).toHaveProperty("components");
    expect(body.info.title).toContain("KCode");
  });
});

// ─── Event emitter integration ─────────────────────────────────

describe("event emitter", () => {
  test("getEventEmitter returns the emitter instance", () => {
    const emitter = api.getEventEmitter();
    expect(emitter).toBeDefined();
    expect(typeof emitter.on).toBe("function");
    expect(typeof emitter.emit).toBe("function");
  });

  test("POST /messages emits message.created event", async () => {
    let emitted = false;
    api.getEventEmitter().on("message.created", () => {
      emitted = true;
    });

    await call(api, "POST", "/messages", { content: "test" });
    expect(emitted).toBe(true);
  });
});
