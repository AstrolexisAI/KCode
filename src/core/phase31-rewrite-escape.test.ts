// Phase 31 — rewrite-after-failed-Edit escape guard
//
// Canonical trigger: NEXUS Telemetry session v2.10.76, mnemo:mark6-31b
// (Gemma 4 31B abliterated). User reported "no se inicia el servicio,
// aparece como caído". Model invented three phantom typos ("setProperty
// en lugar de setProperty" — literally X instead of X), tried an Edit
// with old_string === new_string, kcode blocked the no-op Edit, and
// the model escaped by rewriting the entire 850-line file as 627 lines
// via Write — strictly worse. Phase 31 blocks that escape path.
//
// Covers two layers:
//   1. LoopGuardState bookkeeping (record / get / clear / expire)
//   2. Phase 31 decision logic: Write on a file with a recent failed
//      Edit returns a block reason; unrelated Writes do not.

import { describe, expect, test } from "bun:test";
import { LoopGuardState } from "./agent-loop-guards";

describe("LoopGuardState.recordEditFailure / getRecentEditFailure", () => {
  test("returns null when no failure recorded", () => {
    const g = new LoopGuardState();
    expect(g.getRecentEditFailure("/tmp/foo.ts", 1)).toBeNull();
  });

  test("returns recorded reason when within expiration window", () => {
    const g = new LoopGuardState();
    g.recordEditFailure("/tmp/foo.ts", "PHANTOM_TYPO_BLOCKED", 5);
    expect(g.getRecentEditFailure("/tmp/foo.ts", 6)).toBe("PHANTOM_TYPO_BLOCKED");
    expect(g.getRecentEditFailure("/tmp/foo.ts", 10)).toBe("PHANTOM_TYPO_BLOCKED");
    expect(g.getRecentEditFailure("/tmp/foo.ts", 11)).toBe("PHANTOM_TYPO_BLOCKED");
  });

  test("expires entries older than 6 tool calls", () => {
    const g = new LoopGuardState();
    g.recordEditFailure("/tmp/foo.ts", "old one", 1);
    // 7 calls later → expired (7 - 1 = 6, cutoff is >6)
    expect(g.getRecentEditFailure("/tmp/foo.ts", 8)).toBeNull();
    // And the entry got cleaned up
    expect(g.recentEditFailures.has("/tmp/foo.ts")).toBe(false);
  });

  test("does not confuse different files", () => {
    const g = new LoopGuardState();
    g.recordEditFailure("/tmp/a.ts", "reason A", 1);
    g.recordEditFailure("/tmp/b.ts", "reason B", 2);
    expect(g.getRecentEditFailure("/tmp/a.ts", 3)).toBe("reason A");
    expect(g.getRecentEditFailure("/tmp/b.ts", 3)).toBe("reason B");
    expect(g.getRecentEditFailure("/tmp/c.ts", 3)).toBeNull();
  });

  test("clearEditFailure removes the entry", () => {
    const g = new LoopGuardState();
    g.recordEditFailure("/tmp/foo.ts", "reason", 1);
    g.clearEditFailure("/tmp/foo.ts");
    expect(g.getRecentEditFailure("/tmp/foo.ts", 2)).toBeNull();
  });

  test("clearEditFailure on unknown path is a no-op (no throw)", () => {
    const g = new LoopGuardState();
    expect(() => g.clearEditFailure("/nonexistent")).not.toThrow();
    expect(() => g.clearEditFailure("")).not.toThrow();
  });

  test("recordEditFailure ignores empty filePath", () => {
    const g = new LoopGuardState();
    g.recordEditFailure("", "reason", 1);
    expect(g.recentEditFailures.size).toBe(0);
  });

  test("recordEditFailure overwrites previous failure on same file", () => {
    const g = new LoopGuardState();
    g.recordEditFailure("/tmp/foo.ts", "first", 1);
    g.recordEditFailure("/tmp/foo.ts", "second", 2);
    // Latest failure wins, and the call index is updated so expiration
    // resets relative to the newer record.
    expect(g.getRecentEditFailure("/tmp/foo.ts", 3)).toBe("second");
    expect(g.getRecentEditFailure("/tmp/foo.ts", 8)).toBe("second");
    expect(g.getRecentEditFailure("/tmp/foo.ts", 9)).toBeNull();
  });

  test("map is bounded to 50 entries (oldest evicted)", () => {
    const g = new LoopGuardState();
    for (let i = 0; i < 60; i++) {
      g.recordEditFailure(`/tmp/f${i}.ts`, `r${i}`, i);
    }
    expect(g.recentEditFailures.size).toBeLessThanOrEqual(50);
    // The very first entries should have been evicted
    expect(g.getRecentEditFailure("/tmp/f0.ts", 60)).toBeNull();
    // The most recent ones survive
    expect(g.getRecentEditFailure("/tmp/f59.ts", 60)).toBe("r59");
  });
});

// ─── Integration: the NEXUS Telemetry mark6 canonical sequence ───

describe("Phase 31 — NEXUS Telemetry mark6 canonical sequence", () => {
  test("Edit fails with phantom typo → Write on same file is blocked", () => {
    const g = new LoopGuardState();
    const path = "/home/user/nexus_telemetry.html";

    // Step 1: Edit failed because old_string === new_string (phantom
    // typo). The tool-executor integration records this with the
    // PHANTOM_TYPO_BLOCKED reason verbatim from the Edit tool.
    const editFailureReason =
      "PHANTOM_TYPO_BLOCKED: old_string and new_string are byte-identical. " +
      "This means the 'bug' you think you see in the file does NOT exist...";
    g.recordEditFailure(path, editFailureReason, 3);

    // Step 2: Model tries to escape by Write on the same file.
    // The phase-31 guard in tool-executor.ts checks
    // getRecentEditFailure before executing.
    const blockReason = g.getRecentEditFailure(path, 4);
    expect(blockReason).not.toBeNull();
    expect(blockReason).toContain("PHANTOM_TYPO_BLOCKED");
  });

  test("successful Edit clears the failure — subsequent Write allowed", () => {
    const g = new LoopGuardState();
    const path = "/home/user/nexus_telemetry.html";

    g.recordEditFailure(path, "first phantom", 3);
    expect(g.getRecentEditFailure(path, 4)).not.toBeNull();

    // Model re-reads, identifies the real bug, and does a valid Edit
    // → tool-executor integration calls clearEditFailure.
    g.clearEditFailure(path);

    // Now Write on the same file is allowed.
    expect(g.getRecentEditFailure(path, 5)).toBeNull();
  });

  test("Write on an unrelated file is never blocked by phase 31", () => {
    const g = new LoopGuardState();
    g.recordEditFailure("/home/user/failed.ts", "reason", 1);
    // Write on a completely different path
    expect(g.getRecentEditFailure("/home/user/new-file.ts", 2)).toBeNull();
  });

  test("Edit failure expires after 6 tool calls — model earned its Write", () => {
    const g = new LoopGuardState();
    const path = "/home/user/nexus_telemetry.html";
    g.recordEditFailure(path, "phantom", 1);

    // Within window: still blocked
    expect(g.getRecentEditFailure(path, 5)).not.toBeNull();
    expect(g.getRecentEditFailure(path, 7)).not.toBeNull();

    // Past window: model has done enough work, let them rewrite
    expect(g.getRecentEditFailure(path, 8)).toBeNull();
  });

  test("failed Edit on file A does not block Write on file B", () => {
    const g = new LoopGuardState();
    g.recordEditFailure("/home/user/a.ts", "reason", 1);
    expect(g.getRecentEditFailure("/home/user/b.ts", 2)).toBeNull();
  });
});
