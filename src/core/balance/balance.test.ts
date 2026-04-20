import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { providerFromModel } from "./provider";

describe("providerFromModel", () => {
  test("claude-* maps to anthropic", () => {
    expect(providerFromModel("claude-sonnet-4-6")).toBe("anthropic");
    expect(providerFromModel("claude-opus-4-6")).toBe("anthropic");
  });

  test("grok-* maps to xai", () => {
    expect(providerFromModel("grok-4")).toBe("xai");
    expect(providerFromModel("grok-code-fast-1")).toBe("xai");
  });

  test("gpt-*, o1, o3, o4-mini map to openai", () => {
    expect(providerFromModel("gpt-4o")).toBe("openai");
    expect(providerFromModel("gpt-4o-mini")).toBe("openai");
    expect(providerFromModel("o4-mini")).toBe("openai");
  });

  test("gemini-* maps to google", () => {
    expect(providerFromModel("gemini-2.5-pro")).toBe("google");
  });

  test("deepseek-* maps to deepseek", () => {
    expect(providerFromModel("deepseek-chat")).toBe("deepseek");
  });

  test("local / unknown names are null", () => {
    expect(providerFromModel("mnemo:mark6-31b")).toBe(null);
    expect(providerFromModel("llama3")).toBe(null);
    expect(providerFromModel("unknown-model")).toBe(null);
  });

  test("base URL beats model-name heuristic", () => {
    expect(providerFromModel("custom-name", "https://api.anthropic.com")).toBe("anthropic");
    expect(providerFromModel("custom-name", "https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(providerFromModel("custom-name", "https://api.x.ai")).toBe("xai");
  });
});

describe("balance store + recordSpend", () => {
  beforeEach(() => {
    // Re-home KCODE_HOME for each test so the on-disk balance.json is
    // isolated per case. paths.ts reads KCODE_HOME at call time, so no
    // module-cache invalidation is needed.
    const dir = mkdtempSync(join(tmpdir(), "kcode-balance-test-"));
    process.env.KCODE_HOME = dir;
  });

  test("setStarting + recordSpend updates spent and computes remaining", async () => {
    const { setStarting, recordSpend, getStatus } = await import("./index");
    await setStarting("xai", 100);
    const alert = await recordSpend("grok-4", "https://api.x.ai/v1", 7.5);
    expect(alert).toBe(null); // still 92.5% remaining, above thresholds

    const status = await getStatus("xai");
    expect(status).not.toBeNull();
    expect(status!.starting).toBe(100);
    expect(status!.spent).toBeCloseTo(7.5, 5);
    expect(status!.remaining).toBeCloseTo(92.5, 5);
    expect(status!.fractionRemaining).toBeCloseTo(0.925, 3);
  });

  test("recordSpend fires the 20% threshold once, not again for smaller spends", async () => {
    const { setStarting, recordSpend } = await import("./index");
    await setStarting("xai", 100);
    // Climb to 85 spent → 15% remaining → crosses 20% threshold.
    const first = await recordSpend("grok-4", undefined, 85);
    expect(first).not.toBe(null);
    expect(first!.fraction).toBe(0.2);
    expect(first!.remaining).toBeCloseTo(15, 3);

    // Another small spend — still above 5% — should NOT re-fire 20%.
    const second = await recordSpend("grok-4", undefined, 1);
    expect(second).toBe(null);
  });

  test("crossing the 5% threshold after 20% fires again", async () => {
    const { setStarting, recordSpend } = await import("./index");
    await setStarting("xai", 100);
    const a20 = await recordSpend("grok-4", undefined, 85); // 20% alert
    expect(a20!.fraction).toBe(0.2);

    const a5 = await recordSpend("grok-4", undefined, 12); // now 3% left → 5% alert
    expect(a5).not.toBe(null);
    expect(a5!.fraction).toBe(0.05);
  });

  test("no alert when starting is null (spend-only mode)", async () => {
    const { recordSpend } = await import("./index");
    // Don't call setStarting at all — provider gets auto-created on spend.
    const alert = await recordSpend("grok-4", undefined, 50);
    expect(alert).toBe(null);
  });

  test("resetSpent zeros spent and re-enables alerts", async () => {
    const { setStarting, recordSpend, resetSpent, getStatus } = await import("./index");
    await setStarting("xai", 100);
    await recordSpend("grok-4", undefined, 85); // fires 20%
    await resetSpent("xai");
    const status = await getStatus("xai");
    expect(status!.spent).toBe(0);
    // After reset, the 20% threshold should be eligible to fire again.
    const alert = await recordSpend("grok-4", undefined, 85);
    expect(alert).not.toBe(null);
    expect(alert!.fraction).toBe(0.2);
  });

  test("local model spend is ignored", async () => {
    const { setStarting, recordSpend, getStatus } = await import("./index");
    await setStarting("xai", 100);
    const alert = await recordSpend("mnemo:mark6-31b", "http://localhost:8090", 999);
    expect(alert).toBe(null);
    const status = await getStatus("xai");
    expect(status!.spent).toBe(0); // untouched
  });
});
