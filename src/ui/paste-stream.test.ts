// KCode - Paste stream integration tests
// Tests the stdin paste interceptor logic

import { describe, test, expect } from "bun:test";

// We can't test the full stdin monkey-patching, but we CAN test
// the detection heuristic that the interceptor uses.

describe("Paste detection heuristic", () => {
  // The core rule: a single data chunk with both printable chars
  // and newlines is a multiline paste.

  function isPasteChunk(str: string): boolean {
    // Strip bracketed paste sequences
    const cleaned = str
      .replace(/\x1b\[200~/g, "")
      .replace(/\x1b\[201~/g, "")
      .replace(/\[200~/g, "")
      .replace(/\[201~/g, "");
    if (cleaned.length === 0) return false;

    const hasNewline = cleaned.includes("\n") || cleaned.includes("\r");
    const printable = cleaned.replace(/[\r\n\x1b\x00-\x1f]/g, "");
    return hasNewline && printable.length > 0;
  }

  test("multiline text is detected as paste", () => {
    expect(isPasteChunk("line1\nline2")).toBe(true);
  });

  test("single character is not paste", () => {
    expect(isPasteChunk("a")).toBe(false);
  });

  test("single Enter (\\r) is not paste", () => {
    expect(isPasteChunk("\r")).toBe(false);
  });

  test("single Enter (\\n) is not paste", () => {
    expect(isPasteChunk("\n")).toBe(false);
  });

  test("\\r\\n alone is not paste", () => {
    expect(isPasteChunk("\r\n")).toBe(false);
  });

  test("multiline with tables is paste", () => {
    const text = "| A | B | C |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |";
    expect(isPasteChunk(text)).toBe(true);
  });

  test("multiline with empty lines is paste", () => {
    const text = "line1\n\nline3\n\nline5";
    expect(isPasteChunk(text)).toBe(true);
  });

  test("bracketed paste sequences are stripped", () => {
    // Only bracket sequences, no content
    expect(isPasteChunk("\x1b[200~")).toBe(false);
    expect(isPasteChunk("\x1b[201~")).toBe(false);
    expect(isPasteChunk("[200~")).toBe(false);
  });

  test("bracketed paste with content is detected", () => {
    const text = "\x1b[200~hello\nworld\x1b[201~";
    expect(isPasteChunk(text)).toBe(true);
  });

  test("bare bracket sequences with content is detected", () => {
    const text = "[200~hello\nworld[201~";
    expect(isPasteChunk(text)).toBe(true);
  });

  test("long paste with markdown structure", () => {
    const text = `### HEADING
* bullet 1
* bullet 2

| Col A | Col B |
| ----- | ----- |
| val1  | val2  |

Paragraph text here.`;
    expect(isPasteChunk(text)).toBe(true);
  });

  test("single line with no newline is not paste", () => {
    expect(isPasteChunk("just a single line of text")).toBe(false);
  });

  test("text with \\r\\n (Windows-style) is paste", () => {
    expect(isPasteChunk("line1\r\nline2\r\nline3")).toBe(true);
  });
});

describe("Paste content integrity", () => {
  function normalizePaste(str: string): string {
    const cleaned = str
      .replace(/\x1b\[200~/g, "")
      .replace(/\x1b\[201~/g, "")
      .replace(/\[200~/g, "")
      .replace(/\[201~/g, "");
    return cleaned.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  test("preserves all newlines", () => {
    const input = "line1\nline2\nline3";
    expect(normalizePaste(input).split("\n").length).toBe(3);
  });

  test("preserves empty lines", () => {
    const input = "line1\n\n\nline4";
    expect(normalizePaste(input).split("\n").length).toBe(4);
  });

  test("preserves indentation", () => {
    const input = "  indented\n    double indented\n\ttabbed";
    const result = normalizePaste(input);
    expect(result).toContain("  indented");
    expect(result).toContain("    double indented");
    expect(result).toContain("\ttabbed");
  });

  test("preserves markdown tables", () => {
    const input = "| Product | A | B |\n| ------- | - | - |\n| P1      | 10| 0 |";
    const result = normalizePaste(input);
    expect(result.split("\n").length).toBe(3);
    expect(result).toContain("| Product | A | B |");
    expect(result).toContain("| P1      | 10| 0 |");
  });

  test("strips bracketed paste sequences cleanly", () => {
    const input = "\x1b[200~hello world\x1b[201~";
    expect(normalizePaste(input)).toBe("hello world");
  });

  test("strips bare bracket sequences", () => {
    const input = "[200~hello world[201~";
    expect(normalizePaste(input)).toBe("hello world");
  });

  test("normalizes Windows line endings", () => {
    const input = "line1\r\nline2\r\nline3";
    expect(normalizePaste(input)).toBe("line1\nline2\nline3");
  });

  test("normalizes bare \\r", () => {
    const input = "line1\rline2\rline3";
    expect(normalizePaste(input)).toBe("line1\nline2\nline3");
  });

  test("large paste preserves character count", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}: some content here`);
    const input = lines.join("\n");
    const result = normalizePaste(input);
    expect(result.split("\n").length).toBe(100);
    expect(result).toContain("Line 1:");
    expect(result).toContain("Line 100:");
  });
});
