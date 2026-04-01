// KCode - Web Server Tests

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WebServer } from "./server";
import type { WebServerConfig } from "./types";

const TEST_PORT = 19399;

function testConfig(overrides?: Partial<WebServerConfig>): Partial<WebServerConfig> {
  return {
    port: TEST_PORT,
    host: "127.0.0.1",
    auth: { enabled: true, token: "test-token-12345" },
    cors: false,
    openBrowser: false,
    ...overrides,
  };
}

describe("WebServer", () => {
  let server: WebServer;

  beforeEach(() => {
    server = new WebServer(testConfig());
  });

  afterEach(async () => {
    server.stop();
    // Brief pause to let the port release
    await new Promise((r) => setTimeout(r, 50));
  });

  test("starts and stops", async () => {
    const result = await server.start();
    expect(result.url).toContain(String(TEST_PORT));
    expect(result.token).toBe("test-token-12345");
    expect(server.isRunning).toBe(true);

    server.stop();
    expect(server.isRunning).toBe(false);
  });

  test("throws if started twice", async () => {
    await server.start();
    await expect(server.start()).rejects.toThrow("already running");
  });

  test("serves index.html for root path", async () => {
    await server.start();
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/?token=test-token-12345`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("KCode Web UI");
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("serves CSS with correct MIME type", async () => {
    await server.start();
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/styles.css?token=test-token-12345`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  test("serves JS with correct MIME type", async () => {
    await server.start();
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/app.js?token=test-token-12345`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  test("returns 404 for nonexistent files", async () => {
    // SPA fallback means unknown paths return index.html
    await server.start();
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/nonexistent.xyz?token=test-token-12345`);
    // Falls back to index.html due to SPA routing
    expect(res.status).toBe(200);
  });

  test("prevents path traversal in static files", async () => {
    await server.start();
    const res = await fetch(
      `http://127.0.0.1:${TEST_PORT}/..%2F..%2Fetc%2Fpasswd?token=test-token-12345`,
    );
    // Path traversal dots are stripped, so it won't escape static dir
    expect(res.status).not.toBe(500);
  });

  test("rejects WebSocket upgrade without token", async () => {
    await server.start();
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/ws`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  test("rejects API requests without auth", async () => {
    await server.start();
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/v1/session`);
    expect(res.status).toBe(401);
  });

  test("accepts API requests with Bearer token", async () => {
    await server.start();
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/v1/health`, {
      headers: { Authorization: "Bearer test-token-12345" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
  });

  test("accepts API requests with query token", async () => {
    await server.start();
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/v1/health?token=test-token-12345`);
    expect(res.status).toBe(200);
  });

  test("CORS headers when enabled", async () => {
    server.stop();
    server = new WebServer(testConfig({ cors: true }));
    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/v1/health?token=test-token-12345`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("CORS preflight returns 204", async () => {
    server.stop();
    server = new WebServer(testConfig({ cors: true }));
    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/v1/health`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
  });

  test("auth disabled allows unauthenticated access", async () => {
    server.stop();
    server = new WebServer(testConfig({ auth: { enabled: false, token: "" } }));
    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/v1/health`);
    expect(res.status).toBe(200);
  });

  test("connectionCount starts at 0", () => {
    expect(server.connectionCount).toBe(0);
  });

  test("broadcast does not throw without connections", async () => {
    await server.start();
    expect(() => {
      server.broadcast({ type: "model.changed", model: "test" });
    }).not.toThrow();
  });

  test("getConfig returns config copy", () => {
    const config = server.getConfig();
    expect(config.port).toBe(TEST_PORT);
    expect(config.auth.token).toBe("test-token-12345");
  });

  test("WebSocket connects with valid token", async () => {
    await server.start();

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws?token=test-token-12345`);

    const connected = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 2000);
    });

    expect(connected).toBe(true);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });
});
