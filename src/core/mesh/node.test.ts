// KCode - P2P Agent Mesh Node Tests

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetMeshNode, getMeshNode, MeshNode, shutdownMeshNode } from "./node";
import { generateTeamToken } from "./security";
import type { MeshTask, PeerCapabilities, PeerInfo } from "./types";

// ─── Helpers ───────────────────────────────────────────────────

function makePeer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    nodeId: `peer-${Math.random().toString(36).slice(2, 8)}`,
    hostname: "test-host",
    ip: "127.0.0.1",
    port: 19200,
    capabilities: {
      models: ["test-model"],
      gpuVram: 24,
      cpuCores: 8,
      maxConcurrent: 2,
    },
    status: "online",
    lastSeen: Date.now(),
    ...overrides,
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

// ─── Node Construction ─────────────────────────────────────────

describe("MeshNode - construction", () => {
  test("generates a unique nodeId on creation", () => {
    const node1 = new MeshNode();
    const node2 = new MeshNode();
    expect(node1.nodeId).not.toBe(node2.nodeId);
    expect(node1.nodeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("starts in stopped state", () => {
    const node = new MeshNode();
    expect(node.status).toBe("stopped");
  });

  test("uses default settings", () => {
    const node = new MeshNode();
    expect(node.status).toBe("stopped");
    expect(node.error).toBeNull();
  });

  test("accepts custom capabilities", () => {
    const caps: PeerCapabilities = {
      models: ["llama-70b"],
      gpuVram: 48,
      cpuCores: 16,
      maxConcurrent: 4,
    };
    const node = new MeshNode({ capabilities: caps });
    const info = node.getLocalPeerInfo();
    expect(info.capabilities.gpuVram).toBe(48);
    expect(info.capabilities.models).toContain("llama-70b");
  });

  test("accepts custom settings", () => {
    const node = new MeshNode({
      settings: { port: 19300, maxConcurrentTasks: 5 },
    });
    // Port is reflected in local peer info
    const info = node.getLocalPeerInfo();
    expect(info.port).toBe(19300);
  });
});

// ─── Node Lifecycle ─────────────────────────────────────────────

describe("MeshNode - lifecycle", () => {
  let node: MeshNode;

  afterEach(async () => {
    if (node) await node.stop();
  });

  test("starts and transitions to running", async () => {
    const port = 19700 + Math.floor(Math.random() * 200);
    node = new MeshNode({
      settings: {
        port,
        teamToken: generateTeamToken(),
        discovery: "manual",
      },
    });
    await node.start();
    expect(node.status).toBe("running");
  });

  test("generates team token if not provided", async () => {
    const port = 19700 + Math.floor(Math.random() * 200);
    node = new MeshNode({
      settings: { port, discovery: "manual" },
    });
    expect(node.teamToken).toBeNull();
    await node.start();
    expect(node.teamToken).not.toBeNull();
    expect(node.teamToken!.length).toBe(64);
  });

  test("stop transitions to stopped state", async () => {
    const port = 19700 + Math.floor(Math.random() * 200);
    node = new MeshNode({
      settings: {
        port,
        teamToken: generateTeamToken(),
        discovery: "manual",
      },
    });
    await node.start();
    await node.stop();
    expect(node.status).toBe("stopped");
  });

  test("start is idempotent when already running", async () => {
    const port = 19700 + Math.floor(Math.random() * 200);
    node = new MeshNode({
      settings: {
        port,
        teamToken: generateTeamToken(),
        discovery: "manual",
      },
    });
    await node.start();
    await node.start(); // Should not throw
    expect(node.status).toBe("running");
  });
});

// ─── Task Submission ────────────────────────────────────────────

describe("MeshNode - task submission", () => {
  let node: MeshNode;

  afterEach(async () => {
    if (node) await node.stop();
  });

  test("executes locally when no peers available", async () => {
    const port = 19800 + Math.floor(Math.random() * 100);
    node = new MeshNode({
      settings: {
        port,
        teamToken: generateTeamToken(),
        discovery: "manual",
      },
      localExecutor: async (task) => `local-result-${task.id}`,
    });
    await node.start();

    const task = makeTask();
    const result = await node.submitTask(task);
    expect(result.status).toBe("completed");
    expect(result.output).toContain(task.id);
    expect(result.fromNode).toBe("local");
  });

  test("falls back to local when peer fails", async () => {
    const port = 19800 + Math.floor(Math.random() * 100);
    node = new MeshNode({
      settings: {
        port,
        teamToken: generateTeamToken(),
        discovery: "manual",
      },
      localExecutor: async (task) => `fallback-${task.id}`,
    });
    await node.start();

    // Add a fake peer that won't be reachable
    node.addPeer(
      makePeer({
        nodeId: "unreachable",
        ip: "127.0.0.1",
        port: 19999,
        status: "online",
      }),
    );

    const task = makeTask();
    const result = await node.submitTask(task);
    expect(result.status).toBe("completed");
    expect(result.output).toContain("fallback");
  });

  test("rejects task when at max concurrent capacity", async () => {
    const port = 19800 + Math.floor(Math.random() * 100);
    node = new MeshNode({
      settings: {
        port,
        teamToken: generateTeamToken(),
        discovery: "manual",
        maxConcurrentTasks: 0, // No capacity
      },
    });
    await node.start();

    await expect(node.submitTask(makeTask())).rejects.toThrow("Concurrent task limit");
  });

  test("stores result after task completes", async () => {
    const port = 19800 + Math.floor(Math.random() * 100);
    node = new MeshNode({
      settings: {
        port,
        teamToken: generateTeamToken(),
        discovery: "manual",
      },
      localExecutor: async () => "done",
    });
    await node.start();

    const task = makeTask();
    await node.submitTask(task);
    const stored = node.getTaskResult(task.id);
    expect(stored).toBeDefined();
    expect(stored?.status).toBe("completed");
  });
});

// ─── Peer Management ────────────────────────────────────────────

describe("MeshNode - peer management", () => {
  test("addPeer makes peer visible", () => {
    const node = new MeshNode();
    const peer = makePeer({ nodeId: "added-peer" });
    node.addPeer(peer);
    expect(node.getPeers()).toHaveLength(1);
    expect(node.getPeers()[0].nodeId).toBe("added-peer");
  });

  test("getAvailablePeers excludes self", () => {
    const node = new MeshNode();
    // Add the local node itself
    node.addPeer(node.getLocalPeerInfo());
    // Add a remote peer
    node.addPeer(makePeer({ nodeId: "remote-1", status: "online" }));
    expect(node.getAvailablePeers()).toHaveLength(1);
    expect(node.getAvailablePeers()[0].nodeId).toBe("remote-1");
  });

  test("updateCapabilities modifies local info", () => {
    const node = new MeshNode({
      capabilities: { models: [], gpuVram: 0, cpuCores: 1, maxConcurrent: 1 },
    });
    node.updateCapabilities({ gpuVram: 48, models: ["big-model"] });
    const info = node.getLocalPeerInfo();
    expect(info.capabilities.gpuVram).toBe(48);
    expect(info.capabilities.models).toContain("big-model");
  });
});

// ─── Team Management ────────────────────────────────────────────

describe("MeshNode - team management", () => {
  test("initTeam generates and sets a token", () => {
    const node = new MeshNode();
    const token = node.initTeam();
    expect(token).toHaveLength(64);
    expect(node.teamToken).toBe(token);
  });

  test("joinTeam sets the provided token", () => {
    const node = new MeshNode();
    const token = generateTeamToken();
    node.joinTeam(token);
    expect(node.teamToken).toBe(token);
  });
});

// ─── Singleton ──────────────────────────────────────────────────

describe("MeshNode - singleton", () => {
  afterEach(async () => {
    await shutdownMeshNode();
    _resetMeshNode();
  });

  test("getMeshNode returns the same instance", () => {
    const a = getMeshNode();
    const b = getMeshNode();
    expect(a).toBe(b);
  });

  test("shutdownMeshNode stops and clears the singleton", async () => {
    const node = getMeshNode();
    expect(node).toBeDefined();
    await shutdownMeshNode();
    _resetMeshNode();
    const newNode = getMeshNode();
    expect(newNode).not.toBe(node);
  });
});

// ─── getLocalPeerInfo ──────────────────────────────────────────

describe("MeshNode - getLocalPeerInfo", () => {
  test("returns correct structure", () => {
    const node = new MeshNode({
      settings: { port: 19250 },
      capabilities: { models: ["m1"], gpuVram: 24, cpuCores: 8, maxConcurrent: 2 },
    });
    const info = node.getLocalPeerInfo();
    expect(info.nodeId).toBe(node.nodeId);
    expect(info.port).toBe(19250);
    expect(info.capabilities.gpuVram).toBe(24);
    expect(info.status).toBe("offline"); // Not started yet
  });

  test("reflects running status after start", async () => {
    const port = 19900 + Math.floor(Math.random() * 90);
    const node = new MeshNode({
      settings: { port, teamToken: generateTeamToken(), discovery: "manual" },
    });
    await node.start();
    const info = node.getLocalPeerInfo();
    expect(info.status).toBe("online");
    await node.stop();
  });
});
