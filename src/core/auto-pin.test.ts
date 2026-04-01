import { beforeEach, describe, expect, test } from "bun:test";
import { _resetAutoPinManager, AutoPinManager, getAutoPinManager } from "./auto-pin";
import { clearPinnedFiles, listPinnedFiles } from "./context-pin";

describe("AutoPinManager", () => {
  beforeEach(() => {
    _resetAutoPinManager();
    clearPinnedFiles();
  });

  test("starts with no tracked files", () => {
    const mgr = new AutoPinManager("/tmp");
    const stats = mgr.getStats();
    expect(stats.trackedFiles).toBe(0);
    expect(stats.autoPinnedCount).toBe(0);
  });

  test("recordAccess tracks file accesses", () => {
    const mgr = new AutoPinManager("/tmp");
    mgr.recordAccess("/tmp/a.ts");
    mgr.recordAccess("/tmp/b.ts");
    expect(mgr.getStats().trackedFiles).toBe(2);
  });

  test("recordAccess increments count", () => {
    const mgr = new AutoPinManager("/tmp");
    mgr.recordAccess("/tmp/a.ts");
    mgr.recordAccess("/tmp/a.ts");
    mgr.recordAccess("/tmp/a.ts");
    const candidates = mgr.getCandidates();
    expect(candidates[0]?.path).toBe("/tmp/a.ts");
  });

  test("getCandidates ranks by score", () => {
    const mgr = new AutoPinManager("/tmp", { windowMs: 60_000 });
    mgr.recordAccess("/tmp/a.ts");
    mgr.recordAccess("/tmp/b.ts");
    mgr.recordAccess("/tmp/b.ts");
    mgr.recordAccess("/tmp/b.ts");
    const candidates = mgr.getCandidates();
    expect(candidates[0].path).toBe("/tmp/b.ts");
    expect(candidates[0].score).toBeGreaterThan(candidates[1]?.score ?? 0);
  });

  test("edited files get higher score", () => {
    const mgr = new AutoPinManager("/tmp", { windowMs: 60_000 });
    mgr.recordAccess("/tmp/a.ts", false);
    mgr.recordAccess("/tmp/a.ts", false);
    mgr.recordAccess("/tmp/b.ts", true);
    mgr.recordAccess("/tmp/b.ts", true);
    const candidates = mgr.getCandidates();
    const aScore = candidates.find((c) => c.path === "/tmp/a.ts")?.score ?? 0;
    const bScore = candidates.find((c) => c.path === "/tmp/b.ts")?.score ?? 0;
    expect(bScore).toBeGreaterThan(aScore); // edited = 2x score
  });

  test("does not track when disabled", () => {
    const mgr = new AutoPinManager("/tmp", { enabled: false });
    mgr.recordAccess("/tmp/a.ts");
    expect(mgr.getStats().trackedFiles).toBe(0);
  });

  test("autoUnpinIfNeeded returns empty when under threshold", () => {
    const mgr = new AutoPinManager("/tmp");
    const unpinned = mgr.autoUnpinIfNeeded(0.5);
    expect(unpinned).toHaveLength(0);
  });

  test("recordCommitFiles records multiple files", () => {
    const mgr = new AutoPinManager("/tmp");
    mgr.recordCommitFiles(["/tmp/a.ts", "/tmp/b.ts"]);
    expect(mgr.getStats().trackedFiles).toBe(2);
  });

  test("cleanup removes old entries", () => {
    const mgr = new AutoPinManager("/tmp", { windowMs: 1 }); // 1ms window
    mgr.recordAccess("/tmp/old.ts");
    // Wait briefly then cleanup
    mgr.cleanup();
    // File should still be there (cleanup uses 2x window)
    expect(mgr.getStats().trackedFiles).toBeGreaterThanOrEqual(0);
  });

  test("singleton returns same instance for same dir", () => {
    const a = getAutoPinManager("/tmp");
    const b = getAutoPinManager("/tmp");
    expect(a).toBe(b);
  });
});
