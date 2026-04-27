import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetProfiler,
  getProfileReport,
  isProfilingEnabled,
  printProfileReport,
  profileCheckpoint,
  StartupProfiler,
} from "./startup-profiler";

describe("StartupProfiler", () => {
  let savedProfile: string | undefined;
  let savedStartup: string | undefined;
  let savedNode: string | undefined;

  beforeEach(() => {
    savedProfile = process.env.KCODE_PROFILE;
    savedStartup = process.env.KCODE_PROFILE_STARTUP;
    savedNode = process.env.NODE_ENV;
    _resetProfiler();
  });

  afterEach(() => {
    const restore = (key: string, val: string | undefined) => {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    };
    restore("KCODE_PROFILE", savedProfile);
    restore("KCODE_PROFILE_STARTUP", savedStartup);
    restore("NODE_ENV", savedNode);
    _resetProfiler();
  });

  describe("class API", () => {
    test("records checkpoints when enabled", () => {
      const p = new StartupProfiler(true);
      p.checkpoint("a");
      p.checkpoint("b");
      const r = p.report();
      expect(r.checkpoints).toHaveLength(2);
      expect(r.checkpoints[0]!.name).toBe("a");
      expect(r.checkpoints[1]!.name).toBe("b");
      expect(r.totalMs).toBeGreaterThanOrEqual(0);
      expect(r.categoryTotals).toBeDefined();
    });

    test("no-op when disabled", () => {
      const p = new StartupProfiler(false);
      p.checkpoint("a");
      expect(p.report().checkpoints).toHaveLength(0);
    });

    test("timestamps are monotonically increasing", () => {
      const p = new StartupProfiler(true);
      p.checkpoint("a");
      p.checkpoint("b");
      p.checkpoint("c");
      const cps = p.report().checkpoints;
      expect(cps[1]!.timestamp).toBeGreaterThanOrEqual(cps[0]!.timestamp);
      expect(cps[2]!.timestamp).toBeGreaterThanOrEqual(cps[1]!.timestamp);
    });

    test("tracks memory usage", () => {
      const p = new StartupProfiler(true);
      p.checkpoint("mem-test");
      const cp = p.report().checkpoints[0]!;
      expect(cp.memoryMB).toBeGreaterThan(0);
    });

    test("tracks module count", () => {
      const p = new StartupProfiler(true);
      p.checkpoint("mod-test");
      const cp = p.report().checkpoints[0]!;
      expect(cp.importsLoaded).toBeGreaterThanOrEqual(0);
    });

    test("generates recommendations for slow phases", async () => {
      const p = new StartupProfiler(true);
      p.checkpoint("fast");
      await Bun.sleep(120);
      p.checkpoint("slow-phase");
      const r = p.report();
      expect(r.recommendations.length).toBeGreaterThan(0);
      expect(r.recommendations[0]).toContain("slow-phase");
      expect(r.slowestPhase).toBe("slow-phase");
    });

    test("empty report when no checkpoints", () => {
      const p = new StartupProfiler(true);
      const r = p.report();
      expect(r.checkpoints).toHaveLength(0);
      expect(r.totalMs).toBe(0);
      expect(r.peakMemoryMB).toBe(0);
      expect(r.slowestPhase).toBe("N/A");
      expect(r.categoryTotals).toBeDefined();
      expect(r.categoryTotals.init).toBe(0);
    });

    test("assigns categories to known checkpoint names", () => {
      const p = new StartupProfiler(true);
      p.checkpoint("process_start");
      p.checkpoint("config_loaded");
      p.checkpoint("tools_registered");
      const r = p.report();
      expect(r.checkpoints[0]!.category).toBe("init");
      expect(r.checkpoints[1]!.category).toBe("config");
      expect(r.checkpoints[2]!.category).toBe("tools");
    });

    test("assigns 'other' category to unknown checkpoint names", () => {
      const p = new StartupProfiler(true);
      p.checkpoint("custom_phase");
      expect(p.report().checkpoints[0]!.category).toBe("other");
    });

    test("categoryTotals sums deltas per category", () => {
      const p = new StartupProfiler(true);
      p.checkpoint("process_start");
      p.checkpoint("cli_defined");
      const r = p.report();
      expect(r.categoryTotals.init).toBeGreaterThanOrEqual(0);
    });

    test("report returns copy", () => {
      const p = new StartupProfiler(true);
      p.checkpoint("x");
      const r1 = p.report();
      r1.checkpoints.push({
        name: "fake",
        timestamp: 999,
        deltaMs: 0,
        memoryMB: 0,
        importsLoaded: 0,
        category: "other",
      });
      expect(p.report().checkpoints).toHaveLength(1);
    });

    test("reset clears all", () => {
      const p = new StartupProfiler(true);
      p.checkpoint("a");
      p.checkpoint("b");
      p._reset();
      expect(p.report().checkpoints).toHaveLength(0);
    });

    test("print does not throw with entries", () => {
      const p = new StartupProfiler(true);
      p.checkpoint("a");
      p.checkpoint("b");
      expect(() => p.print()).not.toThrow();
    });

    test("print does not throw without entries", () => {
      const p = new StartupProfiler(true);
      expect(() => p.print()).not.toThrow();
    });
  });

  describe("global convenience functions", () => {
    test("isProfilingEnabled respects KCODE_PROFILE", () => {
      process.env.KCODE_PROFILE = "1";
      delete process.env.KCODE_PROFILE_STARTUP;
      _resetProfiler();
      expect(isProfilingEnabled()).toBe(true);
    });

    test("isProfilingEnabled respects KCODE_PROFILE_STARTUP", () => {
      delete process.env.KCODE_PROFILE;
      process.env.KCODE_PROFILE_STARTUP = "1";
      _resetProfiler();
      expect(isProfilingEnabled()).toBe(true);
    });

    test("disabled when no env vars", () => {
      delete process.env.KCODE_PROFILE;
      delete process.env.KCODE_PROFILE_STARTUP;
      delete process.env.NODE_ENV;
      _resetProfiler();
      expect(isProfilingEnabled()).toBe(false);
    });

    test("profileCheckpoint records when enabled", () => {
      process.env.KCODE_PROFILE = "1";
      _resetProfiler();
      profileCheckpoint("test");
      expect(getProfileReport()).toHaveLength(1);
      expect(getProfileReport()[0]!.name).toBe("test");
    });

    test("profileCheckpoint no-op when disabled", () => {
      delete process.env.KCODE_PROFILE;
      delete process.env.KCODE_PROFILE_STARTUP;
      delete process.env.NODE_ENV;
      _resetProfiler();
      profileCheckpoint("nope");
      expect(getProfileReport()).toHaveLength(0);
    });

    test("printProfileReport does not throw", () => {
      expect(() => printProfileReport()).not.toThrow();
    });
  });
});
