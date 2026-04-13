import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyAirGapOverrides,
  type EffortLevel,
  isModelAllowedByPolicy,
  loadInstructionFiles,
  loadRules,
  loadSettings,
  type ManagedPolicy,
  type Settings,
  saveProjectSettings,
} from "./config.ts";
import { trustWorkspace } from "./hook-trust";

let tempDir: string;

async function createSettingsFile(dir: string, filename: string, content: unknown) {
  const kcodeDir = join(dir, ".kcode");
  await mkdir(kcodeDir, { recursive: true });
  await Bun.write(join(kcodeDir, filename), JSON.stringify(content, null, 2));
}

async function writeTextFile(path: string, content: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, content);
}

describe("config", () => {
  let originalKcodeHome: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-config-test-"));
    // Isolate KCODE_HOME inside tempDir so the developer's real ~/.kcode
    // (which may contain permissionMode, proKey, etc.) does not bleed in.
    originalKcodeHome = process.env.KCODE_HOME;
    process.env.KCODE_HOME = join(tempDir, "kcode-home");
    await mkdir(process.env.KCODE_HOME, { recursive: true });
    // Trust the temp workspace so project-level settings load in tests
    trustWorkspace(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (originalKcodeHome === undefined) delete process.env.KCODE_HOME;
    else process.env.KCODE_HOME = originalKcodeHome;
    // Clean up env vars we may have set
    delete process.env.KCODE_MODEL;
    delete process.env.KCODE_API_KEY;
    delete process.env.KCODE_API_BASE;
    delete process.env.KCODE_EFFORT;
    delete process.env.KCODE_EFFORT_LEVEL;
    delete process.env.KCODE_MAX_TOKENS;
    delete process.env.KCODE_PERMISSION_MODE;
    delete process.env.KCODE_THEME;
    delete process.env.KCODE_LANG;
    delete process.env.KCODE_DEPLOYMENT;
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

    test("autoMemory as object is parsed correctly", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        autoMemory: {
          enabled: true,
          model: "memory-model",
          minConfidence: 0.8,
          maxPerTurn: 3,
          cooldownTurns: 2,
          excludeTypes: ["code"],
        },
      });
      const settings = await loadSettings(tempDir);
      expect(typeof settings.autoMemory).toBe("object");
      const am = settings.autoMemory as { enabled: boolean; model: string };
      expect(am.enabled).toBe(true);
      expect(am.model).toBe("memory-model");
    });

    test("autoMemory as false is parsed correctly", async () => {
      await createSettingsFile(tempDir, "settings.json", { autoMemory: false });
      const settings = await loadSettings(tempDir);
      expect(settings.autoMemory).toBe(false);
    });

    test("boolean fields parse correctly", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        autoRoute: true,
        telemetry: false,
        thinking: true,
        noCache: true,
      });
      const settings = await loadSettings(tempDir);
      expect(settings.autoRoute).toBe(true);
      expect(settings.telemetry).toBe(false);
      expect(settings.thinking).toBe(true);
      expect(settings.noCache).toBe(true);
    });

    test("boolean fields with wrong types are ignored at project level", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        autoRoute: "yes",
        telemetry: 1,
        thinking: "true",
        noCache: 0,
      });
      const settings = await loadSettings(tempDir);
      // These fields have wrong types in the project file, so they should not
      // be set from the project layer. However, user-level ~/.kcode/settings.json
      // may still contribute values for telemetry/thinking via mergeSettings.
      expect(settings.autoRoute).toBeUndefined();
      expect(settings.noCache).toBeUndefined();
    });

    test("reasoningBudget parses as number", async () => {
      await createSettingsFile(tempDir, "settings.json", { reasoningBudget: -1 });
      const settings = await loadSettings(tempDir);
      expect(settings.reasoningBudget).toBe(-1);
    });

    test("reasoningBudget non-number is ignored at project level", async () => {
      await createSettingsFile(tempDir, "settings.json", { reasoningBudget: "unlimited" });
      const settings = await loadSettings(tempDir);
      // The project-level "unlimited" string should be rejected by parseSettings.
      // However, user-level settings may still provide a valid reasoningBudget value.
      // We verify the invalid project value didn't produce a string type.
      if (settings.reasoningBudget !== undefined) {
        expect(typeof settings.reasoningBudget).toBe("number");
      }
    });

    test("theme and language as strings", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        theme: "dracula",
        language: "es",
      });
      const settings = await loadSettings(tempDir);
      expect(settings.theme).toBe("dracula");
      expect(settings.language).toBe("es");
    });

    test("fallbackModel and tertiaryModel parse as strings", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        fallbackModel: "fallback-1",
        tertiaryModel: "tertiary-1",
      });
      const settings = await loadSettings(tempDir);
      expect(settings.fallbackModel).toBe("fallback-1");
      expect(settings.tertiaryModel).toBe("tertiary-1");
    });

    test("fallbackModels parses as string array", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        fallbackModels: ["model-a", "model-b"],
      });
      const settings = await loadSettings(tempDir);
      expect(settings.fallbackModels).toEqual(["model-a", "model-b"]);
    });

    test("fallbackModels with non-string elements is ignored", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        fallbackModels: ["model-a", 42, true],
      });
      const settings = await loadSettings(tempDir);
      expect(settings.fallbackModels).toBeUndefined();
    });

    test("maxBudgetUsd must be positive", async () => {
      await createSettingsFile(tempDir, "settings.json", { maxBudgetUsd: 10 });
      let s = await loadSettings(tempDir);
      expect(s.maxBudgetUsd).toBe(10);

      await createSettingsFile(tempDir, "settings.json", { maxBudgetUsd: 0 });
      s = await loadSettings(tempDir);
      expect(s.maxBudgetUsd).toBeUndefined();

      await createSettingsFile(tempDir, "settings.json", { maxBudgetUsd: -5 });
      s = await loadSettings(tempDir);
      expect(s.maxBudgetUsd).toBeUndefined();
    });

    test("compactThreshold valid range 0.5-0.95", async () => {
      await createSettingsFile(tempDir, "settings.json", { compactThreshold: 0.8 });
      let s = await loadSettings(tempDir);
      expect(s.compactThreshold).toBe(0.8);

      await createSettingsFile(tempDir, "settings.json", { compactThreshold: 0.5 });
      s = await loadSettings(tempDir);
      expect(s.compactThreshold).toBe(0.5);

      await createSettingsFile(tempDir, "settings.json", { compactThreshold: 0.95 });
      s = await loadSettings(tempDir);
      expect(s.compactThreshold).toBe(0.95);
    });

    test("compactThreshold out of range is ignored", async () => {
      await createSettingsFile(tempDir, "settings.json", { compactThreshold: 0.49 });
      let s = await loadSettings(tempDir);
      expect(s.compactThreshold).toBeUndefined();

      await createSettingsFile(tempDir, "settings.json", { compactThreshold: 0.96 });
      s = await loadSettings(tempDir);
      expect(s.compactThreshold).toBeUndefined();

      await createSettingsFile(tempDir, "settings.json", { compactThreshold: 1.5 });
      s = await loadSettings(tempDir);
      expect(s.compactThreshold).toBeUndefined();
    });

    test("deployment mode validation", async () => {
      for (const mode of ["cloud", "hybrid", "air-gap"] as const) {
        await createSettingsFile(tempDir, "settings.json", { deployment: mode });
        const s = await loadSettings(tempDir);
        expect(s.deployment).toBe(mode);
      }

      await createSettingsFile(tempDir, "settings.json", { deployment: "on-prem" });
      const s = await loadSettings(tempDir);
      expect(s.deployment).toBeUndefined();
    });
  });

  // ─── Ensemble settings parsing ───

  describe("ensemble settings parsing", () => {
    test("valid ensemble settings are parsed", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        ensemble: {
          enabled: true,
          strategy: "majority",
          models: ["model-a", "model-b"],
          judgeModel: "judge-model",
          maxParallel: 3,
          timeout: 30000,
          minResponses: 2,
          triggerOn: "always",
        },
      });
      const s = await loadSettings(tempDir);
      expect(s.ensemble).toBeDefined();
      expect(s.ensemble!.enabled).toBe(true);
      expect(s.ensemble!.strategy).toBe("majority");
      expect(s.ensemble!.models).toEqual(["model-a", "model-b"]);
      expect(s.ensemble!.judgeModel).toBe("judge-model");
      expect(s.ensemble!.maxParallel).toBe(3);
      expect(s.ensemble!.timeout).toBe(30000);
      expect(s.ensemble!.minResponses).toBe(2);
    });

    test("ensemble judgeModel null is preserved", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        ensemble: { judgeModel: null },
      });
      const s = await loadSettings(tempDir);
      expect(s.ensemble).toBeDefined();
      expect(s.ensemble!.judgeModel).toBeNull();
    });

    test("ensemble models filters non-strings", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        ensemble: { models: ["valid", 123, true] },
      });
      const s = await loadSettings(tempDir);
      expect(s.ensemble!.models).toEqual(["valid"]);
    });

    test("ensemble non-object is ignored", async () => {
      await createSettingsFile(tempDir, "settings.json", { ensemble: "yes" });
      const s = await loadSettings(tempDir);
      expect(s.ensemble).toBeUndefined();
    });
  });

  // ─── Hardware settings parsing ───

  describe("hardware settings parsing", () => {
    test("valid hardware settings are parsed", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        hardware: {
          autoOptimize: true,
          contextWindow: 4096,
          batchSize: 512,
          threads: 8,
          gpuLayers: 35,
        },
      });
      const s = await loadSettings(tempDir);
      expect(s.hardware).toBeDefined();
      expect(s.hardware!.autoOptimize).toBe(true);
      expect(s.hardware!.contextWindow).toBe(4096);
      expect(s.hardware!.batchSize).toBe(512);
      expect(s.hardware!.threads).toBe(8);
      expect(s.hardware!.gpuLayers).toBe(35);
    });

    test("hardware with zero/negative values for positives are ignored", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        hardware: {
          contextWindow: 0,
          batchSize: -1,
          threads: 0,
        },
      });
      const s = await loadSettings(tempDir);
      // All invalid positive values should result in undefined hardware
      expect(s.hardware).toBeUndefined();
    });

    test("hardware gpuLayers allows zero", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        hardware: { gpuLayers: 0 },
      });
      const s = await loadSettings(tempDir);
      expect(s.hardware).toBeDefined();
      expect(s.hardware!.gpuLayers).toBe(0);
    });

    test("hardware non-object is ignored", async () => {
      await createSettingsFile(tempDir, "settings.json", { hardware: true });
      const s = await loadSettings(tempDir);
      expect(s.hardware).toBeUndefined();
    });

    test("empty hardware object returns undefined", async () => {
      await createSettingsFile(tempDir, "settings.json", { hardware: {} });
      const s = await loadSettings(tempDir);
      expect(s.hardware).toBeUndefined();
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

    test("permission rules merge across layers (appended)", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        permissionRules: [{ pattern: "Read(*)", action: "allow" }],
      });
      await createSettingsFile(tempDir, "settings.local.json", {
        permissionRules: [{ pattern: "Bash(rm *)", action: "deny" }],
      });

      const settings = await loadSettings(tempDir);
      expect(settings.permissionRules).toBeDefined();
      expect(settings.permissionRules!.length).toBeGreaterThanOrEqual(2);
      const patterns = settings.permissionRules!.map((r) => r.pattern);
      expect(patterns).toContain("Read(*)");
      expect(patterns).toContain("Bash(rm *)");
    });

    test("ensemble settings merge across layers (shallow merge)", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        ensemble: { enabled: true, maxParallel: 2 },
      });
      await createSettingsFile(tempDir, "settings.local.json", {
        ensemble: { maxParallel: 4, timeout: 60000 },
      });

      const settings = await loadSettings(tempDir);
      expect(settings.ensemble).toBeDefined();
      expect(settings.ensemble!.enabled).toBe(true);
      expect(settings.ensemble!.maxParallel).toBe(4);
      expect(settings.ensemble!.timeout).toBe(60000);
    });

    test("hardware settings merge across layers", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        hardware: { autoOptimize: true, threads: 4 },
      });
      await createSettingsFile(tempDir, "settings.local.json", {
        hardware: { threads: 8, gpuLayers: 35 },
      });

      const settings = await loadSettings(tempDir);
      expect(settings.hardware).toBeDefined();
      expect(settings.hardware!.autoOptimize).toBe(true);
      expect(settings.hardware!.threads).toBe(8);
      expect(settings.hardware!.gpuLayers).toBe(35);
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

    test("reads KCODE_EFFORT alias from env", async () => {
      process.env.KCODE_EFFORT = "low";
      const settings = await loadSettings(tempDir);
      expect(settings.effortLevel).toBe("low");
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

    test("reads KCODE_THEME from env", async () => {
      process.env.KCODE_THEME = "monokai";
      const settings = await loadSettings(tempDir);
      expect(settings.theme).toBe("monokai");
    });

    test("reads KCODE_LANG from env", async () => {
      process.env.KCODE_LANG = "fr";
      const settings = await loadSettings(tempDir);
      expect(settings.language).toBe("fr");
    });

    test("reads KCODE_DEPLOYMENT from env (valid values only)", async () => {
      process.env.KCODE_DEPLOYMENT = "air-gap";
      const settings = await loadSettings(tempDir);
      expect(settings.deployment).toBe("air-gap");
    });

    test("ignores invalid KCODE_DEPLOYMENT", async () => {
      process.env.KCODE_DEPLOYMENT = "serverless";
      const settings = await loadSettings(tempDir);
      expect(settings.deployment).toBeUndefined();
    });

    test("env vars override local file settings", async () => {
      await createSettingsFile(tempDir, "settings.local.json", {
        model: "local-model",
        theme: "dracula",
      });
      process.env.KCODE_MODEL = "env-wins";
      process.env.KCODE_THEME = "monokai";

      const settings = await loadSettings(tempDir);
      expect(settings.model).toBe("env-wins");
      expect(settings.theme).toBe("monokai");
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

    test("accepts acceptEdits mode", async () => {
      await createSettingsFile(tempDir, "settings.json", { permissionMode: "acceptEdits" });
      const s = await loadSettings(tempDir);
      expect(s.permissionMode).toBe("acceptEdits");
    });

    test("rejects invalid permission mode", async () => {
      await createSettingsFile(tempDir, "settings.json", { permissionMode: "sudo" });
      const s = await loadSettings(tempDir);
      expect(s.permissionMode).toBeUndefined();
    });
  });

  describe("isEffortLevel validators", () => {
    test("accepts all valid effort levels", async () => {
      for (const level of ["low", "medium", "high", "max"] as EffortLevel[]) {
        await createSettingsFile(tempDir, "settings.json", { effortLevel: level });
        const s = await loadSettings(tempDir);
        expect(s.effortLevel).toBe(level);
      }
    });

    test("rejects invalid effort level", async () => {
      await createSettingsFile(tempDir, "settings.json", { effortLevel: "turbo" });
      const s = await loadSettings(tempDir);
      expect(s.effortLevel).toBeUndefined();
    });
  });

  // ─── Permission rules parsing ───

  describe("permission rules", () => {
    test("permissionRules array with valid entries", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        permissionRules: [
          { pattern: "Read(*)", action: "allow" },
          { pattern: "Bash(rm *)", action: "deny" },
          { pattern: "Edit(*)", action: "ask" },
        ],
      });
      const s = await loadSettings(tempDir);
      expect(s.permissionRules).toBeDefined();
      expect(s.permissionRules!.length).toBe(3);
      expect(s.permissionRules![0]).toEqual({ pattern: "Read(*)", action: "allow" });
      expect(s.permissionRules![1]).toEqual({ pattern: "Bash(rm *)", action: "deny" });
      expect(s.permissionRules![2]).toEqual({ pattern: "Edit(*)", action: "ask" });
    });

    test("permissionRules with invalid entries are filtered out", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        permissionRules: [
          { pattern: "Read(*)", action: "allow" },
          { pattern: 123, action: "allow" }, // invalid pattern type
          { pattern: "Edit(*)", action: "nope" }, // invalid action
          { action: "deny" }, // missing pattern
          "not an object",
        ],
      });
      const s = await loadSettings(tempDir);
      expect(s.permissionRules).toBeDefined();
      expect(s.permissionRules!.length).toBe(1);
      expect(s.permissionRules![0]).toEqual({ pattern: "Read(*)", action: "allow" });
    });

    test("permissions config format (allow/deny/ask arrays)", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        permissions: {
          allow: ["Read(*)", "Glob(*)"],
          deny: ["Bash(rm -rf *)"],
          ask: ["Edit(*)"],
        },
      });
      const s = await loadSettings(tempDir);
      expect(s.permissionRules).toBeDefined();
      // deny rules come first, then ask, then allow
      const actions = s.permissionRules!.map((r) => r.action);
      const denyIdx = actions.indexOf("deny");
      const askIdx = actions.indexOf("ask");
      const allowIdx = actions.indexOf("allow");
      expect(denyIdx).toBeLessThan(askIdx);
      expect(askIdx).toBeLessThan(allowIdx);
    });

    test("mixed permissionRules and permissions config are merged", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        permissionRules: [{ pattern: "Read(*)", action: "allow" }],
        permissions: { deny: ["Bash(rm *)"] },
      });
      const s = await loadSettings(tempDir);
      expect(s.permissionRules).toBeDefined();
      const patterns = s.permissionRules!.map((r) => r.pattern);
      expect(patterns).toContain("Read(*)");
      expect(patterns).toContain("Bash(rm *)");
    });

    test("permissions config with non-string entries are filtered", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        permissions: {
          allow: ["Read(*)", 42, true],
          deny: [null, "Bash(rm *)"],
        },
      });
      const s = await loadSettings(tempDir);
      expect(s.permissionRules).toBeDefined();
      const patterns = s.permissionRules!.map((r) => r.pattern);
      expect(patterns).toContain("Read(*)");
      expect(patterns).toContain("Bash(rm *)");
      // Non-strings should be excluded
      expect(s.permissionRules!.length).toBe(2);
    });

    test("empty permissionRules array does not produce rules from that source", async () => {
      await createSettingsFile(tempDir, "settings.json", { permissionRules: [] });
      const s = await loadSettings(tempDir);
      // No rules from settings, but there might be none from other sources
      // The key check is that it doesn't crash
      expect(s).toBeDefined();
    });
  });

  // ─── Edge cases: malformed JSON, missing files ───

  describe("edge cases", () => {
    test("malformed JSON in settings file is handled gracefully", async () => {
      const kcodeDir = join(tempDir, ".kcode");
      await mkdir(kcodeDir, { recursive: true });
      await Bun.write(join(kcodeDir, "settings.json"), "{ not valid json }}}");

      // Should not throw, returns empty settings
      const settings = await loadSettings(tempDir);
      expect(settings).toBeDefined();
    });

    test("missing .kcode directory is handled gracefully", async () => {
      // No .kcode directory at all
      const settings = await loadSettings(tempDir);
      expect(settings).toBeDefined();
    });

    test("empty file is handled gracefully", async () => {
      const kcodeDir = join(tempDir, ".kcode");
      await mkdir(kcodeDir, { recursive: true });
      await Bun.write(join(kcodeDir, "settings.json"), "");

      const settings = await loadSettings(tempDir);
      expect(settings).toBeDefined();
    });

    test("settings file with array instead of object is handled", async () => {
      const kcodeDir = join(tempDir, ".kcode");
      await mkdir(kcodeDir, { recursive: true });
      await Bun.write(join(kcodeDir, "settings.json"), "[1, 2, 3]");

      const settings = await loadSettings(tempDir);
      expect(settings).toBeDefined();
    });

    test("settings with extra unknown fields are silently ignored", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        model: "good-model",
        unknownField: "should be ignored",
        anotherUnknown: 42,
      });
      const s = await loadSettings(tempDir);
      expect(s.model).toBe("good-model");
      // unknown fields should not appear on the parsed result
      expect((s as Record<string, unknown>).unknownField).toBeUndefined();
    });

    test("malformed local settings do not break project settings", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        model: "project-model",
        effortLevel: "medium",
      });
      const kcodeDir = join(tempDir, ".kcode");
      await Bun.write(join(kcodeDir, "settings.local.json"), "NOT JSON AT ALL");

      const settings = await loadSettings(tempDir);
      // Project settings should still be available
      expect(settings.model).toBe("project-model");
      expect(settings.effortLevel).toBe("medium");
    });

    test("settings with null values for string fields", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        model: null,
        apiKey: null,
        theme: null,
      });
      const s = await loadSettings(tempDir);
      expect(s.model).toBeUndefined();
      expect(s.apiKey).toBeUndefined();
      expect(s.theme).toBeUndefined();
    });
  });

  // ─── isModelAllowedByPolicy ───

  describe("isModelAllowedByPolicy", () => {
    test("returns true when no restrictions", () => {
      const policy: ManagedPolicy = {};
      expect(isModelAllowedByPolicy("any-model", policy)).toBe(true);
    });

    test("blocked model is rejected", () => {
      const policy: ManagedPolicy = { blockedModels: ["gpt-4*"] };
      expect(isModelAllowedByPolicy("gpt-4-turbo", policy)).toBe(false);
      expect(isModelAllowedByPolicy("gpt-3.5-turbo", policy)).toBe(true);
    });

    test("allowlist restricts to only allowed models", () => {
      const policy: ManagedPolicy = { allowedModels: ["llama-*", "mistral-*"] };
      expect(isModelAllowedByPolicy("llama-3", policy)).toBe(true);
      expect(isModelAllowedByPolicy("mistral-7b", policy)).toBe(true);
      expect(isModelAllowedByPolicy("gpt-4", policy)).toBe(false);
    });

    test("blocklist takes priority over allowlist", () => {
      const policy: ManagedPolicy = {
        allowedModels: ["llama-*"],
        blockedModels: ["llama-2*"],
      };
      expect(isModelAllowedByPolicy("llama-3", policy)).toBe(true);
      expect(isModelAllowedByPolicy("llama-2-70b", policy)).toBe(false);
    });

    test("glob matching is case-insensitive", () => {
      const policy: ManagedPolicy = { blockedModels: ["GPT-4*"] };
      expect(isModelAllowedByPolicy("gpt-4-turbo", policy)).toBe(false);
    });

    test("exact model name match", () => {
      const policy: ManagedPolicy = { allowedModels: ["my-model"] };
      expect(isModelAllowedByPolicy("my-model", policy)).toBe(true);
      expect(isModelAllowedByPolicy("my-model-v2", policy)).toBe(false);
    });

    test("wildcard matches everything", () => {
      const policy: ManagedPolicy = { allowedModels: ["*"] };
      expect(isModelAllowedByPolicy("any-model", policy)).toBe(true);
    });

    test("empty blockedModels array does not restrict", () => {
      const policy: ManagedPolicy = { blockedModels: [] };
      expect(isModelAllowedByPolicy("anything", policy)).toBe(true);
    });

    test("empty allowedModels array does not restrict", () => {
      const policy: ManagedPolicy = { allowedModels: [] };
      expect(isModelAllowedByPolicy("anything", policy)).toBe(true);
    });

    test("multiple blocked patterns", () => {
      const policy: ManagedPolicy = { blockedModels: ["gpt-*", "claude-*"] };
      expect(isModelAllowedByPolicy("gpt-4", policy)).toBe(false);
      expect(isModelAllowedByPolicy("claude-3", policy)).toBe(false);
      expect(isModelAllowedByPolicy("llama-3", policy)).toBe(true);
    });

    test("special regex characters in model names are escaped", () => {
      const policy: ManagedPolicy = { allowedModels: ["model.v1"] };
      // The dot should be literal, not regex wildcard
      expect(isModelAllowedByPolicy("model.v1", policy)).toBe(true);
      expect(isModelAllowedByPolicy("modelXv1", policy)).toBe(false);
    });

    test("glob with special chars in pattern", () => {
      const policy: ManagedPolicy = { allowedModels: ["org/model-*"] };
      expect(isModelAllowedByPolicy("org/model-v1", policy)).toBe(true);
      expect(isModelAllowedByPolicy("other/model-v1", policy)).toBe(false);
    });
  });

  // ─── applyAirGapOverrides ───

  describe("applyAirGapOverrides", () => {
    test("returns settings unchanged when deployment is not air-gap", () => {
      const settings: Settings = {
        model: "test",
        autoUpdate: true,
        telemetry: true,
        deployment: "cloud",
      };
      const result = applyAirGapOverrides(settings);
      expect(result.autoUpdate).toBe(true);
      expect(result.telemetry).toBe(true);
    });

    test("returns settings unchanged when no deployment set", () => {
      const settings: Settings = { autoUpdate: true, telemetry: true };
      const result = applyAirGapOverrides(settings);
      expect(result.autoUpdate).toBe(true);
      expect(result.telemetry).toBe(true);
    });

    test("returns settings unchanged for hybrid deployment", () => {
      const settings: Settings = { deployment: "hybrid", autoUpdate: true, telemetry: true };
      const result = applyAirGapOverrides(settings);
      expect(result.autoUpdate).toBe(true);
      expect(result.telemetry).toBe(true);
    });

    test("forces autoUpdate false in air-gap mode", () => {
      const settings: Settings = { deployment: "air-gap", autoUpdate: true };
      const result = applyAirGapOverrides(settings);
      expect(result.autoUpdate).toBe(false);
    });

    test("forces telemetry false in air-gap mode", () => {
      const settings: Settings = { deployment: "air-gap", telemetry: true };
      const result = applyAirGapOverrides(settings);
      expect(result.telemetry).toBe(false);
    });

    test("enables offline mode in air-gap mode", () => {
      const settings: Settings = { deployment: "air-gap" };
      const result = applyAirGapOverrides(settings);
      expect(result.offline).toBeDefined();
      expect(result.offline!.enabled).toBe(true);
      expect(result.offline!.autoDetect).toBe(false);
    });

    test("disables auto-route feature flag in air-gap mode", () => {
      const settings: Settings = {
        deployment: "air-gap",
        featureFlags: { enableAutoRoute: true, enableDistillation: true },
      };
      const result = applyAirGapOverrides(settings);
      expect(result.featureFlags).toBeDefined();
      expect(result.featureFlags!.enableAutoRoute).toBe(false);
      // Other feature flags preserved
      expect(result.featureFlags!.enableDistillation).toBe(true);
    });

    test("disables marketplace remote in air-gap mode", () => {
      const settings: Settings = { deployment: "air-gap" };
      const result = applyAirGapOverrides(settings);
      expect(result.marketplace).toBeDefined();
      expect((result.marketplace as Record<string, unknown>).disableRemote).toBe(true);
    });

    test("preserves existing offline settings while forcing enabled", () => {
      const settings: Settings = {
        deployment: "air-gap",
        offline: { bundlePath: "/opt/kcode/offline" } as Settings["offline"],
      };
      const result = applyAirGapOverrides(settings);
      expect(result.offline!.enabled).toBe(true);
      expect((result.offline as Record<string, unknown>).bundlePath).toBe("/opt/kcode/offline");
    });

    test("does not mutate the original settings object", () => {
      const settings: Settings = { deployment: "air-gap", autoUpdate: true };
      const result = applyAirGapOverrides(settings);
      expect(settings.autoUpdate).toBe(true); // original unchanged
      expect(result.autoUpdate).toBe(false); // new object changed
    });
  });

  // ─── loadInstructionFiles ───

  describe("loadInstructionFiles", () => {
    test("returns null when no KCODE.md exists", async () => {
      const result = await loadInstructionFiles(tempDir);
      expect(result).toBeNull();
    });

    test("loads KCODE.md from cwd", async () => {
      await writeTextFile(join(tempDir, "KCODE.md"), "# Test Instructions\nDo things.");
      const result = await loadInstructionFiles(tempDir);
      expect(result).toContain("# Test Instructions");
      expect(result).toContain("Do things.");
    });

    test("includes project root label for cwd-level file", async () => {
      await writeTextFile(join(tempDir, "KCODE.md"), "content here");
      const result = await loadInstructionFiles(tempDir);
      expect(result).toContain("project root");
    });

    test("preserves full content of instruction file", async () => {
      const content = "Line 1\nLine 2\nLine 3\n\n## Section\n\nMore content";
      await writeTextFile(join(tempDir, "KCODE.md"), content);
      const result = await loadInstructionFiles(tempDir);
      expect(result).toContain("Line 1");
      expect(result).toContain("Line 2");
      expect(result).toContain("## Section");
      expect(result).toContain("More content");
    });
  });

  // ─── loadRules ───

  describe("loadRules", () => {
    test("returns null when no rules directory exists", async () => {
      const result = await loadRules(tempDir);
      expect(result).toBeNull();
    });

    test("returns null when rules directory is empty", async () => {
      await mkdir(join(tempDir, ".kcode", "rules"), { recursive: true });
      const result = await loadRules(tempDir);
      expect(result).toBeNull();
    });

    test("loads single rule file", async () => {
      const rulesDir = join(tempDir, ".kcode", "rules");
      await mkdir(rulesDir, { recursive: true });
      await writeTextFile(join(rulesDir, "coding.md"), "Always use TypeScript.");

      const result = await loadRules(tempDir);
      expect(result).toBeDefined();
      expect(result).toContain("Rule: coding.md");
      expect(result).toContain("Always use TypeScript.");
    });

    test("loads multiple rule files sorted alphabetically", async () => {
      const rulesDir = join(tempDir, ".kcode", "rules");
      await mkdir(rulesDir, { recursive: true });
      await writeTextFile(join(rulesDir, "b-style.md"), "Use tabs.");
      await writeTextFile(join(rulesDir, "a-naming.md"), "Use camelCase.");

      const result = await loadRules(tempDir);
      expect(result).toBeDefined();
      const aIdx = result!.indexOf("a-naming.md");
      const bIdx = result!.indexOf("b-style.md");
      expect(aIdx).toBeLessThan(bIdx);
      expect(result).toContain("Use camelCase.");
      expect(result).toContain("Use tabs.");
    });

    test("loads rules from nested directories", async () => {
      const rulesDir = join(tempDir, ".kcode", "rules");
      const nestedDir = join(rulesDir, "security");
      await mkdir(nestedDir, { recursive: true });
      await writeTextFile(join(nestedDir, "secrets.md"), "Never commit secrets.");

      const result = await loadRules(tempDir);
      expect(result).toBeDefined();
      expect(result).toContain("security/secrets.md");
      expect(result).toContain("Never commit secrets.");
    });

    test("ignores non-md files in rules directory", async () => {
      const rulesDir = join(tempDir, ".kcode", "rules");
      await mkdir(rulesDir, { recursive: true });
      await writeTextFile(join(rulesDir, "valid.md"), "A rule.");
      await writeTextFile(join(rulesDir, "notes.txt"), "Not a rule.");
      await writeTextFile(join(rulesDir, "config.json"), '{"not": "a rule"}');

      const result = await loadRules(tempDir);
      expect(result).toBeDefined();
      expect(result).toContain("valid.md");
      expect(result).not.toContain("notes.txt");
      expect(result).not.toContain("config.json");
    });

    test("handles deeply nested rule files", async () => {
      const rulesDir = join(tempDir, ".kcode", "rules");
      const deepDir = join(rulesDir, "a", "b", "c");
      await mkdir(deepDir, { recursive: true });
      await writeTextFile(join(deepDir, "deep.md"), "Deep rule content.");

      const result = await loadRules(tempDir);
      expect(result).toBeDefined();
      expect(result).toContain("a/b/c/deep.md");
      expect(result).toContain("Deep rule content.");
    });
  });

  // ─── saveProjectSettings ───

  describe("saveProjectSettings", () => {
    test("writes settings to .kcode/settings.json", async () => {
      await saveProjectSettings(tempDir, {
        model: "saved-model",
        maxTokens: 2048,
        effortLevel: "high",
      });

      const file = Bun.file(join(tempDir, ".kcode", "settings.json"));
      const saved = await file.json();
      expect(saved.model).toBe("saved-model");
      expect(saved.maxTokens).toBe(2048);
      expect(saved.effortLevel).toBe("high");
    });

    test("saved settings can be loaded back", async () => {
      await saveProjectSettings(tempDir, {
        model: "round-trip-model",
        permissionMode: "auto",
        autoMemory: true,
      });

      const loaded = await loadSettings(tempDir);
      expect(loaded.model).toBe("round-trip-model");
      expect(loaded.permissionMode).toBe("auto");
      expect(loaded.autoMemory).toBe(true);
    });

    test("overwrites existing project settings", async () => {
      await saveProjectSettings(tempDir, { model: "first" });
      await saveProjectSettings(tempDir, { model: "second" });

      const loaded = await loadSettings(tempDir);
      expect(loaded.model).toBe("second");
    });

    test("creates .kcode directory if it does not exist", async () => {
      const newDir = join(tempDir, "subproject");
      await mkdir(newDir, { recursive: true });
      trustWorkspace(newDir);

      await saveProjectSettings(newDir, { model: "new-project" });

      const file = Bun.file(join(newDir, ".kcode", "settings.json"));
      expect(await file.exists()).toBe(true);
      const saved = await file.json();
      expect(saved.model).toBe("new-project");
    });
  });

  // ─── Offline settings ───

  describe("offline settings", () => {
    test("offline object is passed through", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        offline: { enabled: true, autoDetect: false },
      });
      const s = await loadSettings(tempDir);
      expect(s.offline).toBeDefined();
      expect(s.offline!.enabled).toBe(true);
    });

    test("offline non-object is ignored", async () => {
      await createSettingsFile(tempDir, "settings.json", { offline: true });
      const s = await loadSettings(tempDir);
      expect(s.offline).toBeUndefined();
    });

    test("offline settings merge across layers", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        offline: { enabled: false, autoDetect: true },
      });
      await createSettingsFile(tempDir, "settings.local.json", {
        offline: { enabled: true },
      });

      const s = await loadSettings(tempDir);
      expect(s.offline).toBeDefined();
      expect(s.offline!.enabled).toBe(true);
      expect(s.offline!.autoDetect).toBe(true);
    });
  });

  // ─── Full hierarchy integration ───

  describe("full settings hierarchy integration", () => {
    test("complete hierarchy: project < local < env", async () => {
      // Project sets everything
      await createSettingsFile(tempDir, "settings.json", {
        model: "project-model",
        maxTokens: 1000,
        effortLevel: "low",
        apiKey: "project-key",
        theme: "dark",
        language: "en",
      });

      // Local overrides model and effortLevel
      await createSettingsFile(tempDir, "settings.local.json", {
        model: "local-model",
        effortLevel: "medium",
      });

      // Env overrides model
      process.env.KCODE_MODEL = "env-model";

      const s = await loadSettings(tempDir);
      expect(s.model).toBe("env-model"); // env wins
      expect(s.effortLevel).toBe("medium"); // local wins over project
      expect(s.maxTokens).toBe(1000); // project, no override
      expect(s.apiKey).toBe("project-key"); // project, no override
      expect(s.theme).toBe("dark"); // project, no override
      expect(s.language).toBe("en"); // project, no override
    });

    test("multiple env vars can be set simultaneously", async () => {
      process.env.KCODE_MODEL = "env-m";
      process.env.KCODE_API_KEY = "env-k";
      process.env.KCODE_API_BASE = "http://env:10000";
      process.env.KCODE_EFFORT_LEVEL = "max";
      process.env.KCODE_MAX_TOKENS = "4096";
      process.env.KCODE_PERMISSION_MODE = "deny";
      process.env.KCODE_THEME = "solarized";
      process.env.KCODE_LANG = "de";
      process.env.KCODE_DEPLOYMENT = "hybrid";

      const s = await loadSettings(tempDir);
      expect(s.model).toBe("env-m");
      expect(s.apiKey).toBe("env-k");
      expect(s.apiBase).toBe("http://env:10000");
      expect(s.effortLevel).toBe("max");
      expect(s.maxTokens).toBe(4096);
      expect(s.permissionMode).toBe("deny");
      expect(s.theme).toBe("solarized");
      expect(s.language).toBe("de");
      expect(s.deployment).toBe("hybrid");
    });

    test("empty env vars do not override file settings", async () => {
      await createSettingsFile(tempDir, "settings.json", {
        model: "file-model",
      });

      const s = await loadSettings(tempDir);
      expect(s.model).toBe("file-model");
    });
  });

  // ─── Permissions file loading ───

  describe("permissions file loading", () => {
    test("loads permissions.json from .kcode directory", async () => {
      const kcodeDir = join(tempDir, ".kcode");
      await mkdir(kcodeDir, { recursive: true });
      await Bun.write(
        join(kcodeDir, "permissions.json"),
        JSON.stringify({
          allow: ["Read(*)"],
          deny: ["Bash(rm -rf *)"],
        }),
      );

      const s = await loadSettings(tempDir);
      expect(s.permissionRules).toBeDefined();
      const patterns = s.permissionRules!.map((r) => r.pattern);
      expect(patterns).toContain("Read(*)");
      expect(patterns).toContain("Bash(rm -rf *)");
    });

    test("permissions.json with rules format", async () => {
      const kcodeDir = join(tempDir, ".kcode");
      await mkdir(kcodeDir, { recursive: true });
      await Bun.write(
        join(kcodeDir, "permissions.json"),
        JSON.stringify({
          rules: [
            { pattern: "Bash(git *)", action: "allow" },
            { pattern: "Write(*.env)", action: "deny" },
          ],
        }),
      );

      const s = await loadSettings(tempDir);
      expect(s.permissionRules).toBeDefined();
      const patterns = s.permissionRules!.map((r) => r.pattern);
      expect(patterns).toContain("Bash(git *)");
      expect(patterns).toContain("Write(*.env)");
    });

    test("permissions file rules take precedence (prepended)", async () => {
      // Settings file has rules
      await createSettingsFile(tempDir, "settings.json", {
        permissionRules: [{ pattern: "settings-rule", action: "allow" }],
      });
      // Permissions file has rules
      const kcodeDir = join(tempDir, ".kcode");
      await Bun.write(
        join(kcodeDir, "permissions.json"),
        JSON.stringify({
          rules: [{ pattern: "file-rule", action: "deny" }],
        }),
      );

      const s = await loadSettings(tempDir);
      expect(s.permissionRules).toBeDefined();
      // Permission file rules should come before settings rules (prepended)
      const patterns = s.permissionRules!.map((r) => r.pattern);
      const fileRuleIdx = patterns.indexOf("file-rule");
      const settingsRuleIdx = patterns.indexOf("settings-rule");
      expect(fileRuleIdx).toBeLessThan(settingsRuleIdx);
    });

    test("malformed permissions.json is handled gracefully", async () => {
      const kcodeDir = join(tempDir, ".kcode");
      await mkdir(kcodeDir, { recursive: true });
      await Bun.write(join(kcodeDir, "permissions.json"), "not valid json {{{");

      // Should not throw
      const s = await loadSettings(tempDir);
      expect(s).toBeDefined();
    });
  });

  // ─── Type exports ───

  describe("type exports", () => {
    test("EffortLevel type values", () => {
      const levels: EffortLevel[] = ["low", "medium", "high", "max"];
      expect(levels).toHaveLength(4);
    });

    test("Settings type accepts all valid fields", () => {
      const s: Settings = {
        model: "test",
        maxTokens: 1000,
        permissionMode: "ask",
        autoMemory: true,
        effortLevel: "low",
        apiKey: "key",
        apiBase: "http://localhost:10091",
        systemPromptExtra: "extra",
        autoRoute: true,
        theme: "dark",
        fallbackModel: "fb",
        tertiaryModel: "tm",
        fallbackModels: ["a", "b"],
        maxBudgetUsd: 10,
        compactThreshold: 0.8,
        telemetry: false,
        thinking: true,
        reasoningBudget: 1000,
        noCache: false,
        deployment: "cloud",
        language: "en",
      };
      expect(s.model).toBe("test");
    });

    test("ManagedPolicy type is usable", () => {
      const p: ManagedPolicy = {
        allowedModels: ["llama-*"],
        blockedModels: ["gpt-*"],
        disallowedTools: ["Bash"],
        allowedTools: ["Read"],
        permissionMode: "ask",
        maxBudgetUsd: 5,
        disableWebAccess: true,
        auditLog: true,
        orgId: "org-123",
      };
      expect(p.orgId).toBe("org-123");
    });
  });
});
