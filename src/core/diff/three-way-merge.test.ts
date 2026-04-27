// KCode - Three-Way Merge Tests
// Tests for the three-way merge engine including auto-resolution and conflict handling.

import { describe, expect, test } from "bun:test";
import { getThreeWayMerge, rangesOverlap, ThreeWayMerge } from "./three-way-merge.js";

describe("ThreeWayMerge", () => {
  const merger = new ThreeWayMerge();

  describe("no conflicts", () => {
    test("merges non-overlapping changes from both sides", () => {
      const base =
        "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\n";
      const ours =
        "line 1\nOUR CHANGE\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\n";
      const theirs =
        "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nTHEIR CHANGE\nline 10\n";

      const result = merger.merge(base, ours, theirs);
      expect(result.conflicts).toHaveLength(0);
      expect(result.autoResolved).toBe(2);
      expect(result.content).toContain("OUR CHANGE");
      expect(result.content).toContain("THEIR CHANGE");
    });

    test("handles additions on different sides", () => {
      const base = "a\nb\nc\nd\ne\nf\ng\nh\n";
      const ours = "a\nb\nours-new\nc\nd\ne\nf\ng\nh\n";
      const theirs = "a\nb\nc\nd\ne\nf\ng\ntheirs-new\nh\n";

      const result = merger.merge(base, ours, theirs);
      expect(result.conflicts).toHaveLength(0);
      expect(result.content).toContain("ours-new");
      expect(result.content).toContain("theirs-new");
    });

    test("handles identical changes on both sides", () => {
      const base = "line 1\nline 2\nline 3\n";
      const ours = "line 1\nSAME CHANGE\nline 3\n";
      const theirs = "line 1\nSAME CHANGE\nline 3\n";

      const result = merger.merge(base, ours, theirs);
      // Identical changes should auto-resolve without conflict
      expect(result.conflicts).toHaveLength(0);
      expect(result.content).toContain("SAME CHANGE");
    });

    test("handles no changes on either side", () => {
      const base = "unchanged\n";
      const result = merger.merge(base, base, base);
      expect(result.conflicts).toHaveLength(0);
      expect(result.autoResolved).toBe(0);
      expect(result.content).toContain("unchanged");
    });
  });

  describe("overlapping changes generate conflicts", () => {
    test("creates conflict when both sides modify the same line", () => {
      const base = "line 1\nshared line\nline 3\n";
      const ours = "line 1\nour version\nline 3\n";
      const theirs = "line 1\ntheir version\nline 3\n";

      const result = merger.merge(base, ours, theirs);
      expect(result.conflicts.length).toBeGreaterThanOrEqual(1);

      const conflict = result.conflicts[0]!;
      expect(conflict.ours).toContain("our version");
      expect(conflict.theirs).toContain("their version");
    });

    test("conflict has a unique ID", () => {
      const base = "x\n";
      const ours = "a\n";
      const theirs = "b\n";

      const result = merger.merge(base, ours, theirs);
      expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
      expect(result.conflicts[0]!.id).toBeTruthy();
      expect(typeof result.conflicts[0]!.id).toBe("string");
    });

    test("conflict includes base content", () => {
      const base = "original\n";
      const ours = "ours\n";
      const theirs = "theirs\n";

      const result = merger.merge(base, ours, theirs);
      expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
      expect(result.conflicts[0]!.base).toContain("original");
    });

    test("conflict markers appear in content", () => {
      const base = "x\n";
      const ours = "a\n";
      const theirs = "b\n";

      const result = merger.merge(base, ours, theirs);
      expect(result.content).toContain("<<<<<<< OURS");
      expect(result.content).toContain("=======");
      expect(result.content).toContain(">>>>>>> THEIRS");
    });
  });

  describe("conflict resolution", () => {
    test("resolveConflict updates the resolution field", () => {
      const base = "x\n";
      const ours = "a\n";
      const theirs = "b\n";

      let result = merger.merge(base, ours, theirs);
      expect(result.conflicts.length).toBeGreaterThanOrEqual(1);

      const conflictId = result.conflicts[0]!.id;
      result = merger.resolveConflict(result, conflictId, "ours");
      expect(result.conflicts[0]!.resolution).toBe("ours");
    });

    test("resolveConflict with 'theirs' sets resolution", () => {
      const base = "x\n";
      let result = merger.merge(base, "a\n", "b\n");
      const id = result.conflicts[0]!.id;
      result = merger.resolveConflict(result, id, "theirs");
      expect(result.conflicts[0]!.resolution).toBe("theirs");
    });

    test("resolveConflict with 'both' sets resolution", () => {
      const base = "x\n";
      let result = merger.merge(base, "a\n", "b\n");
      const id = result.conflicts[0]!.id;
      result = merger.resolveConflict(result, id, "both");
      expect(result.conflicts[0]!.resolution).toBe("both");
    });

    test("resolveConflict with 'custom' stores custom content", () => {
      const base = "x\n";
      let result = merger.merge(base, "a\n", "b\n");
      const id = result.conflicts[0]!.id;
      result = merger.resolveConflict(result, id, "custom", "my custom resolution");
      expect(result.conflicts[0]!.resolution).toBe("custom");
      expect(result.conflicts[0]!.customContent).toBe("my custom resolution");
    });
  });

  describe("applyResolutions", () => {
    test("replaces conflict markers with 'ours' content", () => {
      const base = "x\n";
      let result = merger.merge(base, "our line\n", "their line\n");
      const id = result.conflicts[0]!.id;
      result = merger.resolveConflict(result, id, "ours");

      const final = merger.applyResolutions(result);
      expect(final).toContain("our line");
      expect(final).not.toContain("their line");
      expect(final).not.toContain("<<<<<<<");
    });

    test("replaces conflict markers with 'theirs' content", () => {
      const base = "x\n";
      let result = merger.merge(base, "our line\n", "their line\n");
      const id = result.conflicts[0]!.id;
      result = merger.resolveConflict(result, id, "theirs");

      const final = merger.applyResolutions(result);
      expect(final).toContain("their line");
      expect(final).not.toContain("our line");
    });

    test("replaces conflict markers with both combined for 'both'", () => {
      const base = "x\n";
      let result = merger.merge(base, "our line\n", "their line\n");
      const id = result.conflicts[0]!.id;
      result = merger.resolveConflict(result, id, "both");

      const final = merger.applyResolutions(result);
      expect(final).toContain("our line");
      expect(final).toContain("their line");
    });

    test("replaces conflict markers with custom content", () => {
      const base = "x\n";
      let result = merger.merge(base, "a\n", "b\n");
      const id = result.conflicts[0]!.id;
      result = merger.resolveConflict(result, id, "custom", "completely custom");

      const final = merger.applyResolutions(result);
      expect(final).toContain("completely custom");
    });

    test("leaves unresolved conflicts as markers", () => {
      const base = "x\n";
      const result = merger.merge(base, "a\n", "b\n");
      // Do not resolve
      const final = merger.applyResolutions(result);
      expect(final).toContain("<<<<<<< OURS");
    });
  });

  describe("complex scenarios", () => {
    test("handles multiple conflicts and auto-resolves together", () => {
      const base =
        [
          "header",
          "line 1",
          "line 2",
          "line 3",
          "line 4",
          "line 5",
          "line 6",
          "line 7",
          "line 8",
          "line 9",
          "line 10",
          "footer",
        ].join("\n") + "\n";

      // Ours changes line 2 and line 10
      const ours = base.replace("line 2", "OUR LINE 2").replace("line 10", "OUR LINE 10");
      // Theirs changes line 2 (conflict!) and line 6 (auto-resolve)
      const theirs = base.replace("line 2", "THEIR LINE 2").replace("line 6", "THEIR LINE 6");

      const result = merger.merge(base, ours, theirs);

      // Should have at least 1 conflict (line 2)
      expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
      // Should have auto-resolved changes (line 6 from theirs, line 10 from ours)
      expect(result.autoResolved).toBeGreaterThanOrEqual(1);
    });

    test("handles additions at the same position as conflict", () => {
      const base = "a\nb\n";
      const ours = "a\nX\nb\n";
      const theirs = "a\nY\nb\n";

      const result = merger.merge(base, ours, theirs);
      // Both insert between a and b: this is a conflict
      expect(result.conflicts.length + result.autoResolved).toBeGreaterThanOrEqual(1);
    });
  });

  describe("rangesOverlap", () => {
    test("overlapping ranges", () => {
      expect(rangesOverlap([0, 5], [3, 8])).toBe(true);
      expect(rangesOverlap([3, 8], [0, 5])).toBe(true);
    });

    test("non-overlapping ranges", () => {
      expect(rangesOverlap([0, 3], [5, 8])).toBe(false);
      expect(rangesOverlap([5, 8], [0, 3])).toBe(false);
    });

    test("adjacent ranges do not overlap", () => {
      expect(rangesOverlap([0, 3], [3, 6])).toBe(false);
    });

    test("contained ranges overlap", () => {
      expect(rangesOverlap([0, 10], [3, 5])).toBe(true);
      expect(rangesOverlap([3, 5], [0, 10])).toBe(true);
    });

    test("zero-length ranges at same point overlap", () => {
      expect(rangesOverlap([3, 3], [3, 3])).toBe(true);
    });

    test("zero-length range inside another", () => {
      expect(rangesOverlap([3, 3], [0, 5])).toBe(true);
    });

    test("zero-length range outside another", () => {
      expect(rangesOverlap([3, 3], [5, 8])).toBe(false);
    });
  });

  describe("getThreeWayMerge singleton", () => {
    test("returns the same instance", () => {
      const a = getThreeWayMerge();
      const b = getThreeWayMerge();
      expect(a).toBe(b);
    });
  });
});
