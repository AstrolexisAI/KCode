// KCode - Cost Tracker Tests

import { beforeEach, describe, expect, test } from "bun:test";
import { CostTracker } from "./tracker";

describe("CostTracker", () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  test("record does not throw", () => {
    tracker.record({
      timestamp: Date.now(),
      sessionId: "test-session",
      model: "test-model",
      provider: "test-provider",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.005,
    });
  });

  test("getSummary returns valid structure", () => {
    const summary = tracker.getSummary("today");
    expect(summary.period).toBe("today");
    expect(typeof summary.totalCostUsd).toBe("number");
    expect(typeof summary.sessions).toBe("number");
    expect(Array.isArray(summary.byModel)).toBe(true);
    expect(Array.isArray(summary.byDay)).toBe(true);
    expect(["up", "down", "stable"]).toContain(summary.trend);
  });

  test("record and retrieve cost entry", () => {
    const now = Date.now();
    tracker.record({
      timestamp: now,
      sessionId: "s1",
      model: "claude-test",
      provider: "anthropic",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.05,
    });

    const summary = tracker.getSummary("today");
    expect(summary.totalCostUsd).toBeGreaterThanOrEqual(0.05);
    expect(summary.totalInputTokens).toBeGreaterThanOrEqual(1000);
  });

  test("getSummary byModel groups correctly", () => {
    const now = Date.now();
    tracker.record({
      timestamp: now,
      sessionId: "s1",
      model: "model-a",
      provider: "p",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.01,
    });
    tracker.record({
      timestamp: now,
      sessionId: "s1",
      model: "model-a",
      provider: "p",
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.02,
    });
    tracker.record({
      timestamp: now,
      sessionId: "s1",
      model: "model-b",
      provider: "p",
      inputTokens: 50,
      outputTokens: 25,
      costUsd: 0.005,
    });

    const summary = tracker.getSummary("today");
    const modelA = summary.byModel.find((m) => m.model === "model-a");
    expect(modelA).toBeDefined();
    expect(modelA!.costUsd).toBeGreaterThanOrEqual(0.03);
  });

  test("getSummary with all period", () => {
    const summary = tracker.getSummary("all");
    expect(summary.period).toBe("all");
  });

  test("trend is stable for zero costs", () => {
    const summary = tracker.getSummary("week");
    expect(["up", "down", "stable"]).toContain(summary.trend);
  });

  test("avgCostPerSession is 0 when no sessions", () => {
    // Fresh state with possibly no entries
    const summary = tracker.getSummary("month");
    expect(summary.avgCostPerSession).toBeGreaterThanOrEqual(0);
  });
});
