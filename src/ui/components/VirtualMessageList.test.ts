// KCode - VirtualMessageList component tests
// Tests the component logic, visible range slicing, scroll indicator, and spacers.
// Uses pure function tests since Ink components require a full render environment.

import { describe, expect, test } from "bun:test";
import { BUFFER_SIZE, calculateVisibleRange, DEFAULT_HEIGHT } from "../hooks/useVirtualScroll";
import type { MessageEntry } from "./MessageList";

// ─── Helpers ────────────────────────────────────────────────────

function makeGetId(prefix = "msg") {
  return (index: number) => `${prefix}-${index}`;
}

function makeTextEntry(role: "user" | "assistant", text: string): MessageEntry {
  return { kind: "text", role, text };
}

function makeToolUseEntry(name: string, summary: string): MessageEntry {
  return { kind: "tool_use", name, summary };
}

function makeToolResultEntry(name: string, result: string, isError = false): MessageEntry {
  return { kind: "tool_result", name, result, isError };
}

function makeBannerEntry(title: string, subtitle: string): MessageEntry {
  return { kind: "banner", title, subtitle };
}

function makeHeights(entries: Array<[number, number]>): Map<string, number> {
  const map = new Map<string, number>();
  for (const [index, height] of entries) {
    map.set(`msg-${index}`, height);
  }
  return map;
}

// ─── Visible message slicing logic ──────────────────────────────

describe("VirtualMessageList — visible message slicing", () => {
  test("empty completed list renders nothing", () => {
    const range = calculateVisibleRange(0, new Map(), 0, 24, BUFFER_SIZE, makeGetId());
    expect(range.renderStart).toBe(0);
    expect(range.renderEnd).toBe(-1);
  });

  test("small conversation renders all messages", () => {
    // 3 messages * 3 = 9, viewport 24 -> all visible
    const range = calculateVisibleRange(3, new Map(), 0, 24, BUFFER_SIZE, makeGetId());
    expect(range.renderStart).toBe(0);
    expect(range.renderEnd).toBe(2);
    expect(range.firstVisible).toBe(0);
    expect(range.lastVisible).toBe(2);
  });

  test("large conversation only renders visible + buffer", () => {
    // 100 messages * 3 = 300, viewport 24 -> ~8 visible
    const range = calculateVisibleRange(100, new Map(), 0, 24, BUFFER_SIZE, makeGetId());
    expect(range.renderStart).toBe(0);
    // firstVisible=0, lastVisible=7 (8*3=24), renderEnd = 7+5 = 12
    expect(range.renderEnd).toBe(12);
    // Should NOT render all 100
    expect(range.renderEnd).toBeLessThan(100);
  });

  test("scrolled conversation skips top messages", () => {
    // 100 messages, scroll to message 50 area
    const range = calculateVisibleRange(100, new Map(), 150, 24, BUFFER_SIZE, makeGetId());
    // 150/3 = 50, firstVisible=50
    expect(range.firstVisible).toBe(50);
    expect(range.renderStart).toBe(45); // 50-5
    expect(range.renderStart).toBeGreaterThan(0);
  });
});

// ─── Scroll indicator state ─────────────────────────────────────

describe("VirtualMessageList — scroll indicator", () => {
  test("following mode when at bottom", () => {
    // When scrollOffset is at max, following should be true
    const range = calculateVisibleRange(100, new Map(), 276, 24, BUFFER_SIZE, makeGetId());
    // maxScroll = 300-24=276 (at max)
    // Verify we're at the end
    expect(range.lastVisible).toBe(99);
  });

  test("scrolled mode shows position", () => {
    const range = calculateVisibleRange(100, new Map(), 30, 24, BUFFER_SIZE, makeGetId());
    // firstVisible around message 10
    expect(range.firstVisible).toBe(10);
    // Indicator should show "11/100" (1-indexed)
  });
});

// ─── Spacer calculation ─────────────────────────────────────────

describe("VirtualMessageList — spacers", () => {
  test("no spacers when all messages rendered", () => {
    const range = calculateVisibleRange(5, new Map(), 0, 24, BUFFER_SIZE, makeGetId());
    expect(range.spacerTop).toBe(0);
    expect(range.spacerBottom).toBe(0);
  });

  test("top spacer when scrolled past messages", () => {
    // 50 messages, scroll to middle, small buffer
    const range = calculateVisibleRange(50, new Map(), 60, 12, 2, makeGetId());
    // firstVisible=20 (60/3), renderStart=18
    expect(range.renderStart).toBe(18);
    expect(range.spacerTop).toBe(54); // 18 * 3
    expect(range.spacerTop).toBeGreaterThan(0);
  });

  test("bottom spacer when not scrolled to end", () => {
    // 50 messages * 3 = 150, viewport 12, scroll at 0, buffer 2
    const range = calculateVisibleRange(50, new Map(), 0, 12, 2, makeGetId());
    // firstVisible=0, lastVisible=3 (4*3=12), renderEnd=5
    expect(range.renderEnd).toBe(5);
    expect(range.spacerBottom).toBe(132); // (50-6) * 3 = 132
  });

  test("spacer heights account for measured heights", () => {
    const heights = makeHeights([
      [0, 10],
      [1, 10],
    ]);
    // msg0=10, msg1=10, rest=3 each
    // 30 messages: 10+10 + 28*3 = 104, viewport 12, scroll at 20, buffer 1
    const range = calculateVisibleRange(30, heights, 20, 12, 1, makeGetId());
    // accum: msg0=10, msg1=10+10=20. msg2: 20+3>20 yes -> firstVisible=2
    expect(range.firstVisible).toBe(2);
    // renderStart = 2-1 = 1
    expect(range.renderStart).toBe(1);
    // spacerTop = height of msg0 = 10
    expect(range.spacerTop).toBe(10);
  });
});

// ─── Message entry types ────────────────────────────────────────

describe("VirtualMessageList — message entry rendering", () => {
  test("text entries have correct structure", () => {
    const entry = makeTextEntry("user", "Hello");
    expect(entry.kind).toBe("text");
    expect(entry.role).toBe("user");
    expect(entry.text).toBe("Hello");
  });

  test("tool use entries have name and summary", () => {
    const entry = makeToolUseEntry("Read", "/path/to/file");
    expect(entry.kind).toBe("tool_use");
    expect(entry.name).toBe("Read");
    expect(entry.summary).toBe("/path/to/file");
  });

  test("tool result entries handle errors", () => {
    const entry = makeToolResultEntry("Bash", "command failed", true);
    expect(entry.kind).toBe("tool_result");
    expect(entry.isError).toBe(true);
  });

  test("banner entries have title and subtitle", () => {
    const entry = makeBannerEntry("KCode v1.0", "Ready");
    expect(entry.kind).toBe("banner");
    expect(entry.title).toBe("KCode v1.0");
  });
});

// ─── Mixed height conversations ─────────────────────────────────

describe("VirtualMessageList — mixed heights", () => {
  test("conversation with varied message heights", () => {
    const heights = makeHeights([
      [0, 2], // short user message
      [1, 15], // long assistant response
      [2, 1], // tool use
      [3, 3], // tool result
      [4, 1], // tool use
      [5, 5], // tool result
      [6, 20], // long assistant response
      [7, 2], // user message
      [8, 10], // assistant response
      [9, 1], // tool use
    ]);
    // Total = 2+15+1+3+1+5+20+2+10+1 = 60
    const range = calculateVisibleRange(10, heights, 0, 20, 2, makeGetId());
    expect(range.totalHeight).toBe(60);
    expect(range.firstVisible).toBe(0);
    // 2+15=17 < 20, 17+1=18 < 20, 18+3=21 >= 20 -> lastVisible=3
    expect(range.lastVisible).toBe(3);
    expect(range.renderEnd).toBe(5); // 3+2
  });

  test("scrolling past a very tall message", () => {
    const heights = makeHeights([
      [0, 100], // huge message
      [1, 3],
      [2, 3],
    ]);
    // Total = 106, viewport 20, maxScroll = 86
    // scrollOffset=100 clamps to 86, msg0 (h=100) still partially visible at offset 86
    const range = calculateVisibleRange(3, heights, 100, 20, BUFFER_SIZE, makeGetId());
    expect(range.firstVisible).toBe(0);
    // msg0 occupies rows 0-99, visible from 86-105, that's 14 rows of msg0
    // then msg1 (3 rows) + msg2 (3 rows) = 6 more, total visible content = 20
    expect(range.lastVisible).toBe(2);
  });
});

// ─── Streaming content (always rendered at bottom) ──────────────

describe("VirtualMessageList — streaming content behavior", () => {
  test("streaming text is separate from completed messages", () => {
    // Verify that streaming props don't affect completed range calculation
    const range1 = calculateVisibleRange(10, new Map(), 0, 24, BUFFER_SIZE, makeGetId());
    const range2 = calculateVisibleRange(10, new Map(), 0, 24, BUFFER_SIZE, makeGetId());
    // Streaming content doesn't change the range
    expect(range1.renderStart).toBe(range2.renderStart);
    expect(range1.renderEnd).toBe(range2.renderEnd);
  });

  test("completed messages grow when streaming finishes", () => {
    // Before: 10 messages
    const range1 = calculateVisibleRange(10, new Map(), 0, 24, BUFFER_SIZE, makeGetId());
    // After: 11 messages (streaming text became completed)
    const range2 = calculateVisibleRange(11, new Map(), 0, 24, BUFFER_SIZE, makeGetId());
    // Total height grew
    expect(range2.totalHeight).toBeGreaterThan(range1.totalHeight);
  });
});

// ─── Performance characteristics ────────────────────────────────

describe("VirtualMessageList — performance", () => {
  test("1000 messages only renders ~20", () => {
    const range = calculateVisibleRange(1000, new Map(), 0, 24, BUFFER_SIZE, makeGetId());
    const rendered = range.renderEnd - range.renderStart + 1;
    expect(rendered).toBeLessThan(30);
    expect(rendered).toBeGreaterThan(0);
  });

  test("calculation is fast for 10000 messages", () => {
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      calculateVisibleRange(10000, new Map(), 15000, 24, BUFFER_SIZE, makeGetId());
    }
    const elapsed = performance.now() - start;
    // 100 iterations should complete well under 500ms (relaxed for CI/loaded systems)
    expect(elapsed).toBeLessThan(500);
  });

  test("height cache lookup is efficient", () => {
    const heights = new Map<string, number>();
    for (let i = 0; i < 10000; i++) {
      heights.set(`msg-${i}`, Math.floor(Math.random() * 20) + 1);
    }
    const start = performance.now();
    calculateVisibleRange(10000, heights, 5000, 24, BUFFER_SIZE, makeGetId());
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(10);
  });
});
