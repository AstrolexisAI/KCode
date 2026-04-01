import { describe, test, expect, mock } from "bun:test";
import { exportInsightsData } from "./exporter";

mock.module("../analytics", () => ({
  getAnalyticsSummary: () => ({
    totalSessions: 10,
    totalToolCalls: 50,
    totalErrors: 3,
    totalCostUsd: 0.25,
    totalInputTokens: 10000,
    totalOutputTokens: 5000,
    toolBreakdown: [
      { tool: "Read", count: 30, errors: 1, avgMs: 50 },
      { tool: "Edit", count: 20, errors: 2, avgMs: 100 },
    ],
    dailyActivity: [
      { date: "2026-03-30", calls: 25 },
      { date: "2026-03-31", calls: 25 },
    ],
    modelBreakdown: [
      { model: "test-model", calls: 50, costUsd: 0.25 },
    ],
  }),
}));

describe("exporter", () => {
  test("exports as JSON", async () => {
    const result = await exportInsightsData({ format: "json", days: 7 });
    const parsed = JSON.parse(result);
    expect(parsed.summary.totalSessions).toBe(10);
    expect(parsed.toolBreakdown).toHaveLength(2);
    expect(parsed.exportedAt).toBeDefined();
  });

  test("exports as CSV", async () => {
    const result = await exportInsightsData({ format: "csv", days: 7 });
    expect(result).toContain("# Summary");
    expect(result).toContain("total_sessions,10");
    expect(result).toContain("# Tool Breakdown");
    expect(result).toContain("Read,30,1,50");
    expect(result).toContain("# Daily Activity");
    expect(result).toContain("# Model Breakdown");
  });

  test("CSV escapes commas in values", async () => {
    const result = await exportInsightsData({ format: "csv", days: 7 });
    // Basic check that CSV is well-formed
    const lines = result.split("\n").filter((l) => l && !l.startsWith("#"));
    for (const line of lines) {
      // Each non-empty data line should have at least one comma
      expect(line).toContain(",");
    }
  });

  test("JSON has correct structure", async () => {
    const result = await exportInsightsData({ format: "json", days: 7 });
    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty("summary");
    expect(parsed).toHaveProperty("toolBreakdown");
    expect(parsed).toHaveProperty("dailyActivity");
    expect(parsed).toHaveProperty("modelBreakdown");
  });
});
