// KCode - Cost Dashboard Renderer

import type { CostSummary } from "./types";

// ─── Helpers ───────────────────────────────────────────────────

function formatCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function bar(pct: number, width: number = 20): string {
  const filled = Math.round((pct / 100) * width);
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

function trendIcon(trend: string): string {
  if (trend === "up") return "\u2191";
  if (trend === "down") return "\u2193";
  return "\u2192";
}

const PERIOD_LABELS: Record<string, string> = {
  today: "Last 24 Hours",
  week: "Last 7 Days",
  month: "Last 30 Days",
  all: "All Time",
};

// ─── Render ────────────────────────────────────────────────────

export function renderCostDashboard(summary: CostSummary): string {
  const lines: string[] = [];
  const periodLabel = PERIOD_LABELS[summary.period] ?? summary.period;

  lines.push("");
  lines.push(`  \x1b[1mCost Dashboard — ${periodLabel}\x1b[0m`);
  lines.push("");
  lines.push(
    `  Total:    ${formatCost(summary.totalCostUsd)} across ${summary.sessions} session${summary.sessions !== 1 ? "s" : ""} (${formatCost(summary.avgCostPerSession)}/session avg)`,
  );
  lines.push(
    `  Tokens:   ${formatTokens(summary.totalInputTokens)} input / ${formatTokens(summary.totalOutputTokens)} output`,
  );
  lines.push(
    `  Trend:    ${trendIcon(summary.trend)} ${summary.trendPercentage}% vs previous period`,
  );

  // By Model
  if (summary.byModel.length > 0) {
    lines.push("");
    lines.push("  \x1b[1mBy Model:\x1b[0m");
    const maxNameLen = Math.max(...summary.byModel.map((m) => m.model.length), 8);
    for (const m of summary.byModel.slice(0, 10)) {
      const name = m.model.padEnd(maxNameLen);
      const cost = formatCost(m.costUsd).padStart(8);
      const pct = `${Math.round(m.percentage)}%`.padStart(4);
      lines.push(`    ${name} ${cost}  ${bar(m.percentage)} ${pct}`);
    }
  }

  // By Day
  if (summary.byDay.length > 0) {
    lines.push("");
    lines.push("  \x1b[1mBy Day:\x1b[0m");
    const maxCost = Math.max(...summary.byDay.map((d) => d.costUsd), 0.01);
    for (const d of summary.byDay.slice(-14)) {
      const datePart = d.date.slice(5); // MM-DD
      const cost = formatCost(d.costUsd).padStart(8);
      const barWidth = Math.round((d.costUsd / maxCost) * 30);
      lines.push(`    ${datePart} ${cost} ${"█".repeat(barWidth)}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

export function renderCostDashboardJson(summary: CostSummary): string {
  return JSON.stringify(summary, null, 2);
}
