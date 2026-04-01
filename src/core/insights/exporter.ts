// KCode - Analytics Data Exporter

import { getAnalyticsSummary } from "../analytics";
import type { ExportOptions } from "./types";

export async function exportInsightsData(options: ExportOptions): Promise<string> {
  const summary = getAnalyticsSummary(options.days);

  let content: string;
  if (options.format === "csv") {
    content = exportAsCsv(summary);
  } else {
    content = exportAsJson(summary);
  }

  if (options.output) {
    await Bun.write(options.output, content);
    return options.output;
  }

  return content;
}

function exportAsJson(summary: ReturnType<typeof getAnalyticsSummary>): string {
  return JSON.stringify(
    {
      summary: {
        totalSessions: summary.totalSessions,
        totalToolCalls: summary.totalToolCalls,
        totalErrors: summary.totalErrors,
        totalCostUsd: summary.totalCostUsd,
        totalInputTokens: summary.totalInputTokens,
        totalOutputTokens: summary.totalOutputTokens,
      },
      toolBreakdown: summary.toolBreakdown,
      dailyActivity: summary.dailyActivity,
      modelBreakdown: summary.modelBreakdown,
      exportedAt: new Date().toISOString(),
    },
    null,
    2,
  );
}

function exportAsCsv(summary: ReturnType<typeof getAnalyticsSummary>): string {
  const sections: string[] = [];

  // Summary section
  sections.push("# Summary");
  sections.push("metric,value");
  sections.push(`total_sessions,${summary.totalSessions}`);
  sections.push(`total_tool_calls,${summary.totalToolCalls}`);
  sections.push(`total_errors,${summary.totalErrors}`);
  sections.push(`total_cost_usd,${summary.totalCostUsd}`);
  sections.push(`total_input_tokens,${summary.totalInputTokens}`);
  sections.push(`total_output_tokens,${summary.totalOutputTokens}`);

  // Tool breakdown
  sections.push("");
  sections.push("# Tool Breakdown");
  sections.push("tool,count,errors,avg_ms");
  for (const t of summary.toolBreakdown) {
    sections.push(`${escapeCsv(t.tool)},${t.count},${t.errors},${t.avgMs}`);
  }

  // Daily activity
  sections.push("");
  sections.push("# Daily Activity");
  sections.push("date,calls");
  for (const d of summary.dailyActivity) {
    sections.push(`${d.date},${d.calls}`);
  }

  // Model breakdown
  sections.push("");
  sections.push("# Model Breakdown");
  sections.push("model,calls,cost_usd");
  for (const m of summary.modelBreakdown) {
    sections.push(`${escapeCsv(m.model)},${m.calls},${m.costUsd}`);
  }

  return sections.join("\n");
}

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
