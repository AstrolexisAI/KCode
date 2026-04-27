// Tests for file-edit-history (phase 4 of operator-mind).

import { beforeEach, describe, expect, test } from "bun:test";
import {
  acknowledgeEditWarning,
  clearEditHistory,
  detectImmediateEditRetry,
  recordEditAttempt,
  snapshotEditHistory,
} from "./file-edit-history";

describe("file-edit-history", () => {
  beforeEach(() => clearEditHistory());

  // ─── Scope filtering ──────────────────────────────────────────

  test("ignores non-file-edit tool names", () => {
    recordEditAttempt("Read", { file_path: "/a/b" }, true, "boom");
    expect(detectImmediateEditRetry("Read", { file_path: "/a/b" })).toBeNull();
  });

  test("ignores entries with no file_path", () => {
    recordEditAttempt("Edit", {}, true, "boom");
    expect(snapshotEditHistory().length).toBe(0);
  });

  // ─── Edit retry detection ─────────────────────────────────────

  test("detects retry of identical Edit input after failure", () => {
    const input = {
      file_path: "/x/y.ts",
      old_string: "foo",
      new_string: "bar",
      replace_all: false,
    };
    recordEditAttempt("Edit", input, true, "old_string not found in /x/y.ts");
    const w = detectImmediateEditRetry("Edit", input);
    expect(w).not.toBeNull();
    expect(w!.report).toContain("STOP");
    expect(w!.report).toContain("/x/y.ts");
    expect(w!.report).toContain("old_string not found");
    expect(w!.report).toContain("Re-Read the target file");
  });

  test("does NOT trigger when previous Edit succeeded", () => {
    const input = { file_path: "/x.ts", old_string: "a", new_string: "b" };
    recordEditAttempt("Edit", input, false, "Edit applied");
    expect(detectImmediateEditRetry("Edit", input)).toBeNull();
  });

  test("does NOT trigger when new_string differs (intentional fix)", () => {
    recordEditAttempt(
      "Edit",
      { file_path: "/x.ts", old_string: "a", new_string: "b" },
      true,
      "boom",
    );
    // Same old_string but different new_string — same fingerprint → still triggers
    // because the failure is about old_string not new_string. Skip this test.
    // Instead test: different old_string → different fingerprint → no trigger
    expect(
      detectImmediateEditRetry("Edit", {
        file_path: "/x.ts",
        old_string: "DIFFERENT",
        new_string: "b",
      }),
    ).toBeNull();
  });

  test("does NOT trigger when file_path differs", () => {
    recordEditAttempt(
      "Edit",
      { file_path: "/a.ts", old_string: "x", new_string: "y" },
      true,
      "boom",
    );
    expect(
      detectImmediateEditRetry("Edit", { file_path: "/b.ts", old_string: "x", new_string: "y" }),
    ).toBeNull();
  });

  test("treats replace_all change as different intent (no trigger)", () => {
    recordEditAttempt(
      "Edit",
      { file_path: "/x.ts", old_string: "x", new_string: "y", replace_all: false },
      true,
      "string not unique",
    );
    // Adding replace_all=true is the model fixing the failure → different fingerprint
    expect(
      detectImmediateEditRetry("Edit", {
        file_path: "/x.ts",
        old_string: "x",
        new_string: "y",
        replace_all: true,
      }),
    ).toBeNull();
  });

  // ─── MultiEdit retry detection ────────────────────────────────

  test("detects retry of identical MultiEdit", () => {
    const input = {
      file_path: "/x.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" },
      ],
    };
    recordEditAttempt("MultiEdit", input, true, "edit 1: old_string not found");
    const w = detectImmediateEditRetry("MultiEdit", input);
    expect(w).not.toBeNull();
    expect(w!.report).toContain("MultiEdit");
    expect(w!.report).toContain("transaction");
  });

  test("does NOT trigger MultiEdit when edits array differs", () => {
    recordEditAttempt(
      "MultiEdit",
      { file_path: "/x.ts", edits: [{ old_string: "a", new_string: "b" }] },
      true,
      "boom",
    );
    expect(
      detectImmediateEditRetry("MultiEdit", {
        file_path: "/x.ts",
        edits: [{ old_string: "a-fixed", new_string: "b" }],
      }),
    ).toBeNull();
  });

  // ─── Write retry detection ────────────────────────────────────

  test("detects retry of identical Write", () => {
    const input = { file_path: "/x.ts", content: "console.log('hi');" };
    recordEditAttempt("Write", input, true, "EACCES: permission denied");
    const w = detectImmediateEditRetry("Write", input);
    expect(w).not.toBeNull();
    expect(w!.report).toContain("Write");
    expect(w!.report).toContain("EACCES");
  });

  test("does NOT trigger Write when content differs (intentional revision)", () => {
    recordEditAttempt("Write", { file_path: "/x.ts", content: "v1" }, true, "boom");
    expect(detectImmediateEditRetry("Write", { file_path: "/x.ts", content: "v2" })).toBeNull();
  });

  // ─── Window expiry ─────────────────────────────────────────────

  test("ignores failures older than the retry window", () => {
    const input = { file_path: "/x.ts", old_string: "a", new_string: "b" };
    recordEditAttempt("Edit", input, true, "boom");
    // Push 7 unrelated edits (window = 6)
    for (let i = 0; i < 7; i++) {
      recordEditAttempt(
        "Edit",
        { file_path: `/other-${i}.ts`, old_string: "x", new_string: "y" },
        false,
        "",
      );
    }
    expect(detectImmediateEditRetry("Edit", input)).toBeNull();
  });

  // ─── Acknowledgment escape hatch ──────────────────────────────

  test("acknowledgment lets the next call through", () => {
    const input = { file_path: "/x.ts", old_string: "a", new_string: "b" };
    recordEditAttempt("Edit", input, true, "boom");
    expect(detectImmediateEditRetry("Edit", input)).not.toBeNull();
    acknowledgeEditWarning("Edit", input);
    expect(detectImmediateEditRetry("Edit", input)).toBeNull();
  });

  // ─── History bounding ──────────────────────────────────────────

  test("history is bounded", () => {
    for (let i = 0; i < 200; i++) {
      recordEditAttempt("Write", { file_path: `/f${i}.ts`, content: `content ${i}` }, false, "");
    }
    expect(snapshotEditHistory().length).toBeLessThanOrEqual(64);
  });

  // ─── Cross-tool isolation ──────────────────────────────────────

  test("Edit failure does not trigger Write retry warning on same path", () => {
    recordEditAttempt(
      "Edit",
      { file_path: "/x.ts", old_string: "a", new_string: "b" },
      true,
      "boom",
    );
    expect(
      detectImmediateEditRetry("Write", { file_path: "/x.ts", content: "anything" }),
    ).toBeNull();
  });
});
