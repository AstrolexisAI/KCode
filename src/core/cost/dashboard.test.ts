// KCode - Cost Dashboard Renderer Tests

import { describe, expect, test } from "bun:test";
import { renderCostDashboard, renderCostDashboardJson } from "./dashboard";
import type { CostSummary } from "./types";

const mockSummary: CostSummary = {
  period: "month",
  totalCostUsd: 12.47,
  totalInputTokens: 1_200_000,
  totalOutputTokens: 340_000,
  sessions: 43,
  avgCostPerSession: 0.29,
  byModel: [
    { model: "claude-sonnet", costUsd: 8.2, percentage: 65.8 },
    { model: "local-llama", costUsd: 2.1, percentage: 16.8 },
    { model: "gpt-4o", costUsd: 1.5, percentage: 12.0 },
    { model: "deepseek-v3", costUsd: 0.67, percentage: 5.4 },
  ],
  byDay: [
    { date: "2026-03-01", costUsd: 0.45 },
    { date: "2026-03-02", costUsd: 0.82 },
    { date: "2026-03-03", costUsd: 0.33 },
  ],
  trend: "down",
  trendPercentage: 15,
};

describe("renderCostDashboard", () => {
  test("includes period label", () => {
    const output = renderCostDashboard(mockSummary);
    expect(output).toContain("Last 30 Days");
  });

  test("includes total cost", () => {
    const output = renderCostDashboard(mockSummary);
    expect(output).toContain("$12.47");
  });

  test("includes session count", () => {
    const output = renderCostDashboard(mockSummary);
    expect(output).toContain("43");
  });

  test("includes token counts", () => {
    const output = renderCostDashboard(mockSummary);
    expect(output).toContain("1.2M");
    expect(output).toContain("340K");
  });

  test("includes trend", () => {
    const output = renderCostDashboard(mockSummary);
    expect(output).toContain("15%");
  });

  test("includes model breakdown", () => {
    const output = renderCostDashboard(mockSummary);
    expect(output).toContain("claude-sonnet");
    expect(output).toContain("local-llama");
    expect(output).toContain("gpt-4o");
  });

  test("includes daily breakdown", () => {
    const output = renderCostDashboard(mockSummary);
    expect(output).toContain("03-01");
    expect(output).toContain("03-02");
  });

  test("handles empty summary", () => {
    const empty: CostSummary = {
      period: "today",
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      sessions: 0,
      avgCostPerSession: 0,
      byModel: [],
      byDay: [],
      trend: "stable",
      trendPercentage: 0,
    };
    const output = renderCostDashboard(empty);
    expect(output).toContain("$0.00");
    expect(output).toContain("0 sessions");
  });
});

describe("renderCostDashboardJson", () => {
  test("returns valid JSON", () => {
    const json = renderCostDashboardJson(mockSummary);
    const parsed = JSON.parse(json);
    expect(parsed.period).toBe("month");
    expect(parsed.totalCostUsd).toBe(12.47);
  });
});
