import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidateCache } from "./models.ts";

// config.ts exports: loadSettings, saveUserSettings, saveProjectSettings, buildConfig,
// loadInstructionFiles, loadRules, type Settings, type EffortLevel
// Internal (not exported): parseSettings, isPermissionMode, isEffortLevel, mergeSettings, envSettings

// We test loadSettings (which combines parse + merge + env) using real temp files.
// For parseSettings / isPermissionMode / isEffortLevel / mergeSettings / envSettings,
// we test them indirectly through loadSettings.

import { loadSettings, type Settings } from "./config.ts";

let tempDir: string;

async function createSettingsFile(dir: string, filename: string, content: unknown) {
  const kcodeDir = join(dir, ".kcode");
  await mkdir(kcodeDir, { recursive: true });
  await Bun.write(join(kcodeDir, filename), JSON.stringify(content, null, 2));
}

describe("config", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-config-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    // Clean up env vars we may have set
    delete process.env.KCODE_MODEL;
    delete process.env.KCODE_API_KEY;
    delete process.env.KCODE_API_BASE;
    delete process.env.KCODE_EFFORT_LEVEL;
    delete process.env.KCODE_MAX_TOKENS;
    delete process.env.KCODE_PERMISSION_MODE;
  });

  // ─── parseSettings (tested through loadSettings reading project settings) ───

  describe("parseSettings via loadSettings", () => {
    test("valid settings are parsed correctly", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        model: "test-model",
        maxTokens: 4096,
        permissionMode: "auto",
        autoMemory: true,
        effortLevel: "high",
        apiKey: "sk-test",
        apiBase: "http://test:10080",
        systemPromptExtra: "Be helpful",
      });

      const settings = await loadSettings(tempDir);
      expect(settings.model).toBe("test-model");
      expect(settings.maxTokens).toBe(4096);
      expect(settings.permissionMode).toBe("auto");
      expect(settings.autoMemory).toBe(true);
      expect(settings.effortLevel).toBe("high");
      expect(settings.apiKey).toBe("sk-test");
      expect(settings.apiBase).toBe("http://test:10080");
      expect(settings.systemPromptExtra).toBe("Be helpful");
    });

    test("invalid field types are ignored", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        model: 123, // should be string
        maxTokens: "not a number", // should be number
        permissionMode: "invalid-mode",
        autoMemory: "yes", // should be boolean
        effortLevel: "extreme", // invalid
      });

      const settings = await loadSettings(tempDir);
      expect(settings.model).toBeUndefined();
      expect(settings.maxTokens).toBeUndefined();
      expect(settings.permissionMode).toBeUndefined();
      expect(settings.autoMemory).toBeUndefined();
      expect(settings.effortLevel).toBeUndefined();
    });

    test("null input returns empty settings", async () => {
      // No settings file at all
      const settings = await loadSettings(tempDir);
      expect(settings.model).toBeUndefined();
      expect(settings.maxTokens).toBeUndefined();
    });

    test("empty object returns empty settings", async () => {
      await createSettingsFile(tempDir, "settings.json", {});
      const settings = await loadSettings(tempDir);
      expect(settings.model).toBeUndefined();
    });
  });

  // ─── mergeSettings (tested via loadSettings with multiple layers) ───

  describe("mergeSettings via loadSettings", () => {
    test("project settings override (non-existent) user settings", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        model: "project-model",
        effortLevel: "medium",
      });

      const settings = await loadSettings(tempDir);
      expect(settings.model).toBe("project-model");
      expect(settings.effortLevel).toBe("medium");
    });

    test("local settings override project settings", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        model: "project-model",
        effortLevel: "low",
      });
      await createSettingsFile(tempDir, "settings.local.json", {
        model: "local-model",
      });

      const settings = await loadSettings(tempDir);
      // local overrides project for model
      expect(settings.model).toBe("local-model");
      // project value persists for effortLevel since local doesn't set it
      expect(settings.effortLevel).toBe("low");
    });

    test("env vars override all file-based settings", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        model: "file-model",
        effortLevel: "low",
      });
      await createSettingsFile(tempDir, "settings.local.json", {
        model: "local-model",
      });

      process.env.KCODE_MODEL = "env-model";
      process.env.KCODE_EFFORT_LEVEL = "high";

      const settings = await loadSettings(tempDir);
      expect(settings.model).toBe("env-model");
      expect(settings.effortLevel).toBe("high");
    });

    test("undefined fields do not override earlier layers", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        model: "project-model",
        maxTokens: 8192,
        effortLevel: "medium",
      });
      // local only overrides model, not maxTokens
      await createSettingsFile(tempDir, "settings.local.json", {
        model: "local-override",
      });

      const settings = await loadSettings(tempDir);
      expect(settings.model).toBe("local-override");
      expect(settings.maxTokens).toBe(8192);
      expect(settings.effortLevel).toBe("medium");
    });
  });

  // ─── envSettings ───

  describe("envSettings via loadSettings", () => {
    test("reads KCODE_MODEL from env", async () => {
      process.env.KCODE_MODEL = "env-model";
      const settings = await loadSettings(tempDir);
      expect(settings.model).toBe("env-model");
    });

    test("reads KCODE_API_KEY from env", async () => {
      process.env.KCODE_API_KEY = "sk-env-key";
      const settings = await loadSettings(tempDir);
      expect(settings.apiKey).toBe("sk-env-key");
    });

    test("reads KCODE_API_BASE from env", async () => {
      process.env.KCODE_API_BASE = "http://env:9090";
      const settings = await loadSettings(tempDir);
      expect(settings.apiBase).toBe("http://env:9090");
    });

    test("reads KCODE_EFFORT_LEVEL from env (valid values only)", async () => {
      process.env.KCODE_EFFORT_LEVEL = "medium";
      const settings = await loadSettings(tempDir);
      expect(settings.effortLevel).toBe("medium");
    });

    test("ignores invalid KCODE_EFFORT_LEVEL", async () => {
      process.env.KCODE_EFFORT_LEVEL = "ultra";
      const settings = await loadSettings(tempDir);
      expect(settings.effortLevel).toBeUndefined();
    });

    test("reads KCODE_MAX_TOKENS from env as number", async () => {
      process.env.KCODE_MAX_TOKENS = "32768";
      const settings = await loadSettings(tempDir);
      expect(settings.maxTokens).toBe(32768);
    });

    test("ignores non-numeric KCODE_MAX_TOKENS", async () => {
      process.env.KCODE_MAX_TOKENS = "lots";
      const settings = await loadSettings(tempDir);
      expect(settings.maxTokens).toBeUndefined();
    });

    test("reads KCODE_PERMISSION_MODE from env (valid values only)", async () => {
      process.env.KCODE_PERMISSION_MODE = "auto";
      const settings = await loadSettings(tempDir);
      expect(settings.permissionMode).toBe("auto");
    });

    test("ignores invalid KCODE_PERMISSION_MODE", async () => {
      process.env.KCODE_PERMISSION_MODE = "yolo";
      const settings = await loadSettings(tempDir);
      expect(settings.permissionMode).toBeUndefined();
    });
  });

  // ─── isPermissionMode / isEffortLevel (tested indirectly) ───

  describe("isPermissionMode validators", () => {
    test("accepts ask mode", async () => {
      await createSettingsFile(tempDir, "settings.json", { permissionMode: "ask" });
      const s = await loadSettings(tempDir);
      expect(s.permissionMode).toBe("ask");
    });

    test("accepts auto mode", async () => {
      await createSettingsFile(tempDir, "settings.json", { permissionMode: "auto" });
      const s = await loadSettings(tempDir);
      expect(s.permissionMode).toBe("auto");
    });

    test("accepts plan mode", async () => {
      await createSettingsFile(tempDir, "settings.json", { permissionMode: "plan" });
      const s = await loadSettings(tempDir);
      expect(s.permissionMode).toBe("plan");
    });

    test("accepts deny mode", async () => {
      await createSettingsFile(tempDir, "settings.json", { permissionMode: "deny" });
      const s = await loadSettings(tempDir);
      expect(s.permissionMode).toBe("deny");
    });

    test("rejects invalid permission mode", async () => {
      await createSettingsFile(tempDir, "settings.json", { permissionMode: "sudo" });
      const s = await loadSettings(tempDir);
      expect(s.permissionMode).toBeUndefined();
    });
  });

  describe("isEffortLevel validators", () => {
    test("accepts low", async () => {
      await createSettingsFile(tempDir, "settings.json", { effortLevel: "low" });
      const s = await loadSettings(tempDir);
      expect(s.effortLevel).toBe("low");
    });

    test("accepts medium", async () => {
      await createSettingsFile(tempDir, "settings.json", { effortLevel: "medium" });
      const s = await loadSettings(tempDir);
      expect(s.effortLevel).toBe("medium");
    });

    test("accepts high", async () => {
      await createSettingsFile(tempDir, "settings.json", { effortLevel: "high" });
      const s = await loadSettings(tempDir);
      expect(s.effortLevel).toBe("high");
    });

    test("rejects invalid effort level", async () => {
      await createSettingsFile(tempDir, "settings.json", { effortLevel: "turbo" });
      const s = await loadSettings(tempDir);
      expect(s.effortLevel).toBeUndefined();
    });
  });
});
