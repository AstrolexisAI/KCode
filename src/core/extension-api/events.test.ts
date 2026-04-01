// KCode - Extension API Event Emitter Tests

import { describe, test, expect, beforeEach } from "bun:test";
import { ExtensionEventEmitter } from "./events";
import type { ExtensionEvent } from "./types";

let emitter: ExtensionEventEmitter;

beforeEach(() => {
  emitter = new ExtensionEventEmitter();
});

// ─── on / emit ─────────────────────────────────────────────────

describe("on/emit", () => {
  test("handler receives events of matching type", () => {
    const received: ExtensionEvent[] = [];
    emitter.on("message.created", (e) => received.push(e));

    const event: ExtensionEvent = {
      type: "message.created",
      data: { id: "m1", role: "user", content: "hello" },
    };
    emitter.emit(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });

  test("handler does not receive events of different type", () => {
    const received: ExtensionEvent[] = [];
    emitter.on("message.created", (e) => received.push(e));

    emitter.emit({ type: "tool.started", data: { id: "t1", name: "Read" } });

    expect(received).toHaveLength(0);
  });

  test("multiple handlers for same event type all fire", () => {
    let count = 0;
    emitter.on("tool.started", () => count++);
    emitter.on("tool.started", () => count++);

    emitter.emit({ type: "tool.started", data: { id: "t1", name: "Read" } });
    expect(count).toBe(2);
  });
});

// ─── Wildcard '*' ──────────────────────────────────────────────

describe("wildcard", () => {
  test("'*' listener receives all event types", () => {
    const received: ExtensionEvent[] = [];
    emitter.on("*", (e) => received.push(e));

    emitter.emit({ type: "message.created", data: { id: "m1", role: "user", content: "hi" } });
    emitter.emit({ type: "tool.started", data: { id: "t1", name: "Read" } });
    emitter.emit({ type: "error", data: { message: "fail", code: "ERR" } });

    expect(received).toHaveLength(3);
    expect(received[0].type).toBe("message.created");
    expect(received[1].type).toBe("tool.started");
    expect(received[2].type).toBe("error");
  });

  test("specific and wildcard listeners both fire", () => {
    let specificCount = 0;
    let wildcardCount = 0;
    emitter.on("tool.started", () => specificCount++);
    emitter.on("*", () => wildcardCount++);

    emitter.emit({ type: "tool.started", data: { id: "t1", name: "Read" } });

    expect(specificCount).toBe(1);
    expect(wildcardCount).toBe(1);
  });
});

// ─── off ───────────────────────────────────────────────────────

describe("off", () => {
  test("removes a specific listener", () => {
    let count = 0;
    const handler = () => count++;
    emitter.on("tool.started", handler);

    emitter.emit({ type: "tool.started", data: { id: "t1", name: "Read" } });
    expect(count).toBe(1);

    emitter.off("tool.started", handler);
    emitter.emit({ type: "tool.started", data: { id: "t2", name: "Write" } });
    expect(count).toBe(1);
  });

  test("off with unknown handler is a no-op", () => {
    emitter.off("tool.started", () => {});
    // Should not throw
  });
});

// ─── once ──────────────────────────────────────────────────────

describe("once", () => {
  test("fires only once then auto-removes", () => {
    let count = 0;
    emitter.once("tool.started", () => count++);

    emitter.emit({ type: "tool.started", data: { id: "t1", name: "Read" } });
    emitter.emit({ type: "tool.started", data: { id: "t2", name: "Write" } });

    expect(count).toBe(1);
  });

  test("once listener is removed from count after firing", () => {
    emitter.once("tool.started", () => {});
    expect(emitter.listenerCount("tool.started")).toBe(1);

    emitter.emit({ type: "tool.started", data: { id: "t1", name: "Read" } });
    expect(emitter.listenerCount("tool.started")).toBe(0);
  });
});

// ─── removeAllListeners ────────────────────────────────────────

describe("removeAllListeners", () => {
  test("clears listeners for a specific event type", () => {
    emitter.on("tool.started", () => {});
    emitter.on("tool.started", () => {});
    emitter.on("message.created", () => {});

    emitter.removeAllListeners("tool.started");

    expect(emitter.listenerCount("tool.started")).toBe(0);
    expect(emitter.listenerCount("message.created")).toBe(1);
  });

  test("clears all listeners when called without arguments", () => {
    emitter.on("tool.started", () => {});
    emitter.on("message.created", () => {});
    emitter.on("*", () => {});

    emitter.removeAllListeners();

    expect(emitter.eventNames()).toHaveLength(0);
  });
});

// ─── listenerCount ─────────────────────────────────────────────

describe("listenerCount", () => {
  test("returns 0 for event type with no listeners", () => {
    expect(emitter.listenerCount("tool.started")).toBe(0);
  });

  test("returns correct count after adding listeners", () => {
    emitter.on("tool.started", () => {});
    emitter.on("tool.started", () => {});
    expect(emitter.listenerCount("tool.started")).toBe(2);
  });
});

// ─── eventNames ────────────────────────────────────────────────

describe("eventNames", () => {
  test("returns empty array when no listeners", () => {
    expect(emitter.eventNames()).toEqual([]);
  });

  test("returns all registered event types", () => {
    emitter.on("tool.started", () => {});
    emitter.on("message.created", () => {});
    emitter.on("*", () => {});

    const names = emitter.eventNames().sort();
    expect(names).toEqual(["*", "message.created", "tool.started"]);
  });
});

// ─── Error resilience ──────────────────────────────────────────

describe("error resilience", () => {
  test("handler errors do not break other handlers", () => {
    let secondCalled = false;
    emitter.on("tool.started", () => {
      throw new Error("boom");
    });
    emitter.on("tool.started", () => {
      secondCalled = true;
    });

    emitter.emit({ type: "tool.started", data: { id: "t1", name: "Read" } });
    expect(secondCalled).toBe(true);
  });
});
