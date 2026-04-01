import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Coordinator,
  detectCoordinatorSession,
  loadCoordinatorProgress,
  parseCoordinatorConfig,
} from "./coordinator";
import { Scratchpad } from "./scratchpad";
import type { CoordinatorConfig, WorkerConfig } from "./types";
import { DEFAULT_COORDINATOR_CONFIG } from "./types";

let tempDir: string;

// We override the scratchpad base dir by patching homedir so scratchpad uses tempDir.
// Instead, we use the Coordinator with a session ID and then check files in the default location.
// For test isolation, we'll use the Scratchpad directly and test Coordinator logic separately.

describe("Coordinator", () => {
  let sessionId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-coord-test-"));
    sessionId = `test-${Date.now()}`;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createCoordinator(config?: Partial<CoordinatorConfig>): Coordinator {
    // We need to use a deterministic path. Create coordinator and then clean up.
    return new Coordinator(sessionId, config);
  }

  // ─── Start ──────────────────────────────────────────────────

  test("start initializes scratchpad with plan and progress", async () => {
    const coord = createCoordinator();
    await coord.start();

    const sp = coord.getScratchpad();
    const plan = sp.read("plan.md");
    const progress = sp.read("progress.md");

    expect(plan).toContain("Plan");
    expect(progress).toContain("Coordinator started");

    await coord.cleanup();
    sp.cleanup();
  });

  test("start is idempotent", async () => {
    const coord = createCoordinator();
    await coord.start();
    await coord.start(); // Second call should not throw

    expect(coord.isStarted()).toBe(true);

    await coord.cleanup();
    coord.getScratchpad().cleanup();
  });

  // ─── Assign Task ────────────────────────────────────────────

  test("assignTask creates a worker and returns its ID", async () => {
    const coord = createCoordinator();
    await coord.start();

    const id = await coord.assignTask({
      id: "w1",
      mode: "simple",
      task: "Fix tests",
    });

    expect(id).toBe("w1");
    expect(coord.getWorkerCount()).toBe(1);

    await coord.cleanup();
    coord.getScratchpad().cleanup();
  });

  test("assignTask sends task message via bus", async () => {
    const coord = createCoordinator();
    await coord.start();

    await coord.assignTask({ id: "w1", mode: "simple", task: "Fix tests" });

    // Check message bus has a task for w1
    const messages = coord.getMessageBus().receive("w1");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("task");
    expect(messages[0]!.payload.task).toBe("Fix tests");

    await coord.cleanup();
    coord.getScratchpad().cleanup();
  });

  test("assignTask updates progress in scratchpad", async () => {
    const coord = createCoordinator();
    await coord.start();

    await coord.assignTask({ id: "w1", mode: "simple", task: "Fix tests" });

    const progress = coord.getScratchpad().read("progress.md");
    expect(progress).toContain("Worker w1 assigned");

    await coord.cleanup();
    coord.getScratchpad().cleanup();
  });

  // ─── Max Workers ────────────────────────────────────────────

  test("assignTask respects maxWorkers limit", async () => {
    const coord = createCoordinator({ maxWorkers: 2 });
    await coord.start();

    await coord.assignTask({ id: "w1", mode: "simple", task: "Task 1" });
    await coord.assignTask({ id: "w2", mode: "simple", task: "Task 2" });

    await expect(coord.assignTask({ id: "w3", mode: "simple", task: "Task 3" })).rejects.toThrow(
      "Max workers (2) reached",
    );

    await coord.cleanup();
    coord.getScratchpad().cleanup();
  });

  test("assignTask rejects duplicate worker IDs", async () => {
    const coord = createCoordinator();
    await coord.start();

    await coord.assignTask({ id: "w1", mode: "simple", task: "Task 1" });

    await expect(coord.assignTask({ id: "w1", mode: "simple", task: "Task 2" })).rejects.toThrow(
      'Worker "w1" already exists',
    );

    await coord.cleanup();
    coord.getScratchpad().cleanup();
  });

  // ─── Collect Results ────────────────────────────────────────

  test("collectResults returns empty when no workers done", async () => {
    const coord = createCoordinator();
    await coord.start();

    await coord.assignTask({ id: "w1", mode: "simple", task: "Task" });
    // Worker is "running" (no process actually spawned in unit test)
    const results = coord.collectResults();
    expect(results).toHaveLength(0);

    await coord.cleanup();
    coord.getScratchpad().cleanup();
  });

  // ─── Cancel ─────────────────────────────────────────────────

  test("cancelWorker marks worker as failed", async () => {
    const coord = createCoordinator();
    await coord.start();

    await coord.assignTask({ id: "w1", mode: "simple", task: "Task" });
    const cancelled = await coord.cancelWorker("w1");
    expect(cancelled).toBe(true);

    const statuses = coord.getWorkerStatuses();
    const w1 = statuses.find((s) => s.id === "w1");
    expect(w1?.status).toBe("failed");

    await coord.cleanup();
    coord.getScratchpad().cleanup();
  });

  test("cancelWorker returns false for non-running worker", async () => {
    const coord = createCoordinator();
    await coord.start();

    const result = await coord.cancelWorker("nonexistent");
    expect(result).toBe(false);

    await coord.cleanup();
    coord.getScratchpad().cleanup();
  });

  test("cancelAll cancels all running workers", async () => {
    const coord = createCoordinator();
    await coord.start();

    await coord.assignTask({ id: "w1", mode: "simple", task: "Task 1" });
    await coord.assignTask({ id: "w2", mode: "simple", task: "Task 2" });

    await coord.cancelAll();

    const statuses = coord.getWorkerStatuses();
    expect(statuses.every((s) => s.status === "failed")).toBe(true);

    await coord.cleanup();
    coord.getScratchpad().cleanup();
  });

  // ─── Cleanup ────────────────────────────────────────────────

  test("cleanup stops polling and cancels workers", async () => {
    const coord = createCoordinator();
    await coord.start();

    await coord.assignTask({ id: "w1", mode: "simple", task: "Task" });

    await coord.cleanup();

    expect(coord.isStarted()).toBe(false);
    expect(coord.getMessageBus().isPolling()).toBe(false);

    coord.getScratchpad().cleanup();
  });

  test("cleanup removes scratchpad when preserveScratchpadOnExit is false", async () => {
    const coord = createCoordinator({ preserveScratchpadOnExit: false });
    await coord.start();

    const path = coord.getScratchpad().getPath();
    expect(existsSync(path)).toBe(true);

    await coord.cleanup();
    expect(existsSync(path)).toBe(false);
  });

  test("cleanup preserves scratchpad by default", async () => {
    const coord = createCoordinator();
    await coord.start();

    const path = coord.getScratchpad().getPath();
    await coord.cleanup();
    expect(existsSync(path)).toBe(true);

    // Manual cleanup
    coord.getScratchpad().cleanup();
  });

  // ─── Config ─────────────────────────────────────────────────

  test("getConfig returns merged config", () => {
    const coord = createCoordinator({ maxWorkers: 8 });
    const config = coord.getConfig();
    expect(config.maxWorkers).toBe(8);
    expect(config.defaultWorkerMode).toBe("simple");
    expect(config.workerTimeoutMs).toBe(120_000);
  });

  test("getSessionId returns session ID", () => {
    const coord = createCoordinator();
    expect(coord.getSessionId()).toBe(sessionId);
  });

  // ─── Worker Statuses ────────────────────────────────────────

  test("getWorkerStatuses returns all workers", async () => {
    const coord = createCoordinator();
    await coord.start();

    await coord.assignTask({ id: "w1", mode: "simple", task: "Task 1" });
    await coord.assignTask({ id: "w2", mode: "complex", task: "Task 2" });

    const statuses = coord.getWorkerStatuses();
    expect(statuses).toHaveLength(2);
    expect(statuses.map((s) => s.id).sort()).toEqual(["w1", "w2"]);

    await coord.cleanup();
    coord.getScratchpad().cleanup();
  });

  test("getRunningCount returns number of running workers", async () => {
    const coord = createCoordinator();
    await coord.start();

    await coord.assignTask({ id: "w1", mode: "simple", task: "Task 1" });
    expect(coord.getRunningCount()).toBe(1);

    await coord.cancelWorker("w1");
    expect(coord.getRunningCount()).toBe(0);

    await coord.cleanup();
    coord.getScratchpad().cleanup();
  });

  // ─── Message Handling ───────────────────────────────────────

  test("handleWorkerMessages updates progress on progress messages", async () => {
    const coord = createCoordinator();
    await coord.start();

    // Simulate a worker sending a progress message
    coord.getMessageBus().send({
      type: "progress",
      from: "worker-1",
      to: "coordinator",
      payload: { message: "50% done" },
      timestamp: Date.now(),
    });

    // Manually trigger polling callback (since real polling uses intervals)
    const messages = coord.getMessageBus().receive("coordinator");
    // @ts-expect-error - accessing private method for testing
    coord.handleWorkerMessages(messages);

    const progress = coord.getScratchpad().read("progress.md");
    expect(progress).toContain("50% done");

    await coord.cleanup();
    coord.getScratchpad().cleanup();
  });

  test("scratchpad disabled skips progress updates", async () => {
    const coord = createCoordinator({ scratchpadEnabled: false });
    await coord.start();

    // Plan/progress files should not exist
    const plan = coord.getScratchpad().read("plan.md");
    expect(plan).toBeNull();

    await coord.cleanup();
    coord.getScratchpad().cleanup();
  });
});

describe("detectCoordinatorSession", () => {
  test("returns false for non-existent session", () => {
    expect(detectCoordinatorSession("nonexistent-session-xyz")).toBe(false);
  });
});

describe("loadCoordinatorProgress", () => {
  test("returns null for non-existent session", () => {
    expect(loadCoordinatorProgress("nonexistent-session-xyz")).toBeNull();
  });
});

describe("parseCoordinatorConfig", () => {
  test("parses valid config", () => {
    const config = parseCoordinatorConfig({
      enabled: true,
      maxWorkers: 8,
      defaultWorkerMode: "complex",
      workerTimeoutMs: 60000,
      scratchpadEnabled: false,
      preserveScratchpadOnExit: false,
    });

    expect(config.enabled).toBe(true);
    expect(config.maxWorkers).toBe(8);
    expect(config.defaultWorkerMode).toBe("complex");
    expect(config.workerTimeoutMs).toBe(60000);
    expect(config.scratchpadEnabled).toBe(false);
    expect(config.preserveScratchpadOnExit).toBe(false);
  });

  test("returns empty object for null input", () => {
    expect(parseCoordinatorConfig(null)).toEqual({});
  });

  test("returns empty object for non-object input", () => {
    expect(parseCoordinatorConfig("string")).toEqual({});
    expect(parseCoordinatorConfig(42)).toEqual({});
  });

  test("ignores invalid values", () => {
    const config = parseCoordinatorConfig({
      enabled: "yes", // should be boolean
      maxWorkers: -1, // should be > 0
      defaultWorkerMode: "turbo", // invalid
      workerTimeoutMs: 0, // should be > 0
    });

    expect(config.enabled).toBeUndefined();
    expect(config.maxWorkers).toBeUndefined();
    expect(config.defaultWorkerMode).toBeUndefined();
    expect(config.workerTimeoutMs).toBeUndefined();
  });

  test("partial config returns only valid fields", () => {
    const config = parseCoordinatorConfig({ maxWorkers: 6 });
    expect(config.maxWorkers).toBe(6);
    expect(config.enabled).toBeUndefined();
  });
});
