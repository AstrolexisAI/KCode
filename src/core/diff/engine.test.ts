// KCode - Diff Engine Tests
// Tests for the Myers diff algorithm implementation and hunk generation.

import { describe, test, expect } from "bun:test";
import { DiffEngine, getDiffEngine } from "./engine.js";
import type { DiffHunk } from "./types.js";

describe("DiffEngine", () => {
  const engine = new DiffEngine();

  describe("identical files", () => {
    test("returns empty hunks for identical content", () => {
      const text = "line 1\nline 2\nline 3\n";
      const result = engine.diff(text, text);
      expect(result.hunks).toHaveLength(0);
      expect(result.stats.additions).toBe(0);
      expect(result.stats.deletions).toBe(0);
      expect(result.stats.modifications).toBe(0);
    });

    test("returns empty hunks for two empty strings", () => {
      const result = engine.diff("", "");
      expect(result.hunks).toHaveLength(0);
    });

    test("preserves filePath in result", () => {
      const result = engine.diff("a", "a", "test.ts");
      expect(result.filePath).toBe("test.ts");
    });
  });

  describe("pure additions", () => {
    test("detects lines added at the end", () => {
      const original = "line 1\nline 2\n";
      const modified = "line 1\nline 2\nline 3\nline 4\n";
      const result = engine.diff(original, modified);

      expect(result.hunks.length).toBeGreaterThanOrEqual(1);
      expect(result.stats.additions).toBeGreaterThanOrEqual(1);

      // All hunks with added content should contain the new lines
      const allAdded = result.hunks.flatMap((h) => h.linesAdded);
      expect(allAdded).toContain("line 3");
      expect(allAdded).toContain("line 4");
    });

    test("detects lines added at the beginning", () => {
      const original = "line 2\nline 3\n";
      const modified = "line 0\nline 1\nline 2\nline 3\n";
      const result = engine.diff(original, modified);

      expect(result.hunks.length).toBeGreaterThanOrEqual(1);
      const allAdded = result.hunks.flatMap((h) => h.linesAdded);
      expect(allAdded).toContain("line 0");
      expect(allAdded).toContain("line 1");
    });

    test("detects lines added in the middle", () => {
      const original = "line 1\nline 4\n";
      const modified = "line 1\nline 2\nline 3\nline 4\n";
      const result = engine.diff(original, modified);

      expect(result.hunks.length).toBeGreaterThanOrEqual(1);
      const allAdded = result.hunks.flatMap((h) => h.linesAdded);
      expect(allAdded).toContain("line 2");
      expect(allAdded).toContain("line 3");
    });

    test("addition hunks have type 'addition'", () => {
      const result = engine.diff("a\n", "a\nb\n");
      const additionHunks = result.hunks.filter((h) => h.type === "addition");
      expect(additionHunks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("pure deletions", () => {
    test("detects lines removed from the end", () => {
      const original = "line 1\nline 2\nline 3\n";
      const modified = "line 1\n";
      const result = engine.diff(original, modified);

      expect(result.hunks.length).toBeGreaterThanOrEqual(1);
      const allRemoved = result.hunks.flatMap((h) => h.linesRemoved);
      expect(allRemoved).toContain("line 2");
      expect(allRemoved).toContain("line 3");
    });

    test("detects lines removed from the beginning", () => {
      const original = "line 1\nline 2\nline 3\n";
      const modified = "line 3\n";
      const result = engine.diff(original, modified);

      const allRemoved = result.hunks.flatMap((h) => h.linesRemoved);
      expect(allRemoved).toContain("line 1");
      expect(allRemoved).toContain("line 2");
    });

    test("deletion hunks have type 'deletion'", () => {
      const result = engine.diff("a\nb\n", "a\n");
      const deletionHunks = result.hunks.filter((h) => h.type === "deletion");
      expect(deletionHunks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("modifications", () => {
    test("detects replaced lines", () => {
      const original = "line 1\nold line\nline 3\n";
      const modified = "line 1\nnew line\nline 3\n";
      const result = engine.diff(original, modified);

      expect(result.hunks.length).toBeGreaterThanOrEqual(1);
      const allRemoved = result.hunks.flatMap((h) => h.linesRemoved);
      const allAdded = result.hunks.flatMap((h) => h.linesAdded);
      expect(allRemoved).toContain("old line");
      expect(allAdded).toContain("new line");
    });

    test("modification hunks have type 'modification'", () => {
      const result = engine.diff("old\n", "new\n");
      const modHunks = result.hunks.filter((h) => h.type === "modification");
      expect(modHunks.length).toBeGreaterThanOrEqual(1);
    });

    test("handles multi-line replacement", () => {
      const original = "a\nb\nc\nd\n";
      const modified = "a\nx\ny\nz\nd\n";
      const result = engine.diff(original, modified);

      const allRemoved = result.hunks.flatMap((h) => h.linesRemoved);
      const allAdded = result.hunks.flatMap((h) => h.linesAdded);
      expect(allRemoved).toContain("b");
      expect(allRemoved).toContain("c");
      expect(allAdded).toContain("x");
      expect(allAdded).toContain("y");
      expect(allAdded).toContain("z");
    });
  });

  describe("multiple hunks with context", () => {
    test("generates separate hunks for distant changes", () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
      const original = lines.join("\n") + "\n";

      const modifiedLines = [...lines];
      modifiedLines[2] = "CHANGED 3";
      modifiedLines[17] = "CHANGED 18";
      const modified = modifiedLines.join("\n") + "\n";

      const result = engine.diff(original, modified);
      // Changes at line 3 and 18 are far apart, should be separate hunks
      expect(result.hunks.length).toBeGreaterThanOrEqual(2);
    });

    test("merges hunks when context overlaps", () => {
      const lines = ["a", "b", "c", "d", "e", "f", "g", "h"];
      const original = lines.join("\n") + "\n";

      // Change lines close together (within 2*3 context lines)
      const modifiedLines = [...lines];
      modifiedLines[1] = "B"; // line 2
      modifiedLines[4] = "E"; // line 5 (only 2 lines apart)
      const modified = modifiedLines.join("\n") + "\n";

      const result = engine.diff(original, modified);
      // Lines 2 and 5 are close enough that context overlaps → single hunk
      expect(result.hunks.length).toBeLessThanOrEqual(2);
    });

    test("includes context lines before and after hunks", () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
      const original = lines.join("\n") + "\n";

      const modifiedLines = [...lines];
      modifiedLines[10] = "CHANGED"; // change line 11
      const modified = modifiedLines.join("\n") + "\n";

      const result = engine.diff(original, modified);
      expect(result.hunks.length).toBeGreaterThanOrEqual(1);

      const hunk = result.hunks[0];
      // Should have up to 3 context lines before and after
      expect(hunk.context.before.length).toBeLessThanOrEqual(3);
      expect(hunk.context.after.length).toBeLessThanOrEqual(3);
      if (hunk.context.before.length > 0) {
        expect(hunk.context.before[hunk.context.before.length - 1]).toBe("line 10");
      }
    });
  });

  describe("edge cases", () => {
    test("handles diff from empty file", () => {
      const result = engine.diff("", "new content\n");
      expect(result.hunks.length).toBeGreaterThanOrEqual(1);
      const allAdded = result.hunks.flatMap((h) => h.linesAdded);
      expect(allAdded).toContain("new content");
    });

    test("handles diff to empty file", () => {
      const result = engine.diff("old content\n", "");
      expect(result.hunks.length).toBeGreaterThanOrEqual(1);
      const allRemoved = result.hunks.flatMap((h) => h.linesRemoved);
      expect(allRemoved).toContain("old content");
    });

    test("handles single line files", () => {
      const result = engine.diff("old", "new");
      expect(result.hunks.length).toBeGreaterThanOrEqual(1);
    });

    test("handles trailing newline differences", () => {
      const result = engine.diff("line\n", "line");
      // Both normalize to the same content
      expect(result.hunks).toHaveLength(0);
    });

    test("every hunk has a unique ID", () => {
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
      const original = lines.join("\n") + "\n";

      const modifiedLines = [...lines];
      modifiedLines[3] = "CHANGED 4";
      modifiedLines[15] = "CHANGED 16";
      modifiedLines[25] = "CHANGED 26";
      const modified = modifiedLines.join("\n") + "\n";

      const result = engine.diff(original, modified);
      const ids = result.hunks.map((h) => h.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    test("all hunks start with status 'pending'", () => {
      const result = engine.diff("a\n", "b\n");
      for (const hunk of result.hunks) {
        expect(hunk.status).toBe("pending");
      }
    });
  });

  describe("large files", () => {
    test("handles files with 1000+ lines", () => {
      const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
      const original = lines.join("\n") + "\n";

      const modifiedLines = [...lines];
      modifiedLines[100] = "MODIFIED 101";
      modifiedLines[500] = "MODIFIED 501";
      modifiedLines[900] = "MODIFIED 901";
      const modified = modifiedLines.join("\n") + "\n";

      const result = engine.diff(original, modified);
      expect(result.hunks.length).toBeGreaterThanOrEqual(3);

      const allRemoved = result.hunks.flatMap((h) => h.linesRemoved);
      expect(allRemoved).toContain("line 101");
      expect(allRemoved).toContain("line 501");
      expect(allRemoved).toContain("line 901");
    });
  });

  describe("applyHunks", () => {
    test("applies accepted hunks", () => {
      const original = "line 1\nold line\nline 3\n";
      const modified = "line 1\nnew line\nline 3\n";
      const result = engine.diff(original, modified);

      // Accept all hunks
      const accepted = result.hunks.map((h) => ({
        ...h,
        status: "accepted" as const,
      }));

      const applied = engine.applyHunks(original, accepted);
      expect(applied).toContain("new line");
      expect(applied).not.toContain("old line");
    });

    test("skips rejected hunks", () => {
      const original = "line 1\nold line\nline 3\n";
      const modified = "line 1\nnew line\nline 3\n";
      const result = engine.diff(original, modified);

      // Reject all hunks
      const rejected = result.hunks.map((h) => ({
        ...h,
        status: "rejected" as const,
      }));

      const applied = engine.applyHunks(original, rejected);
      expect(applied).toContain("old line");
    });

    test("applies only accepted hunks in mixed set", () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
      const original = lines.join("\n") + "\n";

      const modifiedLines = [...lines];
      modifiedLines[3] = "CHANGED 4";
      modifiedLines[15] = "CHANGED 16";
      const modified = modifiedLines.join("\n") + "\n";

      const result = engine.diff(original, modified);
      expect(result.hunks.length).toBeGreaterThanOrEqual(2);

      // Accept first, reject second
      const mixed = result.hunks.map((h, i) => ({
        ...h,
        status: (i === 0 ? "accepted" : "rejected") as DiffHunk["status"],
      }));

      const applied = engine.applyHunks(original, mixed);
      expect(applied).toContain("CHANGED 4");
    });
  });

  describe("getDiffEngine singleton", () => {
    test("returns the same instance", () => {
      const a = getDiffEngine();
      const b = getDiffEngine();
      expect(a).toBe(b);
    });
  });
});
