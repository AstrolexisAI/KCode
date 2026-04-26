// Tests for the runtime feature-flags system.
// Build-time flags (Features object) were deleted in CL.5 (v2.10.376)
// because nothing in production read them. The runtime flag system
// (loadRuntimeFlags / getFeatureFlags / isFeatureEnabled) is what
// actually gates experimental product behaviors via env vars +
// settings.json.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetFlagsCache,
  getFeatureFlags,
  isFeatureEnabled,
  loadRuntimeFlags,
  type RuntimeFeatureFlags,
} from "./feature-flags";

describe("feature-flags", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    _resetFlagsCache();
    for (const key of [
      "KCODE_FF_ENABLE_AUTO_ROUTE",
      "KCODE_FF_ENABLE_DISTILLATION",
      "KCODE_FF_ENABLE_WORLD_MODEL",
      "KCODE_FF_ENABLE_CODEBASE_INDEX",
      "KCODE_FF_ENABLE_EXPERIMENTAL_TOOLS",
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    _resetFlagsCache();
  });

  describe("defaults", () => {
    test("all runtime flags default to true", () => {
      const flags = loadRuntimeFlags();
      expect(flags.enableAutoRoute).toBe(true);
      expect(flags.enableDistillation).toBe(true);
      expect(flags.enableWorldModel).toBe(true);
      expect(flags.enableCodebaseIndex).toBe(true);
      expect(flags.enableExperimentalTools).toBe(true);
    });

    test("getFeatureFlags returns defaults when not initialized", () => {
      const flags = getFeatureFlags();
      expect(flags.enableAutoRoute).toBe(true);
      expect(flags.enableExperimentalTools).toBe(true);
    });
  });

  describe("settings overrides", () => {
    test("settings can disable flags", () => {
      const flags = loadRuntimeFlags({ enableAutoRoute: false, enableWorldModel: false });
      expect(flags.enableAutoRoute).toBe(false);
      expect(flags.enableWorldModel).toBe(false);
      expect(flags.enableDistillation).toBe(true);
      expect(flags.enableCodebaseIndex).toBe(true);
    });

    test("settings ignore non-boolean values", () => {
      const flags = loadRuntimeFlags({ enableAutoRoute: "yes" as unknown as boolean });
      expect(flags.enableAutoRoute).toBe(true);
    });

    test("settings ignore unknown keys", () => {
      const flags = loadRuntimeFlags({
        unknownFlag: false,
      } as unknown as Partial<RuntimeFeatureFlags>);
      expect(flags.enableAutoRoute).toBe(true);
    });
  });

  describe("env var overrides", () => {
    test("env var overrides settings and defaults", () => {
      process.env.KCODE_FF_ENABLE_AUTO_ROUTE = "false";
      const flags = loadRuntimeFlags({ enableAutoRoute: true });
      expect(flags.enableAutoRoute).toBe(false);
    });

    test("env var '1' enables a flag", () => {
      process.env.KCODE_FF_ENABLE_DISTILLATION = "1";
      const flags = loadRuntimeFlags({ enableDistillation: false });
      expect(flags.enableDistillation).toBe(true);
    });

    test("env var '0' disables a flag", () => {
      process.env.KCODE_FF_ENABLE_CODEBASE_INDEX = "0";
      const flags = loadRuntimeFlags();
      expect(flags.enableCodebaseIndex).toBe(false);
    });

    test("env var 'true' enables a flag", () => {
      process.env.KCODE_FF_ENABLE_EXPERIMENTAL_TOOLS = "true";
      const flags = loadRuntimeFlags({ enableExperimentalTools: false });
      expect(flags.enableExperimentalTools).toBe(true);
    });
  });

  describe("isFeatureEnabled", () => {
    test("returns true for enabled flag", () => {
      loadRuntimeFlags();
      expect(isFeatureEnabled("enableAutoRoute")).toBe(true);
    });

    test("returns false for disabled flag", () => {
      loadRuntimeFlags({ enableAutoRoute: false });
      expect(isFeatureEnabled("enableAutoRoute")).toBe(false);
    });

    test("reflects env var overrides", () => {
      process.env.KCODE_FF_ENABLE_WORLD_MODEL = "false";
      loadRuntimeFlags();
      expect(isFeatureEnabled("enableWorldModel")).toBe(false);
    });
  });

  describe("caching", () => {
    test("getFeatureFlags returns same instance after load", () => {
      const first = loadRuntimeFlags({ enableAutoRoute: false });
      const second = getFeatureFlags();
      expect(second).toBe(first);
      expect(second.enableAutoRoute).toBe(false);
    });

    test("_resetFlagsCache causes re-initialization", () => {
      loadRuntimeFlags({ enableAutoRoute: false });
      _resetFlagsCache();
      const flags = getFeatureFlags();
      expect(flags.enableAutoRoute).toBe(true);
    });
  });
});
