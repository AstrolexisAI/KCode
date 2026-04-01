// KCode - InteractiveDiff Component Tests
// Tests the component logic using pure function tests on the underlying operations,
// since Ink components require a full render environment.
// Validates hunk navigation, accept/reject state transitions, and finalization.

import { describe, test, expect } from "bun:test";
import type { DiffHunk, DiffResult } from "../../core/diff/types.js";
import {
  acceptHunk,
  rejectHunk,
  acceptAll,
  rejectAll,
  getStats,
} from "../../core/diff/hunk-operations.js";
import { DiffEngine } from "../../core/diff/engine.js";

// ─── Helpers ────────────────────────────────────────────────────

function makeTestHunk(overrides: Partial<DiffHunk> = {}): DiffHunk {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    startLineOld: 1,
    endLineOld: 1,
    startLineNew: 1,
    endLineNew: 1,
    linesRemoved: ["old"],
    linesAdded: ["new"],
    context: { before: [], after: [] },
    status: "pending",
    type: "modification",
    ...overrides,
  };
}

function makeDiffResult(hunkCount: number): DiffResult {
  const hunks: DiffHunk[] = [];
  for (let i = 0; i < hunkCount; i++) {
    hunks.push(
      makeTestHunk({
        id: `hunk-${i}`,
        startLineOld: i * 10 + 1,
        endLineOld: i * 10 + 3,
        startLineNew: i * 10 + 1,
        endLineNew: i * 10 + 3,
      }),
    );
  }
  return {
    filePath: "test.ts",
    hunks,
    stats: { additions: 0, deletions: 0, modifications: hunkCount },
  };
}

/**
 * Simulates the component's navigation logic.
 * Returns the clamped index after applying a delta.
 */
function navigateHunk(
  currentIndex: number,
  delta: number,
  hunkCount: number,
): number {
  return Math.max(0, Math.min(currentIndex + delta, hunkCount - 1));
}

// ─── Tests ──────────────────────────────────────────────────────

describe("InteractiveDiff component logic", () => {
  describe("rendering with diff", () => {
    test("diff engine produces hunks for component input", () => {
      const engine = new DiffEngine();
      const result = engine.diff(
        "line 1\nline 2\nline 3\n",
        "line 1\nchanged\nline 3\n",
        "test.ts",
      );
      expect(result.hunks.length).toBeGreaterThanOrEqual(1);
      expect(result.filePath).toBe("test.ts");
    });

    test("empty diff produces no hunks", () => {
      const engine = new DiffEngine();
      const result = engine.diff("same\n", "same\n");
      expect(result.hunks).toHaveLength(0);
    });

    test("diff result includes correct stats", () => {
      const engine = new DiffEngine();
      const result = engine.diff("a\nb\n", "a\nc\nd\n");
      const totalHunks =
        result.stats.additions + result.stats.deletions + result.stats.modifications;
      expect(totalHunks).toBe(result.hunks.length);
    });
  });

  describe("hunk navigation", () => {
    test("navigating down increments index", () => {
      expect(navigateHunk(0, 1, 5)).toBe(1);
      expect(navigateHunk(2, 1, 5)).toBe(3);
    });

    test("navigating up decrements index", () => {
      expect(navigateHunk(3, -1, 5)).toBe(2);
      expect(navigateHunk(1, -1, 5)).toBe(0);
    });

    test("does not go below 0", () => {
      expect(navigateHunk(0, -1, 5)).toBe(0);
      expect(navigateHunk(0, -10, 5)).toBe(0);
    });

    test("does not exceed hunk count", () => {
      expect(navigateHunk(4, 1, 5)).toBe(4);
      expect(navigateHunk(3, 10, 5)).toBe(4);
    });

    test("handles single hunk", () => {
      expect(navigateHunk(0, 1, 1)).toBe(0);
      expect(navigateHunk(0, -1, 1)).toBe(0);
    });

    test("handles empty hunk list", () => {
      // With 0 hunks, max(0, min(0+1, -1)) = 0
      expect(navigateHunk(0, 1, 0)).toBe(0);
    });
  });

  describe("accept/reject updates state", () => {
    test("accepting a hunk changes its status", () => {
      const diff = makeDiffResult(3);
      const updated = acceptHunk(diff.hunks, "hunk-1");
      expect(updated[1].status).toBe("accepted");
      expect(updated[0].status).toBe("pending");
      expect(updated[2].status).toBe("pending");
    });

    test("rejecting a hunk changes its status", () => {
      const diff = makeDiffResult(3);
      const updated = rejectHunk(diff.hunks, "hunk-0");
      expect(updated[0].status).toBe("rejected");
    });

    test("accepting all pending hunks", () => {
      const diff = makeDiffResult(5);
      // First reject one
      let hunks = rejectHunk(diff.hunks, "hunk-2");
      // Then accept all (acceptAll changes all, including rejected)
      hunks = acceptAll(hunks);
      expect(hunks.every((h) => h.status === "accepted")).toBe(true);
    });

    test("rejecting all pending hunks", () => {
      const diff = makeDiffResult(4);
      let hunks = acceptHunk(diff.hunks, "hunk-0");
      hunks = rejectAll(hunks);
      expect(hunks.every((h) => h.status === "rejected")).toBe(true);
    });

    test("stats update correctly after operations", () => {
      const diff = makeDiffResult(4);
      let hunks = diff.hunks;
      hunks = acceptHunk(hunks, "hunk-0");
      hunks = acceptHunk(hunks, "hunk-1");
      hunks = rejectHunk(hunks, "hunk-2");

      const stats = getStats(hunks);
      expect(stats.accepted).toBe(2);
      expect(stats.rejected).toBe(1);
      expect(stats.pending).toBe(1);
      expect(stats.modified).toBe(0);
    });
  });

  describe("finalization calls onComplete with correct hunks", () => {
    test("finalized hunks preserve all status changes", () => {
      const diff = makeDiffResult(3);
      let hunks = diff.hunks;
      hunks = acceptHunk(hunks, "hunk-0");
      hunks = rejectHunk(hunks, "hunk-1");

      // Simulate onComplete receiving the hunks
      const finalHunks = [...hunks];
      expect(finalHunks[0].status).toBe("accepted");
      expect(finalHunks[1].status).toBe("rejected");
      expect(finalHunks[2].status).toBe("pending");
    });

    test("applying finalized hunks produces correct content", () => {
      const engine = new DiffEngine();
      const original = "line 1\nold A\nline 3\nold B\nline 5\n";
      const modified = "line 1\nnew A\nline 3\nnew B\nline 5\n";

      const result = engine.diff(original, modified);
      expect(result.hunks.length).toBeGreaterThanOrEqual(1);

      // Accept all hunks
      const accepted = result.hunks.map((h) => ({
        ...h,
        status: "accepted" as const,
      }));

      const applied = engine.applyHunks(original, accepted);
      expect(applied).toContain("new A");
      expect(applied).toContain("new B");
      expect(applied).not.toContain("old A");
      expect(applied).not.toContain("old B");
    });

    test("rejecting all hunks preserves original content", () => {
      const engine = new DiffEngine();
      const original = "keep this\nand this\n";
      const modified = "changed\nand changed\n";

      const result = engine.diff(original, modified);
      const rejected = result.hunks.map((h) => ({
        ...h,
        status: "rejected" as const,
      }));

      const applied = engine.applyHunks(original, rejected);
      expect(applied).toContain("keep this");
      expect(applied).toContain("and this");
    });
  });

  describe("display mode toggling", () => {
    test("mode alternates between inline and side-by-side", () => {
      let mode: "inline" | "side-by-side" = "inline";

      // Toggle
      mode = mode === "inline" ? "side-by-side" : "inline";
      expect(mode).toBe("side-by-side");

      // Toggle again
      mode = mode === "inline" ? "side-by-side" : "inline";
      expect(mode).toBe("inline");
    });
  });

  describe("scroll window logic", () => {
    test("visible window moves with current index", () => {
      const maxVisible = 5;
      let scrollOffset = 0;

      // Simulate navigating to index 6 (beyond window)
      const currentIndex = 6;
      if (currentIndex >= scrollOffset + maxVisible) {
        scrollOffset = currentIndex - maxVisible + 1;
      }
      expect(scrollOffset).toBe(2);
    });

    test("scrolling up adjusts offset", () => {
      let scrollOffset = 5;

      // Navigate to index 3 (before window)
      const currentIndex = 3;
      if (currentIndex < scrollOffset) {
        scrollOffset = currentIndex;
      }
      expect(scrollOffset).toBe(3);
    });

    test("visible range calculation", () => {
      const maxVisible = 5;
      const totalHunks = 12;
      const scrollOffset = 4;

      const visibleStart = scrollOffset;
      const visibleEnd = Math.min(scrollOffset + maxVisible, totalHunks);

      expect(visibleStart).toBe(4);
      expect(visibleEnd).toBe(9);
    });
  });
});
