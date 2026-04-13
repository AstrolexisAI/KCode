// Tests for bash-spawn-history (phase 3 of operator-mind).

import { beforeEach, describe, expect, test } from "bun:test";
import {
  acknowledgeRetryWarning,
  clearBashHistory,
  detectImmediateRetry,
  recordBashAttempt,
  snapshotBashHistory,
} from "./bash-spawn-history";

describe("bash-spawn-history", () => {
  beforeEach(() => clearBashHistory());

  test("returns null for non-server commands (out of scope)", () => {
    // Phase 3 only fires for server spawns. Even after a failure of
    // a non-server command, no warning is issued.
    recordBashAttempt("ls /missing", "/tmp", true, "ls: cannot access");
    expect(detectImmediateRetry("ls /missing", "/tmp")).toBeNull();
    expect(detectImmediateRetry("git status", "/tmp")).toBeNull();
    expect(detectImmediateRetry("sudo echo first", "/tmp")).toBeNull();
  });

  test("returns null when no history exists for a server command", () => {
    expect(detectImmediateRetry("npm run dev", "/tmp")).toBeNull();
  });

  test("returns null when the previous server attempt succeeded", () => {
    recordBashAttempt("npm run dev", "/tmp", false, "Ready");
    expect(detectImmediateRetry("npm run dev", "/tmp")).toBeNull();
  });

  test("detects immediate retry after failure in same cwd", () => {
    recordBashAttempt("npm run dev", "/home/curly/site", true, "ENOENT package.json");
    const w = detectImmediateRetry("npm run dev", "/home/curly/site");
    expect(w).not.toBeNull();
    expect(w!.attemptsAgo).toBe(1);
    expect(w!.report).toContain("STOP");
    expect(w!.report).toContain("npm run dev");
    expect(w!.report).toContain("ENOENT package.json");
  });

  test("does NOT trigger when cwd differs", () => {
    recordBashAttempt("npm run dev", "/dir-a", true, "boom");
    expect(detectImmediateRetry("npm run dev", "/dir-b")).toBeNull();
  });

  test("does NOT trigger for a different server command", () => {
    recordBashAttempt("npm run dev", "/x", true, "boom");
    // vite is also a server spawn, but a different one — no retry warning
    expect(detectImmediateRetry("vite", "/x")).toBeNull();
  });

  test("treats whitespace differences as same command", () => {
    recordBashAttempt("npm  run   dev", "/x", true, "boom");
    expect(detectImmediateRetry("npm run dev", "/x")).not.toBeNull();
  });

  test("treats PORT changes as same intent (retry detection still fires)", () => {
    recordBashAttempt("PORT=3000 npm run dev", "/x", true, "EADDRINUSE :3000");
    const w = detectImmediateRetry("PORT=3001 npm run dev", "/x");
    expect(w).not.toBeNull();
    expect(w!.report).toContain("STOP");
  });

  test("treats --port changes as same intent", () => {
    recordBashAttempt("next dev --port 3000", "/x", true, "EADDRINUSE");
    expect(detectImmediateRetry("next dev --port 3001", "/x")).not.toBeNull();
  });

  test("ignores failures older than the retry window", () => {
    recordBashAttempt("npm run dev", "/x", true, "boom");
    // Push 9 unrelated server attempts (window = 8)
    for (let i = 0; i < 9; i++) recordBashAttempt(`vite --port ${5000 + i}`, "/x", false, "");
    expect(detectImmediateRetry("npm run dev", "/x")).toBeNull();
  });

  test("history is bounded to MAX_HISTORY entries", () => {
    // Use a non-server pattern so we exercise raw history bounding without
    // tripping retry detection on intermediate entries.
    for (let i = 0; i < 200; i++) recordBashAttempt(`echo ${i}`, "/x", false, "");
    const snap = snapshotBashHistory();
    expect(snap.length).toBeLessThanOrEqual(64);
  });

  test("acknowledgeRetryWarning lets the next call through", () => {
    recordBashAttempt("npm run dev", "/x", true, "fail");
    expect(detectImmediateRetry("npm run dev", "/x")).not.toBeNull();
    acknowledgeRetryWarning("npm run dev", "/x");
    // Next call should NOT see the warning
    expect(detectImmediateRetry("npm run dev", "/x")).toBeNull();
  });

  test("warning report includes diagnostic instructions", () => {
    recordBashAttempt("vite", "/site", true, "Watchpack EMFILE");
    const w = detectImmediateRetry("vite", "/site")!;
    expect(w.report).toMatch(/diagnose/i);
    expect(w.report).toMatch(/different/i);
    expect(w.report).toMatch(/read more state/i);
  });

  test("warning report explains it's not a real failure", () => {
    recordBashAttempt("npm run dev", "/x", true, "boom");
    const w = detectImmediateRetry("npm run dev", "/x")!;
    expect(w.report).toContain("NOT a real failure");
  });
});
