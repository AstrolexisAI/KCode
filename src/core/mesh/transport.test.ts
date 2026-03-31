// KCode - P2P Agent Mesh Transport Tests

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { MeshTransport, type TransportEventHandlers } from "./transport";
import type { PeerInfo, MeshTask, MeshTaskHandle, MeshResult } from "./types";
import { generateTeamToken } from "./security";

// ─── Helpers ───────────────────────────────────────────────────

const TEST_TOKEN = generateTeamToken();

function makeTransport(
  overrides: Partial<{ port: number; handlers: TransportEventHandlers }> = {},
): MeshTransport {
  const port = overrides.port ?? (19300 + Math.floor(Math.random() * 1000));
  return new MeshTransport(
    { port, teamToken: TEST_TOKEN },
    overrides.handlers ?? {},
  );
}

function makePeer(port: number): PeerInfo {
  return {
    nodeId: "test-peer",
    hostname: "test-host",
    ip: "127.0.0.1",
    port,
    capabilities: { models: [], gpuVram: 0, cpuCores: 1, maxConcurrent: 1 },
    status: "online",
    lastSeen: Date.now(),
  };
}

function makeTask(overrides: Partial<MeshTask> = {}): MeshTask {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    type: "query",
    priority: "normal",
    timeout: 5000,
    ...overrides,
  };
}

// ─── Server Lifecycle ──────────────────────────────────────────

describe("MeshTransport - lifecycle", () => {
  let transport: MeshTransport;

  afterEach(() => {
    transport?.stop();
  });

  test("starts and stops without errors", async () => {
    transport = makeTransport();
    await transport.start();
    expect(transport.running).toBe(true);
    transport.stop();
    expect(transport.running).toBe(false);
  });

  test("start is idempotent", async () => {
    transport = makeTransport();
    await transport.start();
    await transport.start(); // Should be a no-op
    expect(transport.running).toBe(true);
  });

  test("stop is idempotent", async () => {
    transport = makeTransport();
    await transport.start();
    transport.stop();
    transport.stop(); // No error
    expect(transport.running).toBe(false);
  });

  test("throws without team token", async () => {
    transport = new MeshTransport({ port: 19399, teamToken: "" });
    await expect(transport.start()).rejects.toThrow("team token");
  });
});

// ─── Request Handling ──────────────────────────────────────────

describe("MeshTransport - request handling", () => {
  let transport: MeshTransport;
  let port: number;

  beforeEach(async () => {
    port = 19400 + Math.floor(Math.random() * 500);
    transport = makeTransport({
      port,
      handlers: {
        onCapabilities: () =>
          makePeer(port),
        onTask: async (task) => ({
          taskId: task.id,
          assignedTo: "test-node",
          status: "running" as const,
          submittedAt: Date.now(),
        }),
        onResult: async () => {},
      },
    });
    await transport.start();
  });

  afterEach(() => {
    transport?.stop();
  });

  test("health endpoint returns OK", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: { "X-Team-Token": TEST_TOKEN },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
  });

  test("rejects unauthenticated requests", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    expect(res.status).toBe(401);
  });

  test("rejects wrong token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: { "X-Team-Token": "wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  test("capabilities endpoint returns peer info", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/capabilities`, {
      headers: { "X-Team-Token": TEST_TOKEN },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.nodeId).toBe("test-peer");
  });

  test("task endpoint accepts a valid task", async () => {
    const task = makeTask();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/task`, {
      method: "POST",
      headers: {
        "X-Team-Token": TEST_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(task),
    });
    expect(res.status).toBe(200);
    const handle = await res.json();
    expect(handle.taskId).toBe(task.id);
    expect(handle.assignedTo).toBe("test-node");
  });

  test("task endpoint rejects invalid task (missing id)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/task`, {
      method: "POST",
      headers: {
        "X-Team-Token": TEST_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "query" }),
    });
    expect(res.status).toBe(400);
  });

  test("result endpoint acknowledges result", async () => {
    const result: MeshResult = {
      taskId: "task-1",
      status: "completed",
      output: "done",
      durationMs: 100,
      fromNode: "remote",
    };
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/result`, {
      method: "POST",
      headers: {
        "X-Team-Token": TEST_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(result),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.acknowledged).toBe(true);
  });

  test("returns 404 for unknown endpoints", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/unknown`, {
      headers: { "X-Team-Token": TEST_TOKEN },
    });
    expect(res.status).toBe(404);
  });
});

// ─── Handlers not configured ───────────────────────────────────

describe("MeshTransport - missing handlers", () => {
  let transport: MeshTransport;
  let port: number;

  beforeEach(async () => {
    port = 19500 + Math.floor(Math.random() * 500);
    transport = makeTransport({ port, handlers: {} });
    await transport.start();
  });

  afterEach(() => {
    transport?.stop();
  });

  test("capabilities returns 503 when handler not set", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/capabilities`, {
      headers: { "X-Team-Token": TEST_TOKEN },
    });
    expect(res.status).toBe(503);
  });

  test("task returns 503 when handler not set", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/task`, {
      method: "POST",
      headers: {
        "X-Team-Token": TEST_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(makeTask()),
    });
    expect(res.status).toBe(503);
  });

  test("result returns 503 when handler not set", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/result`, {
      method: "POST",
      headers: {
        "X-Team-Token": TEST_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ taskId: "x", status: "completed", durationMs: 0, fromNode: "y" }),
    });
    expect(res.status).toBe(503);
  });
});

// ─── Client Methods ────────────────────────────────────────────

describe("MeshTransport - client methods", () => {
  let serverTransport: MeshTransport;
  let clientTransport: MeshTransport;
  let serverPort: number;

  beforeEach(async () => {
    serverPort = 19600 + Math.floor(Math.random() * 300);
    serverTransport = makeTransport({
      port: serverPort,
      handlers: {
        onCapabilities: () => makePeer(serverPort),
        onTask: async (task) => ({
          taskId: task.id,
          assignedTo: "server-node",
          status: "running" as const,
          submittedAt: Date.now(),
        }),
        onResult: async () => {},
      },
    });
    await serverTransport.start();

    clientTransport = makeTransport({ port: serverPort + 100 });
  });

  afterEach(() => {
    serverTransport?.stop();
    clientTransport?.stop();
  });

  test("sendTask sends task to a peer server", async () => {
    const peer = makePeer(serverPort);
    const task = makeTask();
    const handle = await clientTransport.sendTask(peer, task);
    expect(handle.taskId).toBe(task.id);
    expect(handle.assignedTo).toBe("server-node");
  });

  test("ping returns positive latency for reachable peer", async () => {
    const peer = makePeer(serverPort);
    const latency = await clientTransport.ping(peer);
    expect(latency).toBeGreaterThanOrEqual(0);
    expect(latency).toBeLessThan(5000);
  });

  test("ping returns -1 for unreachable peer", async () => {
    const peer = makePeer(19999); // Nothing on this port
    const latency = await clientTransport.ping(peer);
    expect(latency).toBe(-1);
  });

  test("sendResult sends result to peer", async () => {
    const peer = makePeer(serverPort);
    const result: MeshResult = {
      taskId: "t1",
      status: "completed",
      output: "done",
      durationMs: 50,
      fromNode: "client",
    };
    // Should not throw
    await clientTransport.sendResult(peer, result);
  });
});
