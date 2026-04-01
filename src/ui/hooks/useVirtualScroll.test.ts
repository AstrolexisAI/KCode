// KCode - useVirtualScroll pure function tests
// Tests calculateVisibleRange and maxScrollOffset without React

import { describe, expect, test } from "bun:test";
import {
  BUFFER_SIZE,
  calculateVisibleRange,
  DEFAULT_HEIGHT,
  maxScrollOffset,
} from "./useVirtualScroll";

// ─── Helpers ────────────────────────────────────────────────────

function makeGetId(prefix = "msg") {
  return (index: number) => `${prefix}-${index}`;
}

function makeHeights(entries: Array<[number, number]>): Map<string, number> {
  const map = new Map<string, number>();
  for (const [index, height] of entries) {
    map.set(`msg-${index}`, height);
  }
  return map;
}

// ─── calculateVisibleRange ──────────────────────────────────────

describe("calculateVisibleRange", () => {
  test("returns empty range for zero messages", () => {
    const range = calculateVisibleRange(0, new Map(), 0, 24, BUFFER_SIZE, makeGetId());
    expect(range.renderStart).toBe(0);
    expect(range.renderEnd).toBe(-1);
    expect(range.firstVisible).toBe(0);
    expect(range.lastVisible).toBe(-1);
    expect(range.totalHeight).toBe(0);
    expect(range.spacerTop).toBe(0);
    expect(range.spacerBottom).toBe(0);
  });

  test("single message fits in viewport", () => {
    const heights = makeHeights([[0, 5]]);
    const range = calculateVisibleRange(1, heights, 0, 24, BUFFER_SIZE, makeGetId());
    expect(range.renderStart).toBe(0);
    expect(range.renderEnd).toBe(0);
    expect(range.firstVisible).toBe(0);
    expect(range.lastVisible).toBe(0);
    expect(range.totalHeight).toBe(5);
    expect(range.spacerTop).toBe(0);
    expect(range.spacerBottom).toBe(0);
  });

  test("all messages fit in viewport without scrolling", () => {
    // 5 messages * 3 rows default = 15, viewport = 24
    const range = calculateVisibleRange(5, new Map(), 0, 24, BUFFER_SIZE, makeGetId());
    expect(range.renderStart).toBe(0);
    expect(range.renderEnd).toBe(4);
    expect(range.firstVisible).toBe(0);
    expect(range.lastVisible).toBe(4);
    expect(range.totalHeight).toBe(15); // 5 * DEFAULT_HEIGHT(3)
  });

  test("uses DEFAULT_HEIGHT for unmeasured messages", () => {
    const range = calculateVisibleRange(10, new Map(), 0, 9, BUFFER_SIZE, makeGetId());
    // Viewport of 9 rows, messages are 3 rows each -> 3 messages visible
    expect(range.firstVisible).toBe(0);
    expect(range.lastVisible).toBe(2); // 3 messages * 3 = 9
    expect(range.totalHeight).toBe(30); // 10 * 3
  });

  test("scrolled to middle shows correct range", () => {
    // 20 messages, each 3 rows = 60 total, viewport 12
    const range = calculateVisibleRange(20, new Map(), 15, 12, BUFFER_SIZE, makeGetId());
    // scrollOffset=15 -> first visible at message 5 (5*3=15)
    expect(range.firstVisible).toBe(5);
    // 12 rows / 3 per message = 4 visible -> lastVisible = 8
    expect(range.lastVisible).toBe(8);
    // buffer: renderStart = max(0, 5-5) = 0, renderEnd = min(19, 8+5) = 13
    expect(range.renderStart).toBe(0);
    expect(range.renderEnd).toBe(13);
  });

  test("scrolled to end shows last messages", () => {
    // 20 messages * 3 = 60, viewport 12, maxScroll = 48
    const range = calculateVisibleRange(20, new Map(), 48, 12, BUFFER_SIZE, makeGetId());
    expect(range.firstVisible).toBe(16); // 16*3 = 48
    expect(range.lastVisible).toBe(19);
    expect(range.renderStart).toBe(11); // 16 - 5
    expect(range.renderEnd).toBe(19);
  });

  test("clamps scroll offset to max", () => {
    // 5 messages * 3 = 15, viewport 10, maxScroll = 5
    const range = calculateVisibleRange(5, new Map(), 999, 10, BUFFER_SIZE, makeGetId());
    // Should clamp to maxScroll=5, first visible at message index 1 (after 1*3<5, 2*3>5)
    expect(range.firstVisible).toBe(1);
    expect(range.totalHeight).toBe(15);
  });

  test("clamps scroll offset to zero for negative values", () => {
    const range = calculateVisibleRange(5, new Map(), -10, 24, BUFFER_SIZE, makeGetId());
    expect(range.firstVisible).toBe(0);
  });

  test("uses measured heights from cache", () => {
    const heights = makeHeights([
      [0, 1],
      [1, 1],
      [2, 10],
      [3, 1],
      [4, 1],
    ]);
    // Total = 14, viewport = 5, scrollOffset = 2
    const range = calculateVisibleRange(5, heights, 2, 5, BUFFER_SIZE, makeGetId());
    // offset=2 -> skip msg 0(h=1), msg 1(h=1, accum=2), msg 2 starts at accum=2 which is not > 2
    // Actually: accum starts at 0, msg0 h=1, accum+h=1 > 2? no. accum=1. msg1 h=1, accum+h=2 > 2? no. accum=2. msg2 h=10, accum+h=12 > 2? yes -> firstVisible=2
    expect(range.firstVisible).toBe(2);
  });

  test("spacer heights are correct", () => {
    // 10 messages * 3 each = 30, viewport = 6, scroll to middle
    const range = calculateVisibleRange(10, new Map(), 9, 6, BUFFER_SIZE, makeGetId());
    // firstVisible=3 (3*3=9), lastVisible=4 (2 msgs * 3 = 6 rows)
    // renderStart = max(0, 3-5) = 0, renderEnd = min(9, 4+5) = 9
    expect(range.spacerTop).toBe(0); // renderStart=0, no messages before
    expect(range.spacerBottom).toBe(0); // renderEnd=9, no messages after
  });

  test("spacer heights with large message set", () => {
    // 30 messages * 3 = 90, viewport = 6, buffer = 2
    const range = calculateVisibleRange(30, new Map(), 30, 6, 2, makeGetId());
    // firstVisible=10 (10*3=30), lastVisible=11 (2 msgs visible)
    // renderStart = 10-2 = 8, renderEnd = 11+2 = 13
    expect(range.renderStart).toBe(8);
    expect(range.renderEnd).toBe(13);
    expect(range.spacerTop).toBe(24); // 8 * 3
    expect(range.spacerBottom).toBe(48); // (30 - 14) * 3 = 16 * 3
  });

  test("buffer size 0 renders only visible messages", () => {
    const range = calculateVisibleRange(20, new Map(), 15, 9, 0, makeGetId());
    expect(range.renderStart).toBe(range.firstVisible);
    expect(range.renderEnd).toBe(range.lastVisible);
  });

  test("mixed measured and unmeasured heights", () => {
    const heights = makeHeights([
      [0, 10], // large
      [2, 1], // small
      // rest use DEFAULT_HEIGHT = 3
    ]);
    // msg0=10, msg1=3, msg2=1, msg3=3, msg4=3 = 20 total
    const range = calculateVisibleRange(5, heights, 0, 15, BUFFER_SIZE, makeGetId());
    expect(range.totalHeight).toBe(20);
    expect(range.firstVisible).toBe(0);
    // 10 + 3 = 13 < 15, 13 + 1 = 14 < 15, 14 + 3 = 17 >= 15 -> lastVisible=3
    expect(range.lastVisible).toBe(3);
  });

  test("all messages taller than viewport shows one at a time", () => {
    const heights = makeHeights([
      [0, 50],
      [1, 50],
      [2, 50],
    ]);
    const range = calculateVisibleRange(3, heights, 0, 10, BUFFER_SIZE, makeGetId());
    expect(range.firstVisible).toBe(0);
    expect(range.lastVisible).toBe(0); // single 50-row message fills viewport
  });
});

// ─── maxScrollOffset ────────────────────────────────────────────

describe("maxScrollOffset", () => {
  test("returns 0 when content fits in viewport", () => {
    expect(maxScrollOffset(10, 24)).toBe(0);
  });

  test("returns 0 when content equals viewport", () => {
    expect(maxScrollOffset(24, 24)).toBe(0);
  });

  test("returns difference when content exceeds viewport", () => {
    expect(maxScrollOffset(100, 24)).toBe(76);
  });

  test("returns 0 for zero content", () => {
    expect(maxScrollOffset(0, 24)).toBe(0);
  });
});

// ─── Edge cases ─────────────────────────────────────────────────

describe("calculateVisibleRange — edge cases", () => {
  test("one-row viewport", () => {
    const range = calculateVisibleRange(10, new Map(), 0, 1, BUFFER_SIZE, makeGetId());
    expect(range.firstVisible).toBe(0);
    // Only 1 row visible, message is 3 rows -> lastVisible stays 0
    expect(range.lastVisible).toBe(0);
  });

  test("very large buffer does not exceed bounds", () => {
    const range = calculateVisibleRange(3, new Map(), 0, 9, 100, makeGetId());
    expect(range.renderStart).toBe(0);
    expect(range.renderEnd).toBe(2);
  });

  test("scroll offset exactly at message boundary", () => {
    // Each message is 3 rows, scrollOffset=6 -> exactly at start of message 2
    const range = calculateVisibleRange(10, new Map(), 6, 9, 2, makeGetId());
    expect(range.firstVisible).toBe(2);
  });

  test("custom prefix in getMessageId", () => {
    const heights = new Map<string, number>();
    heights.set("custom-0", 5);
    heights.set("custom-1", 5);
    const range = calculateVisibleRange(2, heights, 0, 10, BUFFER_SIZE, makeGetId("custom"));
    expect(range.totalHeight).toBe(10);
    expect(range.firstVisible).toBe(0);
    expect(range.lastVisible).toBe(1);
  });
});
