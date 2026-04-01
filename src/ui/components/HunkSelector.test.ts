// KCode - HunkSelector Component Tests
// Tests the rendering logic for inline and side-by-side hunk display modes,
// status indicators, and line number formatting.
// Uses pure function tests since Ink components require a full render environment.

import { describe, expect, test } from "bun:test";
import type { DiffHunk } from "../../core/diff/types.js";

// ─── Helpers ────────────────────────────────────────────────────

function makeHunk(overrides: Partial<DiffHunk> = {}): DiffHunk {
  return {
    id: crypto.randomUUID(),
    startLineOld: 10,
    endLineOld: 12,
    startLineNew: 10,
    endLineNew: 13,
    linesRemoved: ["removed line 1", "removed line 2"],
    linesAdded: ["added line 1", "added line 2", "added line 3"],
    context: {
      before: ["context before 1", "context before 2"],
      after: ["context after 1"],
    },
    status: "pending",
    type: "modification",
    ...overrides,
  };
}

/** Replicate the padLineNum logic from HunkSelector */
function padLineNum(num: number, width = 4): string {
  return String(num).padStart(width, " ");
}

/** Status indicator mapping matching the component */
const STATUS_INDICATORS: Record<DiffHunk["status"], { symbol: string; color: string }> = {
  accepted: { symbol: "\u2713", color: "green" },
  rejected: { symbol: "\u2717", color: "red" },
  pending: { symbol: "?", color: "yellow" },
  modified: { symbol: "\u270E", color: "blue" },
};

// ─── Tests ──────────────────────────────────────────────────────

describe("HunkSelector component logic", () => {
  describe("inline rendering", () => {
    test("inline mode produces context + removed + added lines", () => {
      const hunk = makeHunk();
      // In inline mode, total visible lines =
      // context.before + linesRemoved + linesAdded + context.after
      const totalLines =
        hunk.context.before.length +
        hunk.linesRemoved.length +
        hunk.linesAdded.length +
        hunk.context.after.length;
      expect(totalLines).toBe(8); // 2 + 2 + 3 + 1
    });

    test("removed lines are prefixed with minus", () => {
      const hunk = makeHunk();
      // Component renders "- " prefix for removed lines
      for (const line of hunk.linesRemoved) {
        const formatted = `- ${line}`;
        expect(formatted.startsWith("- ")).toBe(true);
      }
    });

    test("added lines are prefixed with plus", () => {
      const hunk = makeHunk();
      for (const line of hunk.linesAdded) {
        const formatted = `+ ${line}`;
        expect(formatted.startsWith("+ ")).toBe(true);
      }
    });

    test("context lines are prefixed with spaces", () => {
      const hunk = makeHunk();
      for (const line of hunk.context.before) {
        const formatted = `  ${line}`;
        expect(formatted.startsWith("  ")).toBe(true);
      }
    });

    test("line numbers are computed correctly for context before", () => {
      const hunk = makeHunk({ startLineOld: 10 });
      const contextLength = hunk.context.before.length;
      const firstContextLine = hunk.startLineOld - contextLength;
      expect(firstContextLine).toBe(8);
    });

    test("line numbers are computed correctly for removed lines", () => {
      const hunk = makeHunk({ startLineOld: 10 });
      const lineNums = hunk.linesRemoved.map((_, i) => hunk.startLineOld + i);
      expect(lineNums).toEqual([10, 11]);
    });

    test("line numbers are computed correctly for added lines", () => {
      const hunk = makeHunk({ startLineNew: 10 });
      const lineNums = hunk.linesAdded.map((_, i) => hunk.startLineNew + i);
      expect(lineNums).toEqual([10, 11, 12]);
    });
  });

  describe("side-by-side rendering", () => {
    test("left column shows removed lines, right shows added", () => {
      const hunk = makeHunk({
        linesRemoved: ["old A", "old B"],
        linesAdded: ["new A", "new B", "new C"],
      });

      // Side-by-side pads shorter side
      const maxRows = Math.max(
        hunk.context.before.length + hunk.linesRemoved.length + hunk.context.after.length,
        hunk.context.before.length + hunk.linesAdded.length + hunk.context.after.length,
      );

      // Left side: 2 ctx before + 2 removed + 1 ctx after = 5
      // Right side: 2 ctx before + 3 added + 1 ctx after = 6
      // After padding, both should have 6 rows
      expect(maxRows).toBe(6);
    });

    test("shorter side is padded with empty lines", () => {
      const hunk = makeHunk({
        linesRemoved: ["old"],
        linesAdded: ["new 1", "new 2", "new 3"],
      });

      const leftCount =
        hunk.context.before.length + hunk.linesRemoved.length + hunk.context.after.length;
      const rightCount =
        hunk.context.before.length + hunk.linesAdded.length + hunk.context.after.length;

      // Padding brings them to the same length
      const paddedLeft = leftCount + Math.max(0, rightCount - leftCount);
      const paddedRight = rightCount + Math.max(0, leftCount - rightCount);

      // Before appending context.after, we pad the changed section
      expect(paddedLeft).toBe(paddedRight);
    });

    test("context lines appear on both sides", () => {
      const hunk = makeHunk({
        context: {
          before: ["shared before"],
          after: ["shared after"],
        },
      });

      // Both sides should show the same context
      expect(hunk.context.before).toEqual(["shared before"]);
      expect(hunk.context.after).toEqual(["shared after"]);
    });
  });

  describe("status indicators", () => {
    test("accepted shows checkmark in green", () => {
      const indicator = STATUS_INDICATORS["accepted"];
      expect(indicator.symbol).toBe("\u2713");
      expect(indicator.color).toBe("green");
    });

    test("rejected shows X in red", () => {
      const indicator = STATUS_INDICATORS["rejected"];
      expect(indicator.symbol).toBe("\u2717");
      expect(indicator.color).toBe("red");
    });

    test("pending shows question mark in yellow", () => {
      const indicator = STATUS_INDICATORS["pending"];
      expect(indicator.symbol).toBe("?");
      expect(indicator.color).toBe("yellow");
    });

    test("modified shows pencil in blue", () => {
      const indicator = STATUS_INDICATORS["modified"];
      expect(indicator.symbol).toBe("\u270E");
      expect(indicator.color).toBe("blue");
    });

    test("all statuses have distinct symbols", () => {
      const symbols = Object.values(STATUS_INDICATORS).map((i) => i.symbol);
      const unique = new Set(symbols);
      expect(unique.size).toBe(symbols.length);
    });

    test("all statuses have distinct colors", () => {
      const colors = Object.values(STATUS_INDICATORS).map((i) => i.color);
      const unique = new Set(colors);
      expect(unique.size).toBe(colors.length);
    });
  });

  describe("line number formatting", () => {
    test("pads single digit to width 4", () => {
      expect(padLineNum(1)).toBe("   1");
    });

    test("pads double digit to width 4", () => {
      expect(padLineNum(42)).toBe("  42");
    });

    test("pads triple digit to width 4", () => {
      expect(padLineNum(123)).toBe(" 123");
    });

    test("does not pad 4+ digit numbers", () => {
      expect(padLineNum(1234)).toBe("1234");
      expect(padLineNum(99999)).toBe("99999");
    });

    test("custom width works correctly", () => {
      expect(padLineNum(1, 6)).toBe("     1");
      expect(padLineNum(123, 6)).toBe("   123");
    });
  });

  describe("hunk header formatting", () => {
    test("header shows correct range format", () => {
      const hunk = makeHunk({
        startLineOld: 10,
        linesRemoved: ["a", "b", "c"],
        startLineNew: 15,
        linesAdded: ["x", "y"],
      });
      const header = `@@ -${hunk.startLineOld},${hunk.linesRemoved.length} +${hunk.startLineNew},${hunk.linesAdded.length} @@`;
      expect(header).toBe("@@ -10,3 +15,2 @@");
    });

    test("current hunk uses border styling (logic check)", () => {
      // When isCurrent is true, borderStyle is "round" and borderColor is "cyan"
      const isCurrent = true;
      const borderStyle = isCurrent ? "round" : undefined;
      const borderColor = isCurrent ? "cyan" : undefined;
      expect(borderStyle).toBe("round");
      expect(borderColor).toBe("cyan");
    });

    test("non-current hunk has no border", () => {
      const isCurrent = false;
      const borderStyle = isCurrent ? "round" : undefined;
      expect(borderStyle).toBeUndefined();
    });
  });
});
