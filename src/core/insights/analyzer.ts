// KCode - Insights Analyzer
// Generates actionable insights from analytics data.

import type { Insight } from "./types";
import { getAnalyticsSummary } from "../analytics";

export async function analyzeInsights(period: number = 30): Promise<Insight[]> {
  const insights: Insight[] = [];
  const analytics = getAnalyticsSummary(period);

  if (analytics.totalToolCalls === 0) {
    insights.push({
      type: "pattern",
      title: "No activity recorded",
      description: `No tool usage data found for the last ${period} days. Enable telemetry with /telemetry to track usage.`,
      priority: "medium",
    });
    return insights;
  }

  // 1. Best cost/quality model
  if (analytics.modelBreakdown.length > 1) {
    const modelsWithCost = analytics.modelBreakdown.filter((m) => m.costUsd > 0);
    if (modelsWithCost.length > 1) {
      const sorted = [...modelsWithCost].sort(
        (a, b) => a.costUsd / a.calls - b.costUsd / b.calls,
      );
      const cheapest = sorted[0];
      insights.push({
        type: "recommendation",
        title: `${cheapest.model} has the best cost efficiency`,
        description: `$${(cheapest.costUsd / cheapest.calls).toFixed(4)} per call across ${cheapest.calls} calls`,
        data: { model: cheapest.model, costPerCall: cheapest.costUsd / cheapest.calls },
        priority: "medium",
      });
    }
  }

  // 2. Underused tools
  const underused = analytics.toolBreakdown.filter((t) => t.count < 5);
  if (underused.length > 0 && analytics.toolBreakdown.length > 5) {
    insights.push({
      type: "pattern",
      title: `${underused.length} tools rarely used`,
      description: `These tools had fewer than 5 calls: ${underused.map((t) => t.tool).join(", ")}`,
      data: { tools: underused.map((t) => t.tool) },
      priority: "low",
    });
  }

  // 3. High error rate tools
  for (const tool of analytics.toolBreakdown) {
    if (tool.count >= 10) {
      const errorRate = tool.errors / tool.count;
      if (errorRate > 0.3) {
        insights.push({
          type: "alert",
          title: `${tool.tool} has ${Math.round(errorRate * 100)}% error rate`,
          description: `${tool.errors} errors in ${tool.count} executions (avg ${tool.avgMs}ms)`,
          data: { tool: tool.tool, errorRate, errors: tool.errors, calls: tool.count },
          priority: "high",
        });
      }
    }
  }

  // 4. Achievements
  const milestones = [10, 50, 100, 500, 1000, 5000];
  for (const milestone of milestones) {
    if (
      analytics.totalSessions >= milestone &&
      analytics.totalSessions < milestone * 2
    ) {
      insights.push({
        type: "achievement",
        title: `${milestone}+ sessions completed`,
        description: `You've used KCode in ${analytics.totalSessions} sessions. Keep going!`,
        priority: "low",
      });
      break;
    }
  }

  // 5. Usage trend
  if (analytics.dailyActivity.length >= 14) {
    const sorted = [...analytics.dailyActivity].sort(
      (a, b) => a.date.localeCompare(b.date),
    );
    const firstHalf = sorted.slice(0, 7).reduce((s, d) => s + d.calls, 0);
    const secondHalf = sorted.slice(-7).reduce((s, d) => s + d.calls, 0);
    if (firstHalf > 0 && secondHalf > firstHalf * 1.5) {
      insights.push({
        type: "pattern",
        title: "Usage is growing",
        description: `Your usage increased ${Math.round((secondHalf / firstHalf - 1) * 100)}% this week compared to last`,
        priority: "low",
      });
    } else if (firstHalf > 0 && secondHalf < firstHalf * 0.5) {
      insights.push({
        type: "pattern",
        title: "Usage is declining",
        description: `Your usage decreased ${Math.round((1 - secondHalf / firstHalf) * 100)}% this week`,
        priority: "low",
      });
    }
  }

  // 6. Cost spike detection
  if (analytics.dailyActivity.length >= 7) {
    const totalCalls = analytics.dailyActivity.reduce((s, d) => s + d.calls, 0);
    const avgCalls = totalCalls / analytics.dailyActivity.length;
    const spikeDays = analytics.dailyActivity.filter(
      (d) => d.calls > avgCalls * 2.5,
    );
    if (spikeDays.length > 0) {
      insights.push({
        type: "alert",
        title: `Usage spikes detected on ${spikeDays.length} day(s)`,
        description: `Average: ${Math.round(avgCalls)} calls/day. Spikes: ${spikeDays.map((d) => `${d.date} (${d.calls})`).join(", ")}`,
        priority: "medium",
      });
    }
  }

  // 7. Slowest tools
  const slowTools = analytics.toolBreakdown
    .filter((t) => t.count >= 5 && t.avgMs > 5000)
    .sort((a, b) => b.avgMs - a.avgMs);
  if (slowTools.length > 0) {
    insights.push({
      type: "pattern",
      title: `${slowTools.length} tools averaging >5s`,
      description: slowTools
        .slice(0, 3)
        .map((t) => `${t.tool}: ${(t.avgMs / 1000).toFixed(1)}s avg`)
        .join(", "),
      priority: "low",
    });
  }

  // 8. Token usage summary
  const totalTokens = analytics.totalInputTokens + analytics.totalOutputTokens;
  if (totalTokens > 0) {
    const inputPct = Math.round(
      (analytics.totalInputTokens / totalTokens) * 100,
    );
    insights.push({
      type: "pattern",
      title: `${totalTokens.toLocaleString()} tokens used`,
      description: `${inputPct}% input, ${100 - inputPct}% output. Cost: $${analytics.totalCostUsd.toFixed(4)}`,
      priority: "low",
    });
  }

  // Sort by priority
  const priorityOrder = { high: 3, medium: 2, low: 1 };
  return insights.sort(
    (a, b) => priorityOrder[b.priority] - priorityOrder[a.priority],
  );
}

export function formatInsights(insights: Insight[]): string {
  if (insights.length === 0) {
    return "  No insights available. Enable telemetry to start tracking.";
  }

  const lines: string[] = ["  Insights\n"];

  const icons = {
    recommendation: "\u2605",
    pattern: "\u2261",
    alert: "\u26a0",
    achievement: "\u2606",
  };

  const priorityColors = {
    high: "!",
    medium: "*",
    low: " ",
  };

  for (const insight of insights) {
    const icon = icons[insight.type] || "\u2022";
    const prio = priorityColors[insight.priority];
    lines.push(`  ${icon}${prio} ${insight.title}`);
    lines.push(`    ${insight.description}`);
    lines.push("");
  }

  return lines.join("\n");
}
