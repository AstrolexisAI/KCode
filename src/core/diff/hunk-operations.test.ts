// KCode - Hunk Operations Tests
// Tests for accept, reject, modify, split, merge, and stats operations on diff hunks.

import { describe, expect, test } from "bun:test";
import {
  acceptAll,
  acceptHunk,
  getStats,
  mergeHunks,
  modifyHunk,
  rejectAll,
  rejectHunk,
  splitHunk,
} from "./hunk-operations.js";
import type { DiffHunk } from "./types.js";

function makeHunk(overrides: Partial<DiffHunk> = {}): DiffHunk {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    startLineOld: 1,
    endLineOld: 3,
    startLineNew: 1,
    endLineNew: 3,
    linesRemoved: ["old line 1", "old line 2"],
    linesAdded: ["new line 1", "new line 2"],
    context: { before: ["ctx before"], after: ["ctx after"] },
    status: "pending",
    type: "modification",
    ...overrides,
  };
}

describe("acceptHunk", () => {
  test("marks the specified hunk as accepted", () => {
    const h = makeHunk({ id: "h1" });
    const result = acceptHunk([h], "h1");
    expect(result[0]!.status).toBe("accepted");
  });

  test("does not modify other hunks", () => {
    const h1 = makeHunk({ id: "h1" });
    const h2 = makeHunk({ id: "h2" });
    const result = acceptHunk([h1, h2], "h1");
    expect(result[0]!.status).toBe("accepted");
    expect(result[1]!.status).toBe("pending");
  });

  test("returns a new array (immutable)", () => {
    const hunks = [makeHunk({ id: "h1" })];
    const result = acceptHunk(hunks, "h1");
    expect(result).not.toBe(hunks);
    expect(hunks[0]!.status).toBe("pending");
  });
});

describe("rejectHunk", () => {
  test("marks the specified hunk as rejected", () => {
    const h = makeHunk({ id: "r1" });
    const result = rejectHunk([h], "r1");
    expect(result[0]!.status).toBe("rejected");
  });

  test("does not affect other hunks", () => {
    const h1 = makeHunk({ id: "r1" });
    const h2 = makeHunk({ id: "r2" });
    const result = rejectHunk([h1, h2], "r1");
    expect(result[1]!.status).toBe("pending");
  });
});

describe("modifyHunk", () => {
  test("replaces added lines and sets status to modified", () => {
    const h = makeHunk({ id: "m1" });
    const result = modifyHunk([h], "m1", ["custom line"]);
    expect(result[0]!.linesAdded).toEqual(["custom line"]);
    expect(result[0]!.status).toBe("modified");
  });

  test("preserves removed lines", () => {
    const h = makeHunk({ id: "m1", linesRemoved: ["kept"] });
    const result = modifyHunk([h], "m1", ["replaced"]);
    expect(result[0]!.linesRemoved).toEqual(["kept"]);
  });
});

describe("acceptAll", () => {
  test("marks all hunks as accepted", () => {
    const hunks = [makeHunk({ id: "a1" }), makeHunk({ id: "a2" }), makeHunk({ id: "a3" })];
    const result = acceptAll(hunks);
    expect(result.every((h) => h.status === "accepted")).toBe(true);
  });

  test("returns new array", () => {
    const hunks = [makeHunk()];
    const result = acceptAll(hunks);
    expect(result).not.toBe(hunks);
  });
});

describe("rejectAll", () => {
  test("marks all hunks as rejected", () => {
    const hunks = [makeHunk({ id: "r1" }), makeHunk({ id: "r2" })];
    const result = rejectAll(hunks);
    expect(result.every((h) => h.status === "rejected")).toBe(true);
  });
});

describe("getStats", () => {
  test("counts each status category", () => {
    const hunks: DiffHunk[] = [
      makeHunk({ id: "1", status: "accepted" }),
      makeHunk({ id: "2", status: "rejected" }),
      makeHunk({ id: "3", status: "pending" }),
      makeHunk({ id: "4", status: "modified" }),
      makeHunk({ id: "5", status: "accepted" }),
    ];
    const stats = getStats(hunks);
    expect(stats.accepted).toBe(2);
    expect(stats.rejected).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.modified).toBe(1);
  });

  test("returns all zeros for empty array", () => {
    const stats = getStats([]);
    expect(stats).toEqual({ accepted: 0, rejected: 0, pending: 0, modified: 0 });
  });
});

describe("splitHunk", () => {
  test("splits a hunk into two at the specified line", () => {
    const h = makeHunk({
      id: "s1",
      linesRemoved: ["r1", "r2", "r3", "r4"],
      linesAdded: ["a1", "a2", "a3", "a4"],
    });
    const result = splitHunk([h], "s1", 2);
    expect(result).toHaveLength(2);
    expect(result[0]!.linesRemoved).toEqual(["r1", "r2"]);
    expect(result[0]!.linesAdded).toEqual(["a1", "a2"]);
    expect(result[1]!.linesRemoved).toEqual(["r3", "r4"]);
    expect(result[1]!.linesAdded).toEqual(["a3", "a4"]);
  });

  test("assigns new unique IDs to split hunks", () => {
    const h = makeHunk({ id: "s2", linesRemoved: ["a", "b"], linesAdded: ["c", "d"] });
    const result = splitHunk([h], "s2", 1);
    expect(result[0]!.id).not.toBe("s2");
    expect(result[1]!.id).not.toBe("s2");
    expect(result[0]!.id).not.toBe(result[1]!.id);
  });

  test("returns original array if split position is invalid", () => {
    const h = makeHunk({ id: "s3", linesAdded: ["a", "b"] });
    expect(splitHunk([h], "s3", 0)).toHaveLength(1);
    expect(splitHunk([h], "s3", 5)).toHaveLength(1);
  });

  test("returns original array if hunk ID not found", () => {
    const h = makeHunk({ id: "s4" });
    const result = splitHunk([h], "nonexistent", 1);
    expect(result).toHaveLength(1);
  });
});

describe("mergeHunks", () => {
  test("merges adjacent hunks into one", () => {
    const h1 = makeHunk({ id: "m1", linesRemoved: ["r1"], linesAdded: ["a1"] });
    const h2 = makeHunk({ id: "m2", linesRemoved: ["r2"], linesAdded: ["a2"] });
    const result = mergeHunks([h1, h2], ["m1", "m2"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.linesRemoved).toEqual(["r1", "r2"]);
    expect(result[0]!.linesAdded).toEqual(["a1", "a2"]);
  });

  test("merged hunk gets a new ID", () => {
    const h1 = makeHunk({ id: "m1" });
    const h2 = makeHunk({ id: "m2" });
    const result = mergeHunks([h1, h2], ["m1", "m2"]);
    expect(result[0]!.id).not.toBe("m1");
    expect(result[0]!.id).not.toBe("m2");
  });

  test("merged hunk status is pending", () => {
    const h1 = makeHunk({ id: "m1", status: "accepted" });
    const h2 = makeHunk({ id: "m2", status: "accepted" });
    const result = mergeHunks([h1, h2], ["m1", "m2"]);
    expect(result[0]!.status).toBe("pending");
  });

  test("preserves context from first and last hunks", () => {
    const h1 = makeHunk({
      id: "m1",
      context: { before: ["before1"], after: ["after1"] },
    });
    const h2 = makeHunk({
      id: "m2",
      context: { before: ["before2"], after: ["after2"] },
    });
    const result = mergeHunks([h1, h2], ["m1", "m2"]);
    expect(result[0]!.context.before).toEqual(["before1"]);
    expect(result[0]!.context.after).toEqual(["after2"]);
  });

  test("does not merge non-adjacent hunks", () => {
    const h1 = makeHunk({ id: "m1" });
    const h2 = makeHunk({ id: "m2" });
    const h3 = makeHunk({ id: "m3" });
    // h1 and h3 are not adjacent (h2 is between them)
    const result = mergeHunks([h1, h2, h3], ["m1", "m3"]);
    expect(result).toHaveLength(3); // no merge happened
  });

  test("returns original for fewer than 2 IDs", () => {
    const h1 = makeHunk({ id: "m1" });
    expect(mergeHunks([h1], ["m1"])).toHaveLength(1);
    expect(mergeHunks([h1], [])).toHaveLength(1);
  });
});
