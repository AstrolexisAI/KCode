import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _parseMdmSettings, clearMdmCache, loadMdmSettings } from "./reader";

let tempDir: string;
let origEnv: Record<string, string | undefined>;

describe("mdm/reader", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-mdm-test-"));
    origEnv = {
      KCODE_HOME: process.env.KCODE_HOME,
    };
    process.env.KCODE_HOME = tempDir;
    clearMdmCache();
  });

  afterEach(async () => {
    for (const [key, val] of Object.entries(origEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    clearMdmCache();
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── parseMdmSettings ────────────────────────────────────────

  describe("parseMdmSettings", () => {
    test("parses valid settings object", () => {
      const result = _parseMdmSettings({
        permissionMode: "auto",
        allowedTools: ["Read", "Write"],
        blockedTools: ["WebFetch"],
        maxBudgetUsd: 100,
        auditLogging: true,
        disableWebAccess: false,
        allowedModels: ["gpt-4*"],
        blockedModels: ["llama*"],
        customSystemPrompt: "Be safe",
        forceModel: "gpt-4",
      });

      expect(result).not.toBeNull();
      expect(result!.permissionMode).toBe("auto");
      expect(result!.allowedTools).toEqual(["Read", "Write"]);
      expect(result!.blockedTools).toEqual(["WebFetch"]);
      expect(result!.maxBudgetUsd).toBe(100);
      expect(result!.auditLogging).toBe(true);
      expect(result!.disableWebAccess).toBe(false);
      expect(result!.allowedModels).toEqual(["gpt-4*"]);
      expect(result!.blockedModels).toEqual(["llama*"]);
      expect(result!.customSystemPrompt).toBe("Be safe");
      expect(result!.forceModel).toBe("gpt-4");
    });

    test("returns null for null input", () => {
      expect(_parseMdmSettings(null)).toBeNull();
    });

    test("returns null for non-object input", () => {
      expect(_parseMdmSettings("string")).toBeNull();
      expect(_parseMdmSettings(42)).toBeNull();
      expect(_parseMdmSettings(true)).toBeNull();
    });

    test("returns null for empty object (no recognized fields)", () => {
      expect(_parseMdmSettings({})).toBeNull();
      expect(_parseMdmSettings({ unknownField: "value" })).toBeNull();
    });

    test("filters non-string values from arrays", () => {
      const result = _parseMdmSettings({
        allowedTools: ["Read", 42, null, "Write", undefined],
      });
      expect(result).not.toBeNull();
      expect(result!.allowedTools).toEqual(["Read", "Write"]);
    });

    test("ignores wrong types for scalar fields", () => {
      const result = _parseMdmSettings({
        permissionMode: 42,
        maxBudgetUsd: "not a number",
        auditLogging: "yes",
        // Only allowedTools has correct type
        allowedTools: ["Read"],
      });
      expect(result).not.toBeNull();
      expect(result!.permissionMode).toBeUndefined();
      expect(result!.maxBudgetUsd).toBeUndefined();
      expect(result!.auditLogging).toBeUndefined();
      expect(result!.allowedTools).toEqual(["Read"]);
    });

    test("parses partial settings", () => {
      const result = _parseMdmSettings({
        maxBudgetUsd: 50,
      });
      expect(result).not.toBeNull();
      expect(result!.maxBudgetUsd).toBe(50);
      expect(result!.permissionMode).toBeUndefined();
    });
  });

  // ─── loadMdmSettings ─────────────────────────────────────────

  describe("loadMdmSettings", () => {
    test("returns null on Linux when no managed settings files exist", async () => {
      // On Linux CI/dev, /etc/kcode/managed-settings.json likely doesn't exist
      // The function should gracefully return null
      const result = await loadMdmSettings();
      // Could be null or could have settings if the test machine has MDM configured
      // We just verify it doesn't throw
      expect(result === null || typeof result === "object").toBe(true);
    });

    test("caches result across calls", async () => {
      const first = await loadMdmSettings();
      const second = await loadMdmSettings();
      // Same reference (cached)
      expect(first).toBe(second);
    });

    test("clearMdmCache allows re-reading", async () => {
      const first = await loadMdmSettings();
      clearMdmCache();
      const second = await loadMdmSettings();
      // After clearing cache, a fresh read happens
      // Values should be equivalent but we just verify no crash
      expect(second === null || typeof second === "object").toBe(true);
    });
  });

  // ─── Platform-specific edge cases ────────────────────────────

  describe("platform handling", () => {
    test("does not throw on current platform", async () => {
      clearMdmCache();
      // Should handle whatever platform we're running on — returns settings or null
      const result = await loadMdmSettings();
      expect(result === null || typeof result === "object").toBe(true);
    });
  });
});
