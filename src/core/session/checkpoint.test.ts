import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CheckpointManager } from "./checkpoint";
import type { SessionCheckpoint } from "./types";

function makeCheckpoint(
  conversationId: string,
  overrides: Partial<SessionCheckpoint> = {},
): SessionCheckpoint {
  return {
    id: `cp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    conversationId,
    messages: [{ role: "user", content: "hello" }],
    toolStates: {},
    workingDirectory: "/tmp/test",
    modelId: "test-model",
    tokensUsed: 100,
    costUsd: 0.01,
    ...overrides,
  };
}

describe("CheckpointManager", () => {
  let db: Database;
  let manager: CheckpointManager;

  beforeEach(() => {
    db = new Database(":memory:");
    manager = new CheckpointManager(db, 30000, 5);
  });

  afterEach(() => {
    manager.stopAutoCheckpoint();
    db.close();
  });

  describe("save and getLatest", () => {
    test("saves and retrieves a checkpoint", () => {
      const cp = makeCheckpoint("conv-1");
      manager.save(cp);
      const latest = manager.getLatest("conv-1");
      expect(latest).not.toBeNull();
      expect(latest!.conversationId).toBe("conv-1");
      expect(latest!.tokensUsed).toBe(100);
    });

    test("getLatest returns most recent", () => {
      const cp1 = makeCheckpoint("conv-1", { timestamp: 1000, tokensUsed: 50 });
      const cp2 = makeCheckpoint("conv-1", { timestamp: 2000, tokensUsed: 200 });
      manager.save(cp1);
      manager.save(cp2);
      const latest = manager.getLatest("conv-1");
      expect(latest!.tokensUsed).toBe(200);
    });

    test("returns null for unknown conversation", () => {
      expect(manager.getLatest("nonexistent")).toBeNull();
    });
  });

  describe("getById", () => {
    test("retrieves checkpoint by ID", () => {
      const cp = makeCheckpoint("conv-1", { id: "test-id-123" });
      manager.save(cp);
      const found = manager.getById("test-id-123");
      expect(found).not.toBeNull();
      expect(found!.id).toBe("test-id-123");
    });

    test("returns null for unknown ID", () => {
      expect(manager.getById("nope")).toBeNull();
    });
  });

  describe("listForConversation", () => {
    test("lists checkpoints in descending order", () => {
      for (let i = 0; i < 3; i++) {
        manager.save(makeCheckpoint("conv-1", { timestamp: 1000 + i }));
      }
      const list = manager.listForConversation("conv-1");
      expect(list).toHaveLength(3);
      expect(list[0]!.timestamp).toBeGreaterThan(list[1]!.timestamp);
    });

    test("returns empty for unknown conversation", () => {
      expect(manager.listForConversation("nope")).toHaveLength(0);
    });
  });

  describe("listRecoverable", () => {
    test("lists conversations with checkpoints", () => {
      manager.save(makeCheckpoint("conv-1"));
      manager.save(makeCheckpoint("conv-2"));
      const recoverable = manager.listRecoverable();
      expect(recoverable.length).toBeGreaterThanOrEqual(2);
    });

    test("returns empty when no checkpoints", () => {
      expect(manager.listRecoverable()).toHaveLength(0);
    });
  });

  describe("pruning", () => {
    test("keeps only maxPerSession checkpoints", () => {
      for (let i = 0; i < 8; i++) {
        manager.save(
          makeCheckpoint("conv-1", {
            id: `cp-${i}`,
            timestamp: 1000 + i,
          }),
        );
      }
      const list = manager.listForConversation("conv-1");
      expect(list.length).toBeLessThanOrEqual(5);
    });
  });

  describe("clearConversation", () => {
    test("removes all checkpoints for conversation", () => {
      manager.save(makeCheckpoint("conv-1"));
      manager.save(makeCheckpoint("conv-1"));
      const removed = manager.clearConversation("conv-1");
      expect(removed).toBe(2);
      expect(manager.getLatest("conv-1")).toBeNull();
    });

    test("does not affect other conversations", () => {
      manager.save(makeCheckpoint("conv-1"));
      manager.save(makeCheckpoint("conv-2"));
      manager.clearConversation("conv-1");
      expect(manager.getLatest("conv-2")).not.toBeNull();
    });
  });

  describe("pruneOlderThan", () => {
    test("removes old checkpoints", () => {
      const oldCp = makeCheckpoint("conv-1", {
        timestamp: Date.now() - 100 * 24 * 60 * 60 * 1000, // 100 days ago
      });
      manager.save(oldCp);
      manager.save(makeCheckpoint("conv-2")); // Recent

      const removed = manager.pruneOlderThan(30);
      expect(removed).toBe(1);
      expect(manager.getLatest("conv-2")).not.toBeNull();
    });
  });

  describe("table creation", () => {
    test("idempotent — safe to create manager twice", () => {
      const manager2 = new CheckpointManager(db);
      manager.save(makeCheckpoint("conv-1"));
      manager2.save(makeCheckpoint("conv-1"));
      expect(manager.listForConversation("conv-1").length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("autoCheckpoint", () => {
    test("startAutoCheckpoint does not throw", () => {
      expect(() => manager.startAutoCheckpoint(() => makeCheckpoint("auto"))).not.toThrow();
      manager.stopAutoCheckpoint();
    });

    test("stopAutoCheckpoint is idempotent", () => {
      manager.stopAutoCheckpoint();
      manager.stopAutoCheckpoint();
    });
  });
});
