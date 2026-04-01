// KCode - P2P Agent Mesh Task Scheduler Tests

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PeerDiscovery } from "./discovery";
import { generateTeamToken } from "./security";
import {
  HIGH_LATENCY_THRESHOLD_MS,
  PENALTY_BUSY,
  PENALTY_HIGH_LATENCY,
  SCORE_HAS_MODEL,
  SCORE_PER_CPU_CORE,
  SCORE_PER_GB_VRAM,
  TaskScheduler,
} from "./task-scheduler";
import { MeshTransport } from "./transport";
import type { MeshResult, MeshTask, PeerInfo } from "./types";

// ─── Helpers ───────────────────────────────────────────────────

function makePeer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    nodeId: `peer-${Math.random().toString(36).slice(2, 8)}`,
    hostname: "test-host",
    ip: "127.0.0.1",
    port: 19200,
    capabilities: {
      models: ["model-a"],
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

function makeScheduler(
  peers: PeerInfo[] = [],
  localExecutor?: (task: MeshTask) => Promise<string>,
): { scheduler: TaskScheduler; discovery: PeerDiscovery; transport: MeshTransport } {
  const discovery = new PeerDiscovery("local-node");
  for (const p of peers) discovery.updatePeer(p);

  const token = generateTeamToken();
  const transport = new MeshTransport({ port: 0, teamToken: token });

  const scheduler = new TaskScheduler(discovery, transport, localExecutor);

  return { scheduler, discovery, transport };
}

// ─── scorePeer ─────────────────────────────────────────────────

describe("TaskScheduler - scorePeer", () => {
  test("gives bonus for matching model", () => {
    const { scheduler } = makeScheduler();
    const peer = makePeer({
      capabilities: { models: ["llama-70b"], gpuVram: 0, cpuCores: 1, maxConcurrent: 1 },
    });
    const task = makeTask({ model: "llama-70b" });
    const score = scheduler.scorePeer(peer, task, 10);
    expect(score).toBeGreaterThanOrEqual(SCORE_HAS_MODEL);
  });

  test("no model bonus when task has no model preference", () => {
    const { scheduler } = makeScheduler();
    const peer = makePeer({
      capabilities: { models: ["llama-70b"], gpuVram: 0, cpuCores: 1, maxConcurrent: 1 },
    });
    const task = makeTask({ model: undefined });
    const score = scheduler.scorePeer(peer, task, 10);
    expect(score).toBeLessThan(SCORE_HAS_MODEL);
  });

  test("no model bonus when peer lacks the model", () => {
    const { scheduler } = makeScheduler();
    const peer = makePeer({
      capabilities: { models: ["other-model"], gpuVram: 0, cpuCores: 1, maxConcurrent: 1 },
    });
    const task = makeTask({ model: "llama-70b" });
    const score = scheduler.scorePeer(peer, task, 10);
    expect(score).toBeLessThan(SCORE_HAS_MODEL);
  });

  test("higher VRAM gives higher score", () => {
    const { scheduler } = makeScheduler();
    const task = makeTask();
    const peerLow = makePeer({
      capabilities: { models: [], gpuVram: 8, cpuCores: 1, maxConcurrent: 1 },
    });
    const peerHigh = makePeer({
      capabilities: { models: [], gpuVram: 48, cpuCores: 1, maxConcurrent: 1 },
    });
    const scoreLow = scheduler.scorePeer(peerLow, task, 10);
    const scoreHigh = scheduler.scorePeer(peerHigh, task, 10);
    expect(scoreHigh).toBeGreaterThan(scoreLow);
  });

  test("more CPU cores gives higher score", () => {
    const { scheduler } = makeScheduler();
    const task = makeTask();
    const peerFew = makePeer({
      capabilities: { models: [], gpuVram: 0, cpuCores: 2, maxConcurrent: 1 },
    });
    const peerMany = makePeer({
      capabilities: { models: [], gpuVram: 0, cpuCores: 32, maxConcurrent: 1 },
    });
    const scoreFew = scheduler.scorePeer(peerFew, task, 10);
    const scoreMany = scheduler.scorePeer(peerMany, task, 10);
    expect(scoreMany).toBeGreaterThan(scoreFew);
  });

  test("busy peer gets penalty", () => {
    const { scheduler } = makeScheduler();
    const task = makeTask();
    const available = makePeer({
      status: "online",
      capabilities: { models: [], gpuVram: 0, cpuCores: 1, maxConcurrent: 1 },
    });
    const busy = makePeer({
      status: "busy",
      capabilities: { models: [], gpuVram: 0, cpuCores: 1, maxConcurrent: 1 },
    });
    const scoreAvailable = scheduler.scorePeer(available, task, 10);
    const scoreBusy = scheduler.scorePeer(busy, task, 10);
    expect(scoreBusy).toBeLessThan(scoreAvailable);
  });

  test("high latency gets penalty", () => {
    const { scheduler } = makeScheduler();
    const task = makeTask();
    const peer = makePeer({
      capabilities: { models: [], gpuVram: 0, cpuCores: 1, maxConcurrent: 1 },
    });
    const scoreLow = scheduler.scorePeer(peer, task, 10);
    const scoreHigh = scheduler.scorePeer(peer, task, HIGH_LATENCY_THRESHOLD_MS + 1);
    expect(scoreHigh).toBeLessThan(scoreLow);
  });
});

// ─── rankPeers ─────────────────────────────────────────────────

describe("TaskScheduler - rankPeers", () => {
  test("returns empty when no peers available", async () => {
    const { scheduler } = makeScheduler([]);
    const ranked = await scheduler.rankPeers(makeTask());
    expect(ranked).toHaveLength(0);
  });

  test("ranks peers by score descending", async () => {
    const peerA = makePeer({
      nodeId: "peer-a",
      capabilities: { models: ["target-model"], gpuVram: 48, cpuCores: 16, maxConcurrent: 4 },
    });
    const peerB = makePeer({
      nodeId: "peer-b",
      capabilities: { models: [], gpuVram: 8, cpuCores: 4, maxConcurrent: 1 },
    });
    const { scheduler } = makeScheduler([peerA, peerB]);
    const task = makeTask({ model: "target-model" });
    const ranked = await scheduler.rankPeers(task);

    expect(ranked).toHaveLength(2);
    expect(ranked[0].peer.nodeId).toBe("peer-a");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });
});

// ─── schedule ──────────────────────────────────────────────────

describe("TaskScheduler - schedule", () => {
  test("throws when no peers available", async () => {
    const { scheduler } = makeScheduler([]);
    await expect(scheduler.schedule(makeTask())).rejects.toThrow("No peers available");
  });

  test("returns the best peer", async () => {
    const bestPeer = makePeer({
      nodeId: "best",
      capabilities: { models: ["target"], gpuVram: 48, cpuCores: 16, maxConcurrent: 4 },
    });
    const worsePeer = makePeer({
      nodeId: "worse",
      capabilities: { models: [], gpuVram: 4, cpuCores: 2, maxConcurrent: 1 },
    });
    const { scheduler } = makeScheduler([bestPeer, worsePeer]);
    const selected = await scheduler.schedule(makeTask({ model: "target" }));
    expect(selected.nodeId).toBe("best");
  });
});

// ─── executeLocal ──────────────────────────────────────────────

describe("TaskScheduler - executeLocal", () => {
  test("returns completed result with default executor", async () => {
    const { scheduler } = makeScheduler();
    const task = makeTask({ files: ["a.ts", "b.ts"] });
    const result = await scheduler.executeLocal(task);
    expect(result.status).toBe("completed");
    expect(result.fromNode).toBe("local");
    expect(result.output).toContain("2 files");
  });

  test("uses custom local executor when provided", async () => {
    const { scheduler } = makeScheduler([], async (t) => `processed ${t.id}`);
    const task = makeTask();
    const result = await scheduler.executeLocal(task);
    expect(result.status).toBe("completed");
    expect(result.output).toContain(task.id);
  });

  test("returns failed result when executor throws", async () => {
    const { scheduler } = makeScheduler([], async () => {
      throw new Error("local failure");
    });
    const task = makeTask();
    const result = await scheduler.executeLocal(task);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("local failure");
  });
});

// ─── mergeResults ──────────────────────────────────────────────

describe("TaskScheduler - mergeResults", () => {
  test("merges fulfilled results", () => {
    const { scheduler } = makeScheduler();
    const results: PromiseSettledResult<MeshResult>[] = [
      {
        status: "fulfilled",
        value: {
          taskId: "t1",
          status: "completed",
          output: "part-a",
          durationMs: 10,
          fromNode: "a",
        },
      },
      {
        status: "fulfilled",
        value: {
          taskId: "t1",
          status: "completed",
          output: "part-b",
          durationMs: 20,
          fromNode: "b",
        },
      },
    ];
    const merged = scheduler.mergeResults("t1", results, Date.now() - 50);
    expect(merged.status).toBe("completed");
    expect(merged.output).toContain("part-a");
    expect(merged.output).toContain("part-b");
  });

  test("reports failed when all results fail", () => {
    const { scheduler } = makeScheduler();
    const results: PromiseSettledResult<MeshResult>[] = [
      {
        status: "fulfilled",
        value: { taskId: "t1", status: "failed", error: "err-a", durationMs: 10, fromNode: "a" },
      },
      {
        status: "rejected",
        reason: new Error("err-b"),
      },
    ];
    const merged = scheduler.mergeResults("t1", results, Date.now() - 50);
    expect(merged.status).toBe("failed");
    expect(merged.error).toContain("err-a");
    expect(merged.error).toContain("err-b");
  });

  test("reports completed if at least one succeeds", () => {
    const { scheduler } = makeScheduler();
    const results: PromiseSettledResult<MeshResult>[] = [
      {
        status: "fulfilled",
        value: { taskId: "t1", status: "completed", output: "ok", durationMs: 10, fromNode: "a" },
      },
      {
        status: "rejected",
        reason: new Error("fail"),
      },
    ];
    const merged = scheduler.mergeResults("t1", results, Date.now() - 50);
    expect(merged.status).toBe("completed");
    expect(merged.output).toContain("ok");
    expect(merged.error).toContain("fail");
  });

  test("handles empty results", () => {
    const { scheduler } = makeScheduler();
    const merged = scheduler.mergeResults("t1", [], Date.now());
    expect(merged.status).toBe("failed");
  });
});

// ─── Result Storage ────────────────────────────────────────────

describe("TaskScheduler - result storage", () => {
  test("stores and retrieves results", () => {
    const { scheduler } = makeScheduler();
    const result: MeshResult = {
      taskId: "t1",
      status: "completed",
      output: "done",
      durationMs: 50,
      fromNode: "peer-x",
    };
    scheduler.storeResult(result);
    expect(scheduler.getResult("t1")).toEqual(result);
  });

  test("returns undefined for unknown taskId", () => {
    const { scheduler } = makeScheduler();
    expect(scheduler.getResult("nonexistent")).toBeUndefined();
  });
});
