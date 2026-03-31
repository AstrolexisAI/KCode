import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  profileCheckpoint,
  getProfileReport,
  printProfileReport,
  isProfilingEnabled,
  _resetProfiler,
} from "./startup-profiler";

describe("startup-profiler", () => {
  let savedProfileEnv: string | undefined;
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedProfileEnv = process.env.KCODE_PROFILE_STARTUP;
    savedNodeEnv = process.env.NODE_ENV;
    _resetProfiler();
  });

  afterEach(() => {
    if (savedProfileEnv === undefined) {
      delete process.env.KCODE_PROFILE_STARTUP;
    } else {
      process.env.KCODE_PROFILE_STARTUP = savedProfileEnv;
    }
    if (savedNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = savedNodeEnv;
    }
    _resetProfiler();
  });

  describe("isProfilingEnabled", () => {
    test("enabled when KCODE_PROFILE_STARTUP=1", () => {
      process.env.KCODE_PROFILE_STARTUP = "1";
      delete process.env.NODE_ENV;
      expect(isProfilingEnabled()).toBe(true);
    });

    test("enabled when NODE_ENV=development", () => {
      delete process.env.KCODE_PROFILE_STARTUP;
      process.env.NODE_ENV = "development";
      expect(isProfilingEnabled()).toBe(true);
    });

    test("disabled when neither env var is set", () => {
      delete process.env.KCODE_PROFILE_STARTUP;
      delete process.env.NODE_ENV;
      expect(isProfilingEnabled()).toBe(false);
    });
  });

  describe("profileCheckpoint", () => {
    test("records entries when profiling is enabled", () => {
      process.env.KCODE_PROFILE_STARTUP = "1";
      profileCheckpoint("test_start");
      profileCheckpoint("test_end");
      const report = getProfileReport();
      expect(report).toHaveLength(2);
      expect(report[0].name).toBe("test_start");
      expect(report[1].name).toBe("test_end");
    });

    test("does not record when profiling is disabled", () => {
      delete process.env.KCODE_PROFILE_STARTUP;
      delete process.env.NODE_ENV;
      profileCheckpoint("should_not_appear");
      const report = getProfileReport();
      expect(report).toHaveLength(0);
    });

    test("timestamps are monotonically increasing", () => {
      process.env.KCODE_PROFILE_STARTUP = "1";
      profileCheckpoint("a");
      profileCheckpoint("b");
      profileCheckpoint("c");
      const report = getProfileReport();
      expect(report[1].timestamp).toBeGreaterThanOrEqual(report[0].timestamp);
      expect(report[2].timestamp).toBeGreaterThanOrEqual(report[1].timestamp);
    });

    test("delta is difference from previous checkpoint", () => {
      process.env.KCODE_PROFILE_STARTUP = "1";
      profileCheckpoint("first");
      const report1 = getProfileReport();
      // First entry delta equals its own timestamp (since prev is 0)
      expect(report1[0].delta).toBe(report1[0].timestamp);
    });
  });

  describe("getProfileReport", () => {
    test("returns a copy (not the internal array)", () => {
      process.env.KCODE_PROFILE_STARTUP = "1";
      profileCheckpoint("x");
      const report = getProfileReport();
      report.push({ name: "fake", timestamp: 999, delta: 0 });
      expect(getProfileReport()).toHaveLength(1); // original unaffected
    });

    test("returns empty array when no checkpoints", () => {
      expect(getProfileReport()).toEqual([]);
    });
  });

  describe("printProfileReport", () => {
    test("does not throw with no entries", () => {
      expect(() => printProfileReport()).not.toThrow();
    });

    test("does not throw with entries", () => {
      process.env.KCODE_PROFILE_STARTUP = "1";
      profileCheckpoint("cli_parsed");
      profileCheckpoint("config_loaded");
      expect(() => printProfileReport()).not.toThrow();
    });
  });

  describe("_resetProfiler", () => {
    test("clears all entries", () => {
      process.env.KCODE_PROFILE_STARTUP = "1";
      profileCheckpoint("a");
      profileCheckpoint("b");
      expect(getProfileReport()).toHaveLength(2);
      _resetProfiler();
      expect(getProfileReport()).toHaveLength(0);
    });
  });
});
