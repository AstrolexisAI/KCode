// KCode - Model Comparison

import type { ModelComparison } from "./types";
import { getAnalyticsSummary } from "../analytics";
import { charts } from "./charts";

export async function compareModels(period: number = 30): Promise<ModelComparison[]> {
  const analytics = getAnalyticsSummary(period);

  if (analytics.modelBreakdown.length === 0) return [];

  const results: ModelComparison[] = [];

  for (const model of analytics.modelBreakdown) {
    const toolsForModel = analytics.toolBreakdown;
    const totalToolCalls = toolsForModel.reduce((s, t) => s + t.count, 0);
    const totalErrors = toolsForModel.reduce((s, t) => s + t.errors, 0);
    const avgLatency =
      totalToolCalls > 0
        ? toolsForModel.reduce((s, t) => s + t.avgMs * t.count, 0) /
          totalToolCalls
        : 0;

    // Estimate sessions per model proportionally
    const sessionProportion = model.calls / analytics.totalToolCalls;
    const sessions = Math.max(
      1,
      Math.round(analytics.totalSessions * sessionProportion),
    );

    const avgTokens =
      sessions > 0
        ? Math.round(
            ((analytics.totalInputTokens + analytics.totalOutputTokens) *
              sessionProportion) /
              sessions,
          )
        : 0;

    results.push({
      model: model.model,
      sessions,
      avgTokensPerSession: avgTokens,
      avgCostPerSession:
        sessions > 0 ? model.costUsd / sessions : 0,
      avgLatencyMs: Math.round(avgLatency),
      successRate:
        totalToolCalls > 0
          ? 1 - totalErrors / totalToolCalls
          : 1,
      toolCallsPerSession:
        sessions > 0 ? Math.round(model.calls / sessions) : 0,
    });
  }

  // Sort by composite score (higher is better)
  return results.sort((a, b) => {
    const scoreA = computeScore(a);
    const scoreB = computeScore(b);
    return scoreB - scoreA;
  });
}

function computeScore(m: ModelComparison): number {
  const costFactor = m.avgCostPerSession > 0 ? 1 / m.avgCostPerSession : 1;
  const speedFactor = m.avgLatencyMs > 0 ? 1000 / m.avgLatencyMs : 1;
  return m.successRate * costFactor * speedFactor;
}

export function formatModelComparison(models: ModelComparison[]): string {
  if (models.length === 0) {
    return "  No model data available.";
  }

  const lines: string[] = ["  Model Comparison\n"];

  // Table
  lines.push(
    charts.table(
      ["Model", "Sessions", "Avg Tokens", "Avg Cost", "Latency", "Success"],
      models.map((m) => [
        m.model,
        String(m.sessions),
        m.avgTokensPerSession.toLocaleString(),
        `$${m.avgCostPerSession.toFixed(4)}`,
        `${m.avgLatencyMs}ms`,
        `${(m.successRate * 100).toFixed(1)}%`,
      ]),
    ),
  );

  // Cost bar chart
  if (models.some((m) => m.avgCostPerSession > 0)) {
    lines.push("\n  Cost per session:");
    lines.push(
      charts.barChart(
        models.map((m) => ({
          label: m.model,
          value: Math.round(m.avgCostPerSession * 10000),
        })),
        { width: 30, showValue: true },
      ),
    );
  }

  // Success rate bar chart
  lines.push("\n  Success rate:");
  lines.push(
    charts.barChart(
      models.map((m) => ({
        label: m.model,
        value: Math.round(m.successRate * 100),
      })),
      { width: 30, showValue: true },
    ),
  );

  return lines.join("\n");
}
