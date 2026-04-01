import { test, expect, describe } from "bun:test";
import {
  Features,
  activeFeatures,
  inactiveFeatures,
  isFeatureEnabled,
  ALL_FEATURE_NAMES,
} from "./flags";
import {
  getDefinesForProfile,
  getAvailableProfiles,
  getProfileFeatures,
  describeProfile,
} from "./build-defines";

describe("feature-flags", () => {
  describe("Features object", () => {
    test("all features are boolean", () => {
      for (const [name, value] of Object.entries(Features)) {
        expect(typeof value).toBe("boolean");
      }
    });

    test("has all 11 features", () => {
      expect(ALL_FEATURE_NAMES).toHaveLength(11);
      expect(ALL_FEATURE_NAMES).toContain("voice");
      expect(ALL_FEATURE_NAMES).toContain("bridge");
      expect(ALL_FEATURE_NAMES).toContain("enterprise");
      expect(ALL_FEATURE_NAMES).toContain("telemetry");
      expect(ALL_FEATURE_NAMES).toContain("lsp");
      expect(ALL_FEATURE_NAMES).toContain("swarm");
      expect(ALL_FEATURE_NAMES).toContain("browser");
      expect(ALL_FEATURE_NAMES).toContain("mesh");
      expect(ALL_FEATURE_NAMES).toContain("distillation");
      expect(ALL_FEATURE_NAMES).toContain("collab");
      expect(ALL_FEATURE_NAMES).toContain("rag");
    });

    test("in dev mode (no --define) all features default to true", () => {
      // Without build-time defines, all flags should be true
      for (const name of ALL_FEATURE_NAMES) {
        expect(Features[name]).toBe(true);
      }
    });
  });

  describe("activeFeatures", () => {
    test("returns array of enabled feature names", () => {
      const active = activeFeatures();
      expect(Array.isArray(active)).toBe(true);
      // In dev mode, all are active
      expect(active).toHaveLength(11);
    });
  });

  describe("inactiveFeatures", () => {
    test("returns empty array in dev mode", () => {
      const inactive = inactiveFeatures();
      expect(inactive).toHaveLength(0);
    });
  });

  describe("isFeatureEnabled", () => {
    test("returns true for all features in dev mode", () => {
      expect(isFeatureEnabled("voice")).toBe(true);
      expect(isFeatureEnabled("mesh")).toBe(true);
      expect(isFeatureEnabled("collab")).toBe(true);
    });
  });
});

describe("build-defines", () => {
  describe("getDefinesForProfile", () => {
    test("full profile enables everything", () => {
      const defines = getDefinesForProfile("full");
      expect(defines["__FEATURE_VOICE__"]).toBe("true");
      expect(defines["__FEATURE_BRIDGE__"]).toBe("true");
      expect(defines["__FEATURE_ENTERPRISE__"]).toBe("true");
      expect(defines["__FEATURE_MESH__"]).toBe("true");
      expect(defines["__FEATURE_DISTILLATION__"]).toBe("true");
    });

    test("free profile disables pro features", () => {
      const defines = getDefinesForProfile("free");
      expect(defines["__FEATURE_VOICE__"]).toBe("false");
      expect(defines["__FEATURE_ENTERPRISE__"]).toBe("false");
      expect(defines["__FEATURE_SWARM__"]).toBe("false");
      expect(defines["__FEATURE_MESH__"]).toBe("false");
      expect(defines["__FEATURE_DISTILLATION__"]).toBe("false");
      // But keeps core features
      expect(defines["__FEATURE_BRIDGE__"]).toBe("true");
      expect(defines["__FEATURE_TELEMETRY__"]).toBe("true");
      expect(defines["__FEATURE_LSP__"]).toBe("true");
    });

    test("minimal profile disables everything", () => {
      const defines = getDefinesForProfile("minimal");
      for (const val of Object.values(defines)) {
        expect(val).toBe("false");
      }
    });

    test("defaults to full when no profile given", () => {
      const defines = getDefinesForProfile();
      expect(defines["__FEATURE_VOICE__"]).toBe("true");
    });

    test("defaults to full for unknown profile", () => {
      const defines = getDefinesForProfile("nonexistent");
      expect(defines["__FEATURE_VOICE__"]).toBe("true");
    });

    test("produces 11 define entries", () => {
      const defines = getDefinesForProfile("full");
      expect(Object.keys(defines)).toHaveLength(11);
    });

    test("all keys follow __FEATURE_*__ pattern", () => {
      const defines = getDefinesForProfile("full");
      for (const key of Object.keys(defines)) {
        expect(key).toMatch(/^__FEATURE_[A-Z]+__$/);
      }
    });
  });

  describe("getAvailableProfiles", () => {
    test("returns full, free, minimal", () => {
      const profiles = getAvailableProfiles();
      expect(profiles).toContain("full");
      expect(profiles).toContain("free");
      expect(profiles).toContain("minimal");
      expect(profiles).toHaveLength(3);
    });
  });

  describe("getProfileFeatures", () => {
    test("returns feature map for full", () => {
      const features = getProfileFeatures("full");
      expect(features.voice).toBe(true);
      expect(features.mesh).toBe(true);
    });

    test("returns feature map for free", () => {
      const features = getProfileFeatures("free");
      expect(features.voice).toBe(false);
      expect(features.bridge).toBe(true);
    });

    test("returns a copy (not original)", () => {
      const a = getProfileFeatures("full");
      a.voice = false;
      const b = getProfileFeatures("full");
      expect(b.voice).toBe(true);
    });
  });

  describe("describeProfile", () => {
    test("returns string description", () => {
      const desc = describeProfile("full");
      expect(desc).toContain("Profile: full");
      expect(desc).toContain("Enabled:");
    });

    test("minimal shows none enabled", () => {
      const desc = describeProfile("minimal");
      expect(desc).toContain("Disabled:");
    });
  });
});
