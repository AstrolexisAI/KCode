// KCode - Cursor Sync Tests

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CursorSync } from "./cursor-sync";
import type { CollabEvent } from "./types";

describe("CursorSync", () => {
  let sync: CursorSync;
  let events: CollabEvent[];

  beforeEach(() => {
    sync = new CursorSync();
    events = [];
    sync.onEvent((e) => events.push(e));
  });

  afterEach(() => {
    sync.dispose();
  });

  test("updateCursorImmediate stores cursor position", () => {
    sync.updateCursorImmediate("p1", "src/index.ts", 10, 5, "#e06c75");
    const cursor = sync.getCursor("p1");
    expect(cursor).toBeDefined();
    expect(cursor!.file).toBe("src/index.ts");
    expect(cursor!.line).toBe(10);
    expect(cursor!.col).toBe(5);
    expect(cursor!.color).toBe("#e06c75");
  });

  test("updateCursorImmediate broadcasts event", () => {
    sync.updateCursorImmediate("p1", "src/index.ts", 1, 1, "#e06c75");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("collab.cursor");
  });

  test("getCursors returns all positions", () => {
    sync.updateCursorImmediate("p1", "a.ts", 1, 1, "#e06c75");
    sync.updateCursorImmediate("p2", "b.ts", 2, 2, "#98c379");
    const cursors = sync.getCursors();
    expect(cursors.size).toBe(2);
    expect(cursors.get("p1")!.file).toBe("a.ts");
    expect(cursors.get("p2")!.file).toBe("b.ts");
  });

  test("updateCursorImmediate overwrites previous position", () => {
    sync.updateCursorImmediate("p1", "a.ts", 1, 1, "#e06c75");
    sync.updateCursorImmediate("p1", "b.ts", 5, 10, "#e06c75");
    const cursor = sync.getCursor("p1");
    expect(cursor!.file).toBe("b.ts");
    expect(cursor!.line).toBe(5);
  });

  test("removeCursor deletes participant cursor", () => {
    sync.updateCursorImmediate("p1", "a.ts", 1, 1, "#e06c75");
    sync.removeCursor("p1");
    expect(sync.getCursor("p1")).toBeUndefined();
    expect(sync.getCursors().size).toBe(0);
  });

  test("cleanupStale runs without error on fresh cursors", () => {
    // Fresh cursors should not be considered stale
    const removed = sync.cleanupStale();
    expect(removed).toBe(0);
  });

  test("dispose clears everything", () => {
    sync.updateCursorImmediate("p1", "a.ts", 1, 1, "#e06c75");
    sync.updateCursorImmediate("p2", "b.ts", 2, 2, "#98c379");
    sync.dispose();
    expect(sync.getCursors().size).toBe(0);
  });

  test("updateCursor debounces rapid updates", async () => {
    sync.updateCursor("p1", "a.ts", 1, 1, "#e06c75");
    sync.updateCursor("p1", "a.ts", 2, 1, "#e06c75");
    sync.updateCursor("p1", "a.ts", 3, 1, "#e06c75");

    // Immediately, no events yet (debounced)
    expect(events).toHaveLength(0);

    // Wait for debounce (100ms + margin)
    await new Promise((r) => setTimeout(r, 150));

    // Only one event should have fired (the last one)
    expect(events).toHaveLength(1);
    const pos = (events[0]!.data as { position: { line: number } }).position;
    expect(pos.line).toBe(3);
  });

  test("getCursor returns undefined for unknown participant", () => {
    expect(sync.getCursor("nonexistent")).toBeUndefined();
  });
});
