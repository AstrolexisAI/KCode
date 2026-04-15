// Phase 29 — multiline cursor helpers unit tests.
// Covers offsetToRowCol / rowColToOffset — the translation
// primitives behind cursor Up/Down navigation in multiline
// paste editing.

import { describe, expect, test } from "bun:test";
import { offsetToRowCol, rowColToOffset } from "./InputPrompt";

describe("offsetToRowCol", () => {
  test("returns (0,0) for empty string at offset 0", () => {
    expect(offsetToRowCol("", 0)).toEqual({ row: 0, col: 0 });
  });

  test("single-line positions", () => {
    expect(offsetToRowCol("hello world", 0)).toEqual({ row: 0, col: 0 });
    expect(offsetToRowCol("hello world", 5)).toEqual({ row: 0, col: 5 });
    expect(offsetToRowCol("hello world", 11)).toEqual({ row: 0, col: 11 });
  });

  test("multi-line positions", () => {
    const text = "abc\ndef\nghi";
    // a=0 b=1 c=2 \n=3 d=4 e=5 f=6 \n=7 g=8 h=9 i=10
    expect(offsetToRowCol(text, 0)).toEqual({ row: 0, col: 0 });
    expect(offsetToRowCol(text, 3)).toEqual({ row: 0, col: 3 }); // on the newline itself
    expect(offsetToRowCol(text, 4)).toEqual({ row: 1, col: 0 }); // start of 2nd line
    expect(offsetToRowCol(text, 7)).toEqual({ row: 1, col: 3 });
    expect(offsetToRowCol(text, 8)).toEqual({ row: 2, col: 0 });
    expect(offsetToRowCol(text, 11)).toEqual({ row: 2, col: 3 });
  });

  test("clamps negative offset to 0", () => {
    expect(offsetToRowCol("abc\ndef", -5)).toEqual({ row: 0, col: 0 });
  });

  test("clamps overflow offset to end", () => {
    const text = "abc\ndef"; // length 7
    expect(offsetToRowCol(text, 100)).toEqual({ row: 1, col: 3 });
  });

  test("handles empty lines in the middle", () => {
    const text = "a\n\nb";
    expect(offsetToRowCol(text, 2)).toEqual({ row: 1, col: 0 });
    expect(offsetToRowCol(text, 3)).toEqual({ row: 2, col: 0 });
  });
});

describe("rowColToOffset", () => {
  test("returns 0 for (0,0)", () => {
    expect(rowColToOffset("anything", 0, 0)).toBe(0);
  });

  test("single-line offsets", () => {
    expect(rowColToOffset("hello", 0, 0)).toBe(0);
    expect(rowColToOffset("hello", 0, 3)).toBe(3);
    expect(rowColToOffset("hello", 0, 5)).toBe(5);
  });

  test("multi-line offsets", () => {
    const text = "abc\ndef\nghi";
    expect(rowColToOffset(text, 0, 0)).toBe(0);
    expect(rowColToOffset(text, 0, 3)).toBe(3);
    expect(rowColToOffset(text, 1, 0)).toBe(4);
    expect(rowColToOffset(text, 1, 3)).toBe(7);
    expect(rowColToOffset(text, 2, 0)).toBe(8);
    expect(rowColToOffset(text, 2, 3)).toBe(11);
  });

  test("clamps col to end of line", () => {
    const text = "ab\ncde\nfg";
    // row 0 has 2 chars, col 10 should clamp to col 2
    expect(rowColToOffset(text, 0, 10)).toBe(2);
    // row 1 has 3 chars, col 10 should clamp to col 3
    expect(rowColToOffset(text, 1, 10)).toBe(6);
  });

  test("clamps row to last line", () => {
    const text = "ab\ncd";
    expect(rowColToOffset(text, 100, 0)).toBe(3); // start of row 1
    expect(rowColToOffset(text, 100, 100)).toBe(5); // end of row 1
  });

  test("round-trip with offsetToRowCol", () => {
    const text = "first line\nsecond\n\nfourth line here";
    for (let i = 0; i <= text.length; i++) {
      const { row, col } = offsetToRowCol(text, i);
      const back = rowColToOffset(text, row, col);
      expect(back).toBe(i);
    }
  });
});

describe("multiline navigation scenarios", () => {
  test("Up arrow from middle of second line preserves column", () => {
    const text = "hello world\nfoo bar";
    // cursor at position 14 = row 1, col 2 (on 'o' of "foo")
    const cursor = 14;
    const { row, col } = offsetToRowCol(text, cursor);
    expect(row).toBe(1);
    expect(col).toBe(2);
    // Simulate Up: go to row 0, col 2
    const lines = text.split("\n");
    const prevLine = lines[0]!;
    const newCol = Math.min(col, prevLine.length);
    const newCursor = rowColToOffset(text, 0, newCol);
    expect(newCursor).toBe(2); // col 2 of "hello world"
  });

  test("Up from short line onto longer previous line uses col as requested", () => {
    const text = "longer first line\nab";
    // cursor at position 20 = row 1, col 2 (end of "ab")
    const cursor = 20;
    const { col } = offsetToRowCol(text, cursor);
    expect(col).toBe(2);
    const newCursor = rowColToOffset(text, 0, col);
    expect(newCursor).toBe(2); // col 2 of "longer first line"
  });

  test("Down from long line onto short line clamps column", () => {
    const text = "longer first line\nab";
    // cursor at position 10 = row 0, col 10
    const cursor = 10;
    const { col } = offsetToRowCol(text, cursor);
    expect(col).toBe(10);
    // Simulate Down: row 1, col min(10, 2) = 2
    const lines = text.split("\n");
    const nextLine = lines[1]!;
    const newCol = Math.min(col, nextLine.length);
    expect(newCol).toBe(2);
    const newCursor = rowColToOffset(text, 1, newCol);
    expect(newCursor).toBe(20); // end of "ab"
  });
});
