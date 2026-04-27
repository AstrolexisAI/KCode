// KCode - MergeResolver Component Tests
// Tests the merge resolution logic using pure function tests on the underlying operations.
// Validates conflict display, resolution selection, navigation, and output generation.

import { describe, expect, test } from "bun:test";
import { ThreeWayMerge } from "../../core/diff/three-way-merge.js";
import type { MergeConflict, MergeResult } from "../../core/diff/types.js";

// ─── Helpers ────────────────────────────────────────────────────

const merger = new ThreeWayMerge();

function makeConflictResult(): MergeResult {
  const base = "line 1\nshared\nline 3\n";
  const ours = "line 1\nour change\nline 3\n";
  const theirs = "line 1\ntheir change\nline 3\n";
  return merger.merge(base, ours, theirs);
}

function makeMultiConflictResult(): MergeResult {
  const base =
    [
      "header",
      "section A",
      "middle 1",
      "middle 2",
      "middle 3",
      "middle 4",
      "middle 5",
      "middle 6",
      "middle 7",
      "section B",
      "footer",
    ].join("\n") + "\n";

  const ours = base.replace("section A", "OUR A").replace("section B", "OUR B");
  const theirs = base.replace("section A", "THEIR A").replace("section B", "THEIR B");

  return merger.merge(base, ours, theirs);
}

/**
 * Simulates navigation between conflicts.
 */
function navigateConflict(currentIndex: number, delta: number, conflictCount: number): number {
  if (delta > 0) return Math.min(currentIndex + 1, conflictCount - 1);
  if (delta < 0) return Math.max(currentIndex - 1, 0);
  return currentIndex;
}

// ─── Tests ──────────────────────────────────────────────────────

describe("MergeResolver component logic", () => {
  describe("renders conflicts", () => {
    test("merge result contains conflicts for overlapping changes", () => {
      const result = makeConflictResult();
      expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
    });

    test("each conflict has ours, theirs, and base fields", () => {
      const result = makeConflictResult();
      const conflict = result.conflicts[0]!;
      expect(conflict.ours).toBeDefined();
      expect(conflict.theirs).toBeDefined();
      expect(conflict.base).toBeDefined();
      expect(Array.isArray(conflict.ours)).toBe(true);
      expect(Array.isArray(conflict.theirs)).toBe(true);
      expect(Array.isArray(conflict.base)).toBe(true);
    });

    test("conflict contains the correct content from each side", () => {
      const result = makeConflictResult();
      const conflict = result.conflicts[0]!;
      expect(conflict.ours).toContain("our change");
      expect(conflict.theirs).toContain("their change");
    });

    test("conflicts have line number information", () => {
      const result = makeConflictResult();
      const conflict = result.conflicts[0]!;
      expect(conflict.startLine).toBeGreaterThan(0);
      expect(conflict.endLine).toBeGreaterThanOrEqual(conflict.startLine);
    });

    test("no-conflict merge shows zero conflicts", () => {
      const base = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
      const ours = "a\nOUR\nc\nd\ne\nf\ng\nh\ni\nj\n";
      const theirs = "a\nb\nc\nd\ne\nf\ng\nh\ni\nTHEIR\n";
      const result = merger.merge(base, ours, theirs);
      expect(result.conflicts).toHaveLength(0);
    });
  });

  describe("resolution selection", () => {
    test("choosing 'ours' sets resolution correctly", () => {
      let result = makeConflictResult();
      const id = result.conflicts[0]!.id;
      result = merger.resolveConflict(result, id, "ours");
      expect(result.conflicts[0]!.resolution).toBe("ours");
    });

    test("choosing 'theirs' sets resolution correctly", () => {
      let result = makeConflictResult();
      const id = result.conflicts[0]!.id;
      result = merger.resolveConflict(result, id, "theirs");
      expect(result.conflicts[0]!.resolution).toBe("theirs");
    });

    test("choosing 'both' sets resolution correctly", () => {
      let result = makeConflictResult();
      const id = result.conflicts[0]!.id;
      result = merger.resolveConflict(result, id, "both");
      expect(result.conflicts[0]!.resolution).toBe("both");
    });

    test("choosing 'custom' stores custom content", () => {
      let result = makeConflictResult();
      const id = result.conflicts[0]!.id;
      result = merger.resolveConflict(result, id, "custom", "custom text");
      expect(result.conflicts[0]!.resolution).toBe("custom");
      expect(result.conflicts[0]!.customContent).toBe("custom text");
    });

    test("changing resolution overwrites previous choice", () => {
      let result = makeConflictResult();
      const id = result.conflicts[0]!.id;
      result = merger.resolveConflict(result, id, "ours");
      expect(result.conflicts[0]!.resolution).toBe("ours");
      result = merger.resolveConflict(result, id, "theirs");
      expect(result.conflicts[0]!.resolution).toBe("theirs");
    });

    test("resolving a non-existent conflict ID does nothing", () => {
      let result = makeConflictResult();
      const before = result.conflicts[0]!.resolution;
      result = merger.resolveConflict(result, "nonexistent-id", "ours");
      expect(result.conflicts[0]!.resolution).toBe(before);
    });
  });

  describe("navigation between conflicts", () => {
    test("next moves forward", () => {
      expect(navigateConflict(0, 1, 3)).toBe(1);
      expect(navigateConflict(1, 1, 3)).toBe(2);
    });

    test("previous moves backward", () => {
      expect(navigateConflict(2, -1, 3)).toBe(1);
      expect(navigateConflict(1, -1, 3)).toBe(0);
    });

    test("does not go below 0", () => {
      expect(navigateConflict(0, -1, 3)).toBe(0);
    });

    test("does not exceed conflict count", () => {
      expect(navigateConflict(2, 1, 3)).toBe(2);
    });

    test("handles single conflict", () => {
      expect(navigateConflict(0, 1, 1)).toBe(0);
      expect(navigateConflict(0, -1, 1)).toBe(0);
    });

    test("resolved count tracks progress", () => {
      let result = makeMultiConflictResult();
      const resolvedBefore = result.conflicts.filter((c) => c.resolution != null).length;
      expect(resolvedBefore).toBe(0);

      // Resolve first conflict
      if (result.conflicts.length > 0) {
        result = merger.resolveConflict(result, result.conflicts[0]!.id, "ours");
      }

      const resolvedAfter = result.conflicts.filter((c) => c.resolution != null).length;
      expect(resolvedAfter).toBe(1);
    });
  });

  describe("save produces correct output", () => {
    test("applying 'ours' resolution produces our content", () => {
      let result = makeConflictResult();
      const id = result.conflicts[0]!.id;
      result = merger.resolveConflict(result, id, "ours");

      const final = merger.applyResolutions(result);
      expect(final).toContain("our change");
      expect(final).not.toContain("their change");
      expect(final).not.toContain("<<<<<<<");
    });

    test("applying 'theirs' resolution produces their content", () => {
      let result = makeConflictResult();
      const id = result.conflicts[0]!.id;
      result = merger.resolveConflict(result, id, "theirs");

      const final = merger.applyResolutions(result);
      expect(final).toContain("their change");
      expect(final).not.toContain("our change");
    });

    test("applying 'both' concatenates both sides", () => {
      let result = makeConflictResult();
      const id = result.conflicts[0]!.id;
      result = merger.resolveConflict(result, id, "both");

      const final = merger.applyResolutions(result);
      expect(final).toContain("our change");
      expect(final).toContain("their change");
    });

    test("unresolved conflicts keep markers in output", () => {
      const result = makeConflictResult();
      const final = merger.applyResolutions(result);
      expect(final).toContain("<<<<<<< OURS");
      expect(final).toContain("=======");
      expect(final).toContain(">>>>>>> THEIRS");
    });

    test("mixed resolved and unresolved conflicts", () => {
      let result = makeMultiConflictResult();
      if (result.conflicts.length >= 2) {
        // Resolve first, leave second unresolved
        result = merger.resolveConflict(result, result.conflicts[0]!.id, "ours");

        const final = merger.applyResolutions(result);
        // First conflict resolved
        // Second conflict still has markers
        expect(final).toContain("<<<<<<< OURS");
      }
    });

    test("preserving non-conflicting lines in output", () => {
      let result = makeConflictResult();
      const id = result.conflicts[0]!.id;
      result = merger.resolveConflict(result, id, "ours");

      const final = merger.applyResolutions(result);
      expect(final).toContain("line 1");
      expect(final).toContain("line 3");
    });
  });
});
