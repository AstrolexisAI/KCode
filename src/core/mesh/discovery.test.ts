// KCode - P2P Agent Mesh Discovery Tests

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PEER_TIMEOUT_MS, PeerDiscovery } from "./discovery";
import type { PeerInfo } from "./types";

// ─── Helpers ───────────────────────────────────────────────────

function makePeer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    nodeId: `node-${Math.random().toString(36).slice(2, 8)}`,
    hostname: "test-host",
    ip: "192.168.1.100",
    port: 19200,
    capabilities: {
      models: ["qwen2.5-coder:7b"],
      gpuVram: 24,
      cpuCores: 8,
      maxConcurrent: 2,
    },
    status: "online",
    lastSeen: Date.now(),
    ...overrides,
  };
}

// ─── Basic Peer Management ─────────────────────────────────────

describe("PeerDiscovery - peer management", () => {
  let discovery: PeerDiscovery;

  beforeEach(() => {
    discovery = new PeerDiscovery("local-node");
  });

  afterEach(() => {
    discovery.stop();
  });

  test("starts with no peers", () => {
    expect(discovery.size).toBe(0);
    expect(discovery.getAllPeers()).toHaveLength(0);
  });

  test("updatePeer adds a new peer", () => {
    const peer = makePeer({ nodeId: "peer-1" });
    discovery.updatePeer(peer);
    expect(discovery.size).toBe(1);
    expect(discovery.getPeer("peer-1")).toBeDefined();
  });

  test("updatePeer updates existing peer", () => {
    const peer = makePeer({ nodeId: "peer-1", status: "online" });
    discovery.updatePeer(peer);
    discovery.updatePeer({ ...peer, status: "busy" });
    expect(discovery.getPeer("peer-1")?.status).toBe("busy");
    expect(discovery.size).toBe(1);
  });

  test("removePeer removes a peer", () => {
    const peer = makePeer({ nodeId: "peer-1" });
    discovery.updatePeer(peer);
    expect(discovery.removePeer("peer-1")).toBe(true);
    expect(discovery.size).toBe(0);
  });

  test("removePeer returns false for unknown peer", () => {
    expect(discovery.removePeer("nonexistent")).toBe(false);
  });

  test("markOffline sets peer status to offline", () => {
    const peer = makePeer({ nodeId: "peer-1", status: "online" });
    discovery.updatePeer(peer);
    discovery.markOffline("peer-1");
    expect(discovery.getPeer("peer-1")?.status).toBe("offline");
  });

  test("markOffline is a no-op for unknown peers", () => {
    discovery.markOffline("nonexistent");
    expect(discovery.size).toBe(0);
  });

  test("getPeer returns undefined for unknown peer", () => {
    expect(discovery.getPeer("nonexistent")).toBeUndefined();
  });
});

// ─── getAvailablePeers ─────────────────────────────────────────

describe("PeerDiscovery - getAvailablePeers", () => {
  let discovery: PeerDiscovery;

  beforeEach(() => {
    discovery = new PeerDiscovery("local-node");
  });

  afterEach(() => {
    discovery.stop();
  });

  test("returns only online peers", () => {
    discovery.updatePeer(makePeer({ nodeId: "p1", status: "online" }));
    discovery.updatePeer(makePeer({ nodeId: "p2", status: "offline" }));
    discovery.updatePeer(makePeer({ nodeId: "p3", status: "busy" }));
    expect(discovery.getAvailablePeers()).toHaveLength(1);
    expect(discovery.getAvailablePeers()[0]!.nodeId).toBe("p1");
  });

  test("excludes the local node", () => {
    discovery.updatePeer(makePeer({ nodeId: "local-node", status: "online" }));
    discovery.updatePeer(makePeer({ nodeId: "remote-1", status: "online" }));
    expect(discovery.getAvailablePeers()).toHaveLength(1);
    expect(discovery.getAvailablePeers()[0]!.nodeId).toBe("remote-1");
  });

  test("sorts by GPU VRAM descending", () => {
    discovery.updatePeer(
      makePeer({
        nodeId: "low-vram",
        status: "online",
        capabilities: { models: [], gpuVram: 8, cpuCores: 4, maxConcurrent: 2 },
      }),
    );
    discovery.updatePeer(
      makePeer({
        nodeId: "high-vram",
        status: "online",
        capabilities: { models: [], gpuVram: 48, cpuCores: 16, maxConcurrent: 4 },
      }),
    );
    discovery.updatePeer(
      makePeer({
        nodeId: "mid-vram",
        status: "online",
        capabilities: { models: [], gpuVram: 24, cpuCores: 8, maxConcurrent: 2 },
      }),
    );

    const available = discovery.getAvailablePeers();
    expect(available).toHaveLength(3);
    expect(available[0]!.nodeId).toBe("high-vram");
    expect(available[1]!.nodeId).toBe("mid-vram");
    expect(available[2]!.nodeId).toBe("low-vram");
  });

  test("returns empty array when no peers are available", () => {
    expect(discovery.getAvailablePeers()).toHaveLength(0);
  });
});

// ─── pruneStale ────────────────────────────────────────────────

describe("PeerDiscovery - pruneStale", () => {
  let discovery: PeerDiscovery;

  beforeEach(() => {
    discovery = new PeerDiscovery("local-node");
  });

  afterEach(() => {
    discovery.stop();
  });

  test("marks stale peers as offline", () => {
    const stalePeer = makePeer({
      nodeId: "stale-1",
      status: "online",
      lastSeen: Date.now() - PEER_TIMEOUT_MS - 1000,
    });
    discovery.updatePeer(stalePeer);
    const pruned = discovery.pruneStale();
    expect(pruned).toBe(1);
    expect(discovery.getPeer("stale-1")?.status).toBe("offline");
  });

  test("does not prune fresh peers", () => {
    const freshPeer = makePeer({
      nodeId: "fresh-1",
      status: "online",
      lastSeen: Date.now(),
    });
    discovery.updatePeer(freshPeer);
    const pruned = discovery.pruneStale();
    expect(pruned).toBe(0);
    expect(discovery.getPeer("fresh-1")?.status).toBe("online");
  });

  test("does not prune the local node", () => {
    const localPeer = makePeer({
      nodeId: "local-node",
      status: "online",
      lastSeen: Date.now() - PEER_TIMEOUT_MS - 1000,
    });
    discovery.updatePeer(localPeer);
    const pruned = discovery.pruneStale();
    expect(pruned).toBe(0);
    expect(discovery.getPeer("local-node")?.status).toBe("online");
  });

  test("handles mix of stale and fresh peers", () => {
    discovery.updatePeer(
      makePeer({
        nodeId: "fresh",
        status: "online",
        lastSeen: Date.now(),
      }),
    );
    discovery.updatePeer(
      makePeer({
        nodeId: "stale",
        status: "online",
        lastSeen: Date.now() - PEER_TIMEOUT_MS - 5000,
      }),
    );
    const pruned = discovery.pruneStale();
    expect(pruned).toBe(1);
    expect(discovery.getPeer("fresh")?.status).toBe("online");
    expect(discovery.getPeer("stale")?.status).toBe("offline");
  });
});

// ─── mDNS Discovery ─────────────────────────────────────────────

describe("PeerDiscovery - mDNS", () => {
  let discovery: PeerDiscovery;

  beforeEach(() => {
    discovery = new PeerDiscovery("local-node");
  });

  afterEach(() => {
    discovery.stop();
  });

  test("startMDNS registers local node", async () => {
    const localInfo = makePeer({ nodeId: "local-node" });
    await discovery.startMDNS(localInfo);
    expect(discovery.getPeer("local-node")).toBeDefined();
  });

  test("stop clears timers without error", async () => {
    const localInfo = makePeer({ nodeId: "local-node" });
    await discovery.startMDNS(localInfo);
    discovery.stop();
    expect(discovery.stopped).toBe(true);
  });

  test("startMDNS is no-op after stop", async () => {
    discovery.stop();
    const localInfo = makePeer({ nodeId: "local-node" });
    await discovery.startMDNS(localInfo);
    // Should not register because stopped
    expect(discovery.getPeer("local-node")).toBeUndefined();
  });
});

// ─── Shared File Discovery ──────────────────────────────────────

describe("PeerDiscovery - shared file", () => {
  let discovery: PeerDiscovery;
  let tmpDir: string;

  beforeEach(async () => {
    discovery = new PeerDiscovery("local-node");
    tmpDir = await import("node:fs/promises").then(async (fs) => {
      const dir = `/tmp/kcode-mesh-test-${Date.now()}`;
      await fs.mkdir(dir, { recursive: true });
      return dir;
    });
  });

  afterEach(async () => {
    discovery.stop();
    try {
      const fs = await import("node:fs/promises");
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test("writes local info to shared directory", async () => {
    const localInfo = makePeer({ nodeId: "local-node" });
    await discovery.startSharedFile(tmpDir, localInfo);
    discovery.stop(); // Stop poll timer

    const file = Bun.file(`${tmpDir}/local-node.json`);
    expect(await file.exists()).toBe(true);

    const content = JSON.parse(await file.text());
    expect(content.nodeId).toBe("local-node");
  });

  test("reads other peers from shared directory", async () => {
    // Write a fake peer file
    const remotePeer = makePeer({ nodeId: "remote-peer" });
    await Bun.write(`${tmpDir}/remote-peer.json`, JSON.stringify(remotePeer));

    const localInfo = makePeer({ nodeId: "local-node" });
    await discovery.startSharedFile(tmpDir, localInfo);
    discovery.stop();

    expect(discovery.getPeer("remote-peer")).toBeDefined();
    expect(discovery.getPeer("remote-peer")?.hostname).toBe("test-host");
  });

  test("ignores own file in shared directory", async () => {
    const localInfo = makePeer({ nodeId: "local-node" });
    await discovery.startSharedFile(tmpDir, localInfo);
    discovery.stop();

    // Should have registered via updatePeer, not from file read
    const peers = discovery.getAvailablePeers();
    expect(peers).toHaveLength(0); // local-node is excluded from available
  });
});
