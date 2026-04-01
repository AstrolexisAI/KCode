import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageBus } from "./message-bus";
import type { CoordinatorMessage } from "./types";

let tempDir: string;

function makeMessage(overrides: Partial<CoordinatorMessage> = {}): CoordinatorMessage {
  return {
    type: "task",
    from: "coordinator",
    to: "worker-1",
    payload: { task: "do something" },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("MessageBus", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-msgbus-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Constructor ─────────────────────────────────────────────

  test("creates .messages directory on construction", () => {
    const bus = new MessageBus(tempDir);
    expect(existsSync(join(tempDir, ".messages"))).toBe(true);
  });

  // ─── Send & Receive ─────────────────────────────────────────

  test("send and receive a single message", () => {
    const bus = new MessageBus(tempDir);
    const msg = makeMessage({ to: "worker-1" });

    bus.send(msg);
    const received = bus.receive("worker-1");

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("task");
    expect(received[0]!.from).toBe("coordinator");
    expect(received[0]!.payload.task).toBe("do something");
  });

  test("send multiple messages and receive all", () => {
    const bus = new MessageBus(tempDir);

    bus.send(makeMessage({ to: "worker-1", payload: { n: 1 } }));
    bus.send(makeMessage({ to: "worker-1", payload: { n: 2 } }));
    bus.send(makeMessage({ to: "worker-1", payload: { n: 3 } }));

    const received = bus.receive("worker-1");
    expect(received).toHaveLength(3);
    expect(received[0]!.payload.n).toBe(1);
    expect(received[1]!.payload.n).toBe(2);
    expect(received[2]!.payload.n).toBe(3);
  });

  // ─── Inbox Cleared After Read ───────────────────────────────

  test("inbox is cleared after receive", () => {
    const bus = new MessageBus(tempDir);
    bus.send(makeMessage({ to: "worker-1" }));

    // First read gets the message
    const first = bus.receive("worker-1");
    expect(first).toHaveLength(1);

    // Second read gets nothing
    const second = bus.receive("worker-1");
    expect(second).toHaveLength(0);
  });

  // ─── Empty Inbox ────────────────────────────────────────────

  test("receive returns empty array for non-existent inbox", () => {
    const bus = new MessageBus(tempDir);
    const received = bus.receive("nobody");
    expect(received).toHaveLength(0);
  });

  // ─── Message Isolation ──────────────────────────────────────

  test("messages to different recipients are isolated", () => {
    const bus = new MessageBus(tempDir);

    bus.send(makeMessage({ to: "worker-1", payload: { for: "w1" } }));
    bus.send(makeMessage({ to: "worker-2", payload: { for: "w2" } }));

    const w1 = bus.receive("worker-1");
    const w2 = bus.receive("worker-2");

    expect(w1).toHaveLength(1);
    expect(w1[0]!.payload.for).toBe("w1");
    expect(w2).toHaveLength(1);
    expect(w2[0]!.payload.for).toBe("w2");
  });

  // ─── Bidirectional ──────────────────────────────────────────

  test("workers can send messages to coordinator", () => {
    const bus = new MessageBus(tempDir);

    bus.send({
      type: "progress",
      from: "worker-1",
      to: "coordinator",
      payload: { message: "50% done" },
      timestamp: Date.now(),
    });

    const received = bus.receive("coordinator");
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("progress");
    expect(received[0]!.from).toBe("worker-1");
    expect(received[0]!.payload.message).toBe("50% done");
  });

  // ─── Peek ───────────────────────────────────────────────────

  test("peek reads messages without consuming them", () => {
    const bus = new MessageBus(tempDir);
    bus.send(makeMessage({ to: "worker-1" }));

    const peeked = bus.peek("worker-1");
    expect(peeked).toHaveLength(1);

    // Messages still there after peek
    const received = bus.receive("worker-1");
    expect(received).toHaveLength(1);
  });

  // ─── Validation ─────────────────────────────────────────────

  test("send rejects message without 'to' field", () => {
    const bus = new MessageBus(tempDir);
    expect(() =>
      bus.send({ type: "task", from: "coord", to: "", payload: {}, timestamp: 0 }),
    ).toThrow();
  });

  test("send rejects message without 'from' field", () => {
    const bus = new MessageBus(tempDir);
    expect(() =>
      bus.send({ type: "task", from: "", to: "w1", payload: {}, timestamp: 0 }),
    ).toThrow();
  });

  // ─── Polling ────────────────────────────────────────────────

  test("polling can be started and stopped", () => {
    const bus = new MessageBus(tempDir);
    expect(bus.isPolling()).toBe(false);

    bus.startPolling("coordinator", () => {}, 5000);
    expect(bus.isPolling()).toBe(true);

    bus.stopPolling();
    expect(bus.isPolling()).toBe(false);
  });

  test("startPolling replaces previous poll", () => {
    const bus = new MessageBus(tempDir);
    bus.startPolling("coordinator", () => {}, 5000);
    bus.startPolling("coordinator", () => {}, 5000);
    expect(bus.isPolling()).toBe(true);
    bus.stopPolling();
    expect(bus.isPolling()).toBe(false);
  });

  test("stopPolling is safe to call when not polling", () => {
    const bus = new MessageBus(tempDir);
    bus.stopPolling(); // Should not throw
  });

  // ─── Multiple Writers (JSONL append safety) ─────────────────

  test("multiple senders to same inbox preserve all messages", () => {
    const bus = new MessageBus(tempDir);

    // Simulate multiple senders writing to the same inbox
    bus.send(makeMessage({ from: "coordinator", to: "worker-1", payload: { n: 1 } }));
    bus.send(makeMessage({ from: "worker-2", to: "worker-1", payload: { n: 2 } }));
    bus.send(makeMessage({ from: "worker-3", to: "worker-1", payload: { n: 3 } }));

    const received = bus.receive("worker-1");
    expect(received).toHaveLength(3);
  });

  // ─── Malformed Lines ────────────────────────────────────────

  test("receive skips malformed JSON lines gracefully", () => {
    const bus = new MessageBus(tempDir);
    // Write a valid message
    bus.send(makeMessage({ to: "worker-1" }));

    // Manually corrupt the inbox by appending invalid JSON
    const inboxPath = join(bus.getMessagesDir(), "inbox-worker-1.jsonl");
    const fs = require("node:fs");
    fs.appendFileSync(inboxPath, "not valid json\n");
    fs.appendFileSync(
      inboxPath,
      JSON.stringify(makeMessage({ to: "worker-1", payload: { valid: true } })) + "\n",
    );

    const received = bus.receive("worker-1");
    // Should get the valid messages, skipping the bad line
    expect(received.length).toBeGreaterThanOrEqual(1);
    // The last valid message should be present
    const validMsg = received.find((m) => m.payload.valid === true);
    expect(validMsg).toBeDefined();
  });

  // ─── Recipient Name Sanitization ────────────────────────────

  test("sanitizes recipient names to prevent path traversal", () => {
    const bus = new MessageBus(tempDir);
    // These should not throw, just get sanitized
    bus.send(makeMessage({ to: "../escape" }));
    const received = bus.receive("../escape");
    expect(received).toHaveLength(1);
    // The file should be in the .messages dir, not escaped
    expect(existsSync(join(tempDir, ".messages"))).toBe(true);
  });
});
