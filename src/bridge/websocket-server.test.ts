// Tests for Bridge WebSocket Server

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PermissionBridge } from "./permission-bridge";
import { createMessage, serializeMessage } from "./protocol";
import { SessionManager } from "./session-manager";
import type {
  PingMessage,
  SessionCreateMessage,
  SessionDestroyMessage,
  SessionErrorMessage,
} from "./types";
import { BridgeWebSocketServer } from "./websocket-server";

const TEST_TOKEN = "test-token-12345";
let server: BridgeWebSocketServer;
let sessionManager: SessionManager;
let permissionBridge: PermissionBridge;
let port: number;

// Use a port range unlikely to conflict
let nextPort = 19150;
function getPort(): number {
  return nextPort++;
}

beforeEach(() => {
  port = getPort();
  sessionManager = new SessionManager({
    maxSessions: 10,
    idleTimeoutMs: 300_000,
    gcIntervalMs: 60_000_000,
  });
  permissionBridge = new PermissionBridge({ timeoutMs: 5_000 });
  server = new BridgeWebSocketServer({
    token: TEST_TOKEN,
    sessionManager,
    permissionBridge,
  });
  server.start(port);
});

afterEach(async () => {
  server.stop();
  await sessionManager.shutdown();
});

// Helper: connect a WebSocket with auth
function connectWs(token: string = TEST_TOKEN): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}

// Helper: wait for next message from WS
function waitForMessage(ws: WebSocket, timeoutMs: number = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout waiting for message")), timeoutMs);
    ws.onmessage = (e) => {
      clearTimeout(timer);
      resolve(
        typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer),
      );
    };
  });
}

// ─── Health Endpoint ────────────────────────────────────────────

describe("health endpoint", () => {
  test("responds with status ok", async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/health`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
    expect(typeof body.sessions).toBe("number");
    expect(typeof body.clients).toBe("number");
  });
});

// ─── Connection & Auth ──────────────────────────────────────────

describe("connection", () => {
  test("accepts connection with valid token", async () => {
    const ws = await connectWs();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test("rejects connection with invalid token", async () => {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=wrong`);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.close();
          reject(new Error("Should not have opened"));
        };
        ws.onerror = () => resolve();
        ws.onclose = (e) => resolve();
      });
    } catch {
      // Expected — connection should fail
    }
  });
});

// ─── Ping/Pong ──────────────────────────────────────────────────

describe("ping/pong", () => {
  test("responds to ping with pong", async () => {
    const ws = await connectWs();
    const ping = createMessage<PingMessage>("ping", {});
    ws.send(serializeMessage(ping));

    const reply = await waitForMessage(ws);
    const parsed = JSON.parse(reply);
    expect(parsed.type).toBe("pong");
    ws.close();
  });
});

// ─── Session Create ─────────────────────────────────────────────

describe("session.create", () => {
  test("creates a session and returns session.created", async () => {
    const ws = await connectWs();
    const msg = createMessage<SessionCreateMessage>("session.create", {
      dir: "/tmp/test-project",
      spawnMode: "single-session",
      model: "test-model",
    });
    ws.send(serializeMessage(msg));

    const reply = await waitForMessage(ws);
    const parsed = JSON.parse(reply);
    expect(parsed.type).toBe("session.created");
    expect(parsed.sessionId).toBeTruthy();
    expect(parsed.dir).toBe("/tmp/test-project");
    expect(parsed.model).toBe("test-model");

    // Session should exist in manager
    expect(sessionManager.sessionCount).toBe(1);
    ws.close();
  });
});

// ─── Session Destroy ────────────────────────────────────────────

describe("session.destroy", () => {
  test("destroys a session and returns session.done", async () => {
    const ws = await connectWs();

    // Create first
    const create = createMessage<SessionCreateMessage>("session.create", {
      dir: "/tmp/test",
      spawnMode: "single-session",
    });
    ws.send(serializeMessage(create));
    const created = JSON.parse(await waitForMessage(ws));
    const sessionId = created.sessionId;

    // Destroy
    const destroy = createMessage<SessionDestroyMessage>("session.destroy", {
      sessionId,
    });
    ws.send(serializeMessage(destroy));

    const done = JSON.parse(await waitForMessage(ws));
    expect(done.type).toBe("session.done");
    expect(done.sessionId).toBe(sessionId);

    // Session should be gone
    expect(sessionManager.sessionCount).toBe(0);
    ws.close();
  });
});

// ─── Invalid Messages ───────────────────────────────────────────

describe("invalid messages", () => {
  test("returns error for invalid JSON", async () => {
    const ws = await connectWs();
    ws.send("not valid json");

    const reply = await waitForMessage(ws);
    const parsed = JSON.parse(reply);
    expect(parsed.type).toBe("session.error");
    expect(parsed.error).toContain("Invalid");
    ws.close();
  });

  test("returns error for message to non-existent session", async () => {
    const ws = await connectWs();
    const msg = JSON.stringify({
      type: "session.message",
      id: "test-id",
      timestamp: new Date().toISOString(),
      sessionId: "nonexistent",
      content: "hello",
    });
    ws.send(msg);

    const reply = await waitForMessage(ws);
    const parsed = JSON.parse(reply);
    expect(parsed.type).toBe("session.error");
    expect(parsed.error).toContain("not found");
    ws.close();
  });
});

// ─── 404 ────────────────────────────────────────────────────────

describe("HTTP routes", () => {
  test("returns 404 for unknown paths", async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(resp.status).toBe(404);
  });
});
