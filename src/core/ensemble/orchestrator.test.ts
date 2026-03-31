// KCode - Ensemble Orchestrator Tests

import { test, expect, describe, beforeEach } from "bun:test";
import { EnsembleOrchestrator, createEnsembleFromSettings } from "./orchestrator";
import type { ModelExecutor, EnsembleConfig } from "./types";

// ─── Helpers ────────────────────────────────────────────────────

function makeMockExecutor(responses?: Record<string, string>): ModelExecutor {
  const defaults: Record<string, string> = {
    "model-a": "Response from model A.",
    "model-b": "Response from model B is more detailed and comprehensive with examples.",
    "model-c": "Response from model C.",
    ...responses,
  };

  return {
    execute: async (model) => ({
      content: defaults[model] ?? `Response from ${model}`,
      tokensUsed: 20,
      durationMs: 50,
    }),
  };
}

function makeOrchestrator(
  overrides?: Partial<EnsembleConfig> & { enabled?: boolean },
  executor?: ModelExecutor,
): EnsembleOrchestrator {
  return new EnsembleOrchestrator(
    executor ?? makeMockExecutor(),
    {
      enabled: true,
      models: ["model-a", "model-b", "model-c"],
      strategy: "best-of-n",
      maxParallel: 3,
      timeout: 5000,
      minResponses: 2,
      triggerOn: "always",
      ...overrides,
    },
  );
}

// ─── Enable / Disable ───────────────────────────────────────────

describe("EnsembleOrchestrator - enable/disable", () => {
  test("isEnabled returns false by default (no enabled flag)", () => {
    const orch = new EnsembleOrchestrator(makeMockExecutor());
    expect(orch.isEnabled()).toBe(false);
  });

  test("isEnabled returns true when enabled with models", () => {
    const orch = makeOrchestrator({ enabled: true });
    expect(orch.isEnabled()).toBe(true);
  });

  test("isEnabled returns false when enabled but fewer than 2 models", () => {
    const orch = makeOrchestrator({ enabled: true, models: ["only-one"] });
    expect(orch.isEnabled()).toBe(false);
  });

  test("enable() activates ensemble", () => {
    const orch = makeOrchestrator({ enabled: false });
    expect(orch.isEnabled()).toBe(false);
    orch.enable();
    expect(orch.isEnabled()).toBe(true);
  });

  test("disable() deactivates ensemble", () => {
    const orch = makeOrchestrator({ enabled: true });
    expect(orch.isEnabled()).toBe(true);
    orch.disable();
    expect(orch.isEnabled()).toBe(false);
  });
});

// ─── Configuration ──────────────────────────────────────────────

describe("EnsembleOrchestrator - configuration", () => {
  test("getConfig returns current configuration", () => {
    const orch = makeOrchestrator({ timeout: 30000 });
    const config = orch.getConfig();
    expect(config.timeout).toBe(30000);
    expect(config.models.length).toBe(3);
  });

  test("updateConfig merges partial updates", () => {
    const orch = makeOrchestrator();
    orch.updateConfig({ timeout: 10000, strategy: "verify" });
    const config = orch.getConfig();
    expect(config.timeout).toBe(10000);
    expect(config.strategy).toBe("verify");
    expect(config.models.length).toBe(3); // Unchanged
  });

  test("getConfig returns a copy (not a reference)", () => {
    const orch = makeOrchestrator();
    const config = orch.getConfig();
    (config as any).timeout = 99999;
    expect(orch.getConfig().timeout).not.toBe(99999);
  });
});

// ─── Trigger Logic ──────────────────────────────────────────────

describe("EnsembleOrchestrator - shouldTrigger", () => {
  test("always trigger mode → returns true for any message", () => {
    const orch = makeOrchestrator({ triggerOn: "always" });
    expect(orch.shouldTrigger("hello")).toBe(true);
    expect(orch.shouldTrigger("implement a function")).toBe(true);
  });

  test("complex trigger mode → true for reasoning tasks", () => {
    const orch = makeOrchestrator({ triggerOn: "complex" });
    expect(orch.shouldTrigger("why does this fail")).toBe(true);
    expect(orch.shouldTrigger("explain why the test breaks")).toBe(true);
  });

  test("complex trigger mode → true for code tasks", () => {
    const orch = makeOrchestrator({ triggerOn: "complex" });
    expect(orch.shouldTrigger("refactor the auth module")).toBe(true);
    expect(orch.shouldTrigger("implement a REST API")).toBe(true);
  });

  test("complex trigger mode → false for simple tasks", () => {
    const orch = makeOrchestrator({ triggerOn: "complex" });
    expect(orch.shouldTrigger("show git status")).toBe(false);
    expect(orch.shouldTrigger("hello")).toBe(false);
  });

  test("manual trigger mode → always returns false", () => {
    const orch = makeOrchestrator({ triggerOn: "manual" });
    expect(orch.shouldTrigger("refactor everything")).toBe(false);
    expect(orch.shouldTrigger("analyze the system")).toBe(false);
  });

  test("returns false when ensemble is disabled", () => {
    const orch = makeOrchestrator({ enabled: false, triggerOn: "always" });
    expect(orch.shouldTrigger("anything")).toBe(false);
  });
});

// ─── Execution ──────────────────────────────────────────────────

describe("EnsembleOrchestrator - run", () => {
  test("runs ensemble and returns result", async () => {
    const orch = makeOrchestrator();
    const result = await orch.run([
      { role: "user", content: "What is TypeScript?" },
    ]);

    expect(result.strategy).toBe("best-of-n");
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    expect(result.finalResponse.length).toBeGreaterThan(0);
  });

  test("throws when ensemble is not enabled", async () => {
    const orch = makeOrchestrator({ enabled: false });
    await expect(
      orch.run([{ role: "user", content: "test" }]),
    ).rejects.toThrow(/not enabled/);
  });

  test("throws when fewer than 2 models", async () => {
    const orch = makeOrchestrator({ enabled: true, models: ["single"] });
    await expect(
      orch.run([{ role: "user", content: "test" }]),
    ).rejects.toThrow(/not enabled/);
  });
});

// ─── tryRun ─────────────────────────────────────────────────────

describe("EnsembleOrchestrator - tryRun", () => {
  test("returns result when trigger conditions are met", async () => {
    const orch = makeOrchestrator({ triggerOn: "always" });
    const result = await orch.tryRun(
      [{ role: "user", content: "test" }],
      "test",
    );
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("best-of-n");
  });

  test("returns null when trigger conditions are not met", async () => {
    const orch = makeOrchestrator({ triggerOn: "manual" });
    const result = await orch.tryRun(
      [{ role: "user", content: "test" }],
      "test",
    );
    expect(result).toBeNull();
  });

  test("returns null when ensemble is disabled", async () => {
    const orch = makeOrchestrator({ enabled: false, triggerOn: "always" });
    const result = await orch.tryRun(
      [{ role: "user", content: "test" }],
      "test",
    );
    expect(result).toBeNull();
  });
});

// ─── setExecutor ────────────────────────────────────────────────

describe("EnsembleOrchestrator - setExecutor", () => {
  test("swaps the executor at runtime", async () => {
    const orch = makeOrchestrator();

    const newExecutor = makeMockExecutor({
      "model-a": "New A",
      "model-b": "New B with more detail and comprehensive information.",
      "model-c": "New C",
    });
    orch.setExecutor(newExecutor);

    const result = await orch.run([{ role: "user", content: "test" }]);
    expect(result.candidates.some(c => c.response.startsWith("New"))).toBe(true);
  });
});

// ─── createEnsembleFromSettings ─────────────────────────────────

describe("createEnsembleFromSettings", () => {
  test("creates orchestrator from valid settings", () => {
    const orch = createEnsembleFromSettings(
      {
        enabled: true,
        strategy: "verify",
        models: ["model-x", "model-y"],
        maxParallel: 2,
        timeout: 30000,
        minResponses: 1,
        triggerOn: "complex",
      },
      makeMockExecutor(),
    );

    expect(orch.isEnabled()).toBe(true);
    const config = orch.getConfig();
    expect(config.strategy).toBe("verify");
    expect(config.models).toEqual(["model-x", "model-y"]);
    expect(config.maxParallel).toBe(2);
    expect(config.timeout).toBe(30000);
    expect(config.triggerOn).toBe("complex");
  });

  test("creates disabled orchestrator from null settings", () => {
    const orch = createEnsembleFromSettings(null, makeMockExecutor());
    expect(orch.isEnabled()).toBe(false);
  });

  test("creates disabled orchestrator from undefined settings", () => {
    const orch = createEnsembleFromSettings(undefined, makeMockExecutor());
    expect(orch.isEnabled()).toBe(false);
  });

  test("filters non-string models from array", () => {
    const orch = createEnsembleFromSettings(
      {
        enabled: true,
        models: ["valid", 123, null, "also-valid"],
      },
      makeMockExecutor(),
    );

    const config = orch.getConfig();
    expect(config.models).toEqual(["valid", "also-valid"]);
  });

  test("uses defaults for missing fields", () => {
    const orch = createEnsembleFromSettings(
      { enabled: true, models: ["a", "b"] },
      makeMockExecutor(),
    );

    const config = orch.getConfig();
    expect(config.strategy).toBe("best-of-n"); // default
    expect(config.maxParallel).toBe(3); // default
    expect(config.timeout).toBe(60000); // default
    expect(config.minResponses).toBe(2); // default
  });

  test("parses judgeModel when present", () => {
    const orch = createEnsembleFromSettings(
      {
        enabled: true,
        models: ["a", "b"],
        judgeModel: "big-model",
      },
      makeMockExecutor(),
    );

    expect(orch.getConfig().judgeModel).toBe("big-model");
  });
});
