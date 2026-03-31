// Tests for Bridge Session Manager

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionManager } from "./session-manager";

let manager: SessionManager;

beforeEach(() => {
  // Use short intervals for testing; disable automatic GC by setting very long interval
  manager = new SessionManager({ maxSessions: 5, idleTimeoutMs: 100, gcIntervalMs: 60_000_000 });
});

afterEach(async () => {
  await manager.shutdown();
});

// ─── Create / Get / List ────────────────────────────────────────

describe("createSession", () => {
  test("creates a session and returns id", () => {
    const id = manager.createSession({ dir: "/tmp", spawnMode: "single-session" });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("session is retrievable after creation", () => {
    const id = manager.createSession({ dir: "/tmp", spawnMode: "single-session", model: "gpt-4" });
    const session = manager.getSession(id);
    expect(session).toBeDefined();
    expect(session!.dir).toBe("/tmp");
    expect(session!.spawnMode).toBe("single-session");
    expect(session!.model).toBe("gpt-4");
    expect(session!.status).toBe("idle");
  });

  test("listSessions returns all sessions", () => {
    manager.createSession({ dir: "/a", spawnMode: "single-session" });
    manager.createSession({ dir: "/b", spawnMode: "worktree" });
    const sessions = manager.listSessions();
    expect(sessions.length).toBe(2);
  });

  test("throws when max sessions reached", () => {
    for (let i = 0; i < 5; i++) {
      manager.createSession({ dir: `/tmp/${i}`, spawnMode: "single-session" });
    }
    expect(() => manager.createSession({ dir: "/tmp/6", spawnMode: "single-session" })).toThrow("Maximum sessions");
  });

  test("uses default model when not specified", () => {
    const id = manager.createSession({ dir: "/tmp", spawnMode: "single-session" });
    const session = manager.getSession(id);
    expect(session!.model).toBe("default");
  });
});

// ─── Destroy ────────────────────────────────────────────────────

describe("destroySession", () => {
  test("destroys an existing session", async () => {
    const id = manager.createSession({ dir: "/tmp", spawnMode: "single-session" });
    const result = await manager.destroySession(id);
    expect(result).toBe(true);
    expect(manager.getSession(id)).toBeUndefined();
  });

  test("returns false for non-existent session", async () => {
    const result = await manager.destroySession("nonexistent");
    expect(result).toBe(false);
  });

  test("invokes onDestroy callback", async () => {
    let called = false;
    const id = manager.createSession({
      dir: "/tmp",
      spawnMode: "single-session",
      onDestroy: () => { called = true; },
    });
    await manager.destroySession(id);
    expect(called).toBe(true);
  });

  test("handles onDestroy errors gracefully", async () => {
    const id = manager.createSession({
      dir: "/tmp",
      spawnMode: "single-session",
      onDestroy: () => { throw new Error("cleanup failed"); },
    });
    // Should not throw
    const result = await manager.destroySession(id);
    expect(result).toBe(true);
    expect(manager.getSession(id)).toBeUndefined();
  });
});

// ─── State Updates ──────────────────────────────────────────────

describe("session state", () => {
  test("touchSession updates lastActivityAt", async () => {
    const id = manager.createSession({ dir: "/tmp", spawnMode: "single-session" });
    const before = manager.getSession(id)!.lastActivityAt;
    await new Promise((r) => setTimeout(r, 10));
    manager.touchSession(id);
    const after = manager.getSession(id)!.lastActivityAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  test("setStatus changes status", () => {
    const id = manager.createSession({ dir: "/tmp", spawnMode: "single-session" });
    manager.setStatus(id, "responding");
    expect(manager.getSession(id)!.status).toBe("responding");
  });

  test("adjustClientCount increments and decrements", () => {
    const id = manager.createSession({ dir: "/tmp", spawnMode: "single-session" });
    manager.adjustClientCount(id, 1);
    expect(manager.getSession(id)!.clientCount).toBe(1);
    manager.adjustClientCount(id, 1);
    expect(manager.getSession(id)!.clientCount).toBe(2);
    manager.adjustClientCount(id, -1);
    expect(manager.getSession(id)!.clientCount).toBe(1);
  });

  test("adjustClientCount does not go below 0", () => {
    const id = manager.createSession({ dir: "/tmp", spawnMode: "single-session" });
    manager.adjustClientCount(id, -5);
    expect(manager.getSession(id)!.clientCount).toBe(0);
  });

  test("hasSession returns true for existing session", () => {
    const id = manager.createSession({ dir: "/tmp", spawnMode: "single-session" });
    expect(manager.hasSession(id)).toBe(true);
    expect(manager.hasSession("nonexistent")).toBe(false);
  });
});

// ─── Garbage Collection ─────────────────────────────────────────

describe("gc", () => {
  test("destroys idle sessions past timeout", async () => {
    const id = manager.createSession({ dir: "/tmp", spawnMode: "single-session" });
    // Client must be > 0 to avoid orphan GC
    manager.adjustClientCount(id, 1);
    // Wait for idle timeout (100ms for tests)
    await new Promise((r) => setTimeout(r, 150));
    const destroyed = await manager.gc();
    expect(destroyed).toContain(id);
    expect(manager.getSession(id)).toBeUndefined();
  });

  test("destroys orphaned sessions (no clients, idle status)", async () => {
    const id = manager.createSession({ dir: "/tmp", spawnMode: "single-session" });
    // clientCount is 0, status is "idle" — should be GC'd
    const destroyed = await manager.gc();
    expect(destroyed).toContain(id);
  });

  test("does not destroy sessions with clients that are within timeout", async () => {
    const id = manager.createSession({ dir: "/tmp", spawnMode: "single-session" });
    manager.adjustClientCount(id, 1);
    manager.touchSession(id); // refresh activity
    const destroyed = await manager.gc();
    expect(destroyed).not.toContain(id);
    expect(manager.getSession(id)).toBeDefined();
  });

  test("does not destroy responding sessions with no clients", async () => {
    const id = manager.createSession({ dir: "/tmp", spawnMode: "single-session" });
    manager.setStatus(id, "responding");
    // clientCount = 0, but status = responding — should NOT be GC'd (only idle orphans are collected)
    const destroyed = await manager.gc();
    expect(destroyed).not.toContain(id);
  });
});

// ─── Events ─────────────────────────────────────────────────────

describe("events", () => {
  test("emits 'created' event on createSession", () => {
    const events: string[] = [];
    manager.onEvent((e) => events.push(e.type));
    manager.createSession({ dir: "/tmp", spawnMode: "single-session" });
    expect(events).toContain("created");
  });

  test("emits 'destroyed' event on destroySession", async () => {
    const events: string[] = [];
    manager.onEvent((e) => events.push(e.type));
    const id = manager.createSession({ dir: "/tmp", spawnMode: "single-session" });
    await manager.destroySession(id);
    expect(events).toContain("destroyed");
  });

  test("emits 'status-changed' on setStatus", () => {
    const events: string[] = [];
    manager.onEvent((e) => events.push(e.type));
    const id = manager.createSession({ dir: "/tmp", spawnMode: "single-session" });
    manager.setStatus(id, "responding");
    expect(events).toContain("status-changed");
  });

  test("unsubscribe stops receiving events", () => {
    const events: string[] = [];
    const unsub = manager.onEvent((e) => events.push(e.type));
    manager.createSession({ dir: "/tmp", spawnMode: "single-session" });
    expect(events.length).toBe(1);
    unsub();
    manager.createSession({ dir: "/tmp2", spawnMode: "single-session" });
    expect(events.length).toBe(1); // no new event
  });
});

// ─── Shutdown ───────────────────────────────────────────────────

describe("shutdown", () => {
  test("destroys all sessions on shutdown", async () => {
    manager.createSession({ dir: "/a", spawnMode: "single-session" });
    manager.createSession({ dir: "/b", spawnMode: "single-session" });
    await manager.shutdown();
    expect(manager.sessionCount).toBe(0);
    expect(manager.listSessions()).toEqual([]);
  });
});
