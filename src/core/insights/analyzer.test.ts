import { beforeEach, describe, expect, mock, test } from "bun:test";
import { analyzeInsights, formatInsights } from "./analyzer";

// Mock analytics
const mockSummary = {
  totalSessions: 55,
  totalToolCalls: 200,
  totalErrors: 15,
  totalCostUsd: 1.25,
  totalInputTokens: 50000,
  totalOutputTokens: 30000,
  toolBreakdown: [
    { tool: "Read", count: 80, errors: 2, avgMs: 50 },
    { tool: "Edit", count: 60, errors: 5, avgMs: 100 },
    { tool: "Bash", count: 40, errors: 15, avgMs: 3000 },
    { tool: "Grep", count: 15, errors: 0, avgMs: 200 },
    { tool: "Glob", count: 3, errors: 0, avgMs: 30 },
    { tool: "WebSearch", count: 2, errors: 1, avgMs: 8000 },
  ],
  dailyActivity: [
    { date: "2026-03-25", calls: 10 },
    { date: "2026-03-26", calls: 12 },
    { date: "2026-03-27", calls: 15 },
    { date: "2026-03-28", calls: 8 },
    { date: "2026-03-29", calls: 20 },
    { date: "2026-03-30", calls: 25 },
    { date: "2026-03-31", calls: 30 },
  ],
  modelBreakdown: [
    { model: "gpt-4", calls: 100, costUsd: 0.8 },
    { model: "llama-3", calls: 100, costUsd: 0.05 },
  ],
};

mock.module("../analytics", () => ({
  getAnalyticsSummary: () => mockSummary,
}));

describe("analyzeInsights", () => {
  test("generates insights from analytics", async () => {
    const insights = await analyzeInsights(30);
    expect(insights.length).toBeGreaterThan(0);
  });

  test("detects best cost model", async () => {
    const insights = await analyzeInsights(30);
    const costInsight = insights.find(
      (i) => i.type === "recommendation" && i.title.includes("cost"),
    );
    expect(costInsight).toBeDefined();
    expect(costInsight!.title).toContain("llama-3");
  });

  test("detects underused tools", async () => {
    const insights = await analyzeInsights(30);
    const underused = insights.find((i) => i.type === "pattern" && i.title.includes("rarely used"));
    expect(underused).toBeDefined();
  });

  test("detects high error rate", async () => {
    const insights = await analyzeInsights(30);
    const errorInsight = insights.find((i) => i.type === "alert" && i.title.includes("error rate"));
    expect(errorInsight).toBeDefined();
    expect(errorInsight!.title).toContain("Bash");
  });

  test("detects achievement milestone", async () => {
    const insights = await analyzeInsights(30);
    const achievement = insights.find((i) => i.type === "achievement");
    expect(achievement).toBeDefined();
    expect(achievement!.title).toContain("50+");
  });

  test("sorts by priority (high first)", async () => {
    const insights = await analyzeInsights(30);
    const priorities = insights.map((i) => i.priority);
    const order = { high: 3, medium: 2, low: 1 };
    for (let i = 1; i < priorities.length; i++) {
      expect(order[priorities[i]]).toBeLessThanOrEqual(order[priorities[i - 1]]);
    }
  });

  test("includes token usage summary", async () => {
    const insights = await analyzeInsights(30);
    const tokenInsight = insights.find((i) => i.title.includes("tokens used"));
    expect(tokenInsight).toBeDefined();
  });
});

describe("formatInsights", () => {
  test("formats insights as text", async () => {
    const insights = await analyzeInsights(30);
    const output = formatInsights(insights);
    expect(output).toContain("Insights");
    expect(output.length).toBeGreaterThan(50);
  });

  test("handles empty insights", () => {
    const output = formatInsights([]);
    expect(output).toContain("No insights");
  });
});
