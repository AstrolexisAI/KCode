// KCode - Permission Bridge Tests

import { beforeEach, describe, expect, test } from "bun:test";
import { CollabPermissionBridge } from "./permission-bridge";
import { SessionShare } from "./session-share";
import type { CollabEvent } from "./types";

describe("CollabPermissionBridge", () => {
  let sessionShare: SessionShare;
  let bridge: CollabPermissionBridge;
  let events: CollabEvent[];
  let ownerId: string;
  let collabId: string;

  beforeEach(() => {
    sessionShare = new SessionShare();
    bridge = new CollabPermissionBridge(sessionShare);
    events = [];
    bridge.onEvent((e) => events.push(e));

    ownerId = "owner-1";
    const info = sessionShare.startSharing("sess-1", ownerId, "Alice", "interact");
    const result = sessionShare.join(info.shareToken, "Bob");
    collabId = result.participant.id;
  });

  test("requestPermission broadcasts permission.request event", () => {
    // Don't await - we'll respond manually
    bridge.requestPermission("Bash", { command: "ls" });
    // Give the event loop a tick
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.type).toBe("permission.request");
  });

  test("owner can respond to permission request", async () => {
    const promise = bridge.requestPermission("Bash", { command: "ls" });
    const requestId = (events[0]!.data as { id: string }).id;

    bridge.respondToPermission(requestId, ownerId, true);
    const allowed = await promise;
    expect(allowed).toBe(true);
  });

  test("owner can deny permission", async () => {
    const promise = bridge.requestPermission("Write", { path: "/etc/passwd" });
    const requestId = (events[0]!.data as { id: string }).id;

    bridge.respondToPermission(requestId, ownerId, false);
    const allowed = await promise;
    expect(allowed).toBe(false);
  });

  test("non-owner response is rejected before escalation", async () => {
    const promise = bridge.requestPermission("Bash", { command: "ls" });
    const requestId = (events[0]!.data as { id: string }).id;

    // Collaborator tries to respond before escalation
    bridge.respondToPermission(requestId, collabId, true);
    // Should still be pending
    expect(bridge.hasPending()).toBe(true);

    // Owner responds
    bridge.respondToPermission(requestId, ownerId, true);
    const allowed = await promise;
    expect(allowed).toBe(true);
  });

  test("cancelAll resolves all pending as denied", async () => {
    const p1 = bridge.requestPermission("Bash", { command: "ls" });
    const p2 = bridge.requestPermission("Write", { path: "foo.ts" });

    bridge.cancelAll();

    expect(await p1).toBe(false);
    expect(await p2).toBe(false);
    expect(bridge.hasPending()).toBe(false);
  });

  test("responding to non-existent request is a no-op", () => {
    bridge.respondToPermission("nonexistent", ownerId, true);
    expect(bridge.hasPending()).toBe(false);
  });

  test("hasPending reflects active requests", () => {
    expect(bridge.hasPending()).toBe(false);
    bridge.requestPermission("Bash", { command: "ls" });
    expect(bridge.hasPending()).toBe(true);
  });
});
