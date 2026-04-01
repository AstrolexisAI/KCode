// KCode - ROI Tracking
// Estimates return on investment from AI-assisted development.

import { getAnalyticsSummary } from "../analytics";
import { charts } from "./charts";
import type { ROIMetrics } from "./types";

// Estimated minutes saved per tool call by category
const TIME_SAVINGS_MAP: Record<string, number> = {
  Edit: 3,
  MultiEdit: 3,
  Write: 5,
  Bash: 2,
  Grep: 1,
  GrepReplace: 1,
  Glob: 0.5,
  Read: 1,
  LS: 0.5,
  WebSearch: 3,
  WebFetch: 2,
  Agent: 15,
  Skill: 15,
  TestRunner: 2,
  GitCommit: 1,
  GitStatus: 0.5,
  GitLog: 0.5,
  DiffView: 1,
  Rename: 1,
  PlanMode: 2,
  Clipboard: 0.5,
  Undo: 1,
  Stash: 1,
};

const DEFAULT_MINUTES_SAVED = 1;

/**
 * Calculate ROI metrics for a given period.
 *
 * @param config.hourlyRate - Developer hourly rate in USD
 * @param config.period - Number of days to analyze
 */
export async function calculateROI(config: {
  hourlyRate: number;
  period: number;
}): Promise<ROIMetrics> {
  const analytics = getAnalyticsSummary(config.period);

  // Calculate time saved per tool category
  const toolTimeSavings: Array<{ category: string; timeSavedMinutes: number }> = [];

  for (const tool of analytics.toolBreakdown) {
    const minutesPerCall = TIME_SAVINGS_MAP[tool.tool] ?? DEFAULT_MINUTES_SAVED;
    const totalMinutes = tool.count * minutesPerCall;
    toolTimeSavings.push({
      category: tool.tool,
      timeSavedMinutes: totalMinutes,
    });
  }

  // Sort descending by time saved
  toolTimeSavings.sort((a, b) => b.timeSavedMinutes - a.timeSavedMinutes);

  const totalMinutesSaved = toolTimeSavings.reduce((sum, t) => sum + t.timeSavedMinutes, 0);
  const hoursSaved = totalMinutesSaved / 60;
  const valueUsd = hoursSaved * config.hourlyRate;
  const totalCostUsd = analytics.totalCostUsd;

  // Calculate ROI percentage: (value - cost) / cost * 100
  // If cost is 0, ROI is 0 (cannot divide by zero; free usage has no measurable ROI)
  const roi = totalCostUsd > 0 ? ((valueUsd - totalCostUsd) / totalCostUsd) * 100 : 0;

  const topTimeSavers = toolTimeSavings.map((t) => ({
    category: t.category,
    timeSavedHours: t.timeSavedMinutes / 60,
  }));

  return {
    totalCostUsd,
    estimatedTimeSavedHours: hoursSaved,
    estimatedValueUsd: valueUsd,
    roi,
    topTimeSavers,
  };
}

/**
 * Format ROI metrics as a readable ASCII report.
 */
export function formatROI(metrics: ROIMetrics): string {
  const lines: string[] = ["  ROI Report\n"];

  // Summary table
  lines.push(
    charts.table(
      ["Metric", "Value"],
      [
        ["Total Cost", `$${metrics.totalCostUsd.toFixed(2)}`],
        ["Estimated Hours Saved", `${metrics.estimatedTimeSavedHours.toFixed(1)}h`],
        ["Estimated Value", `$${metrics.estimatedValueUsd.toFixed(2)}`],
        ["ROI", `${metrics.roi.toFixed(1)}%`],
      ],
    ),
  );

  lines.push("");

  // ROI status
  if (metrics.roi > 0) {
    lines.push(`  Net gain: $${(metrics.estimatedValueUsd - metrics.totalCostUsd).toFixed(2)}`);
  } else if (metrics.totalCostUsd === 0) {
    lines.push("  No cost data available (local models or free tier).");
  } else {
    lines.push(`  Net loss: $${(metrics.totalCostUsd - metrics.estimatedValueUsd).toFixed(2)}`);
  }

  lines.push("");

  // Top 5 time savers bar chart
  const topSavers = metrics.topTimeSavers.slice(0, 5);
  if (topSavers.length > 0) {
    lines.push("  Top Time Savers:\n");
    lines.push(
      charts.barChart(
        topSavers.map((t) => ({
          label: t.category,
          value: Math.round(t.timeSavedHours * 60),
        })),
        { width: 30, showValue: true },
      ),
    );
    lines.push("\n  (values in minutes saved)");
  }

  return lines.join("\n");
}
