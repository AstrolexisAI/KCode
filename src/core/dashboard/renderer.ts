// KCode - Dashboard Terminal Renderer
// Renders a ProjectDashboard as a Unicode box-drawing table.

import type { ProjectDashboard } from "./types";

// ─── Formatting helpers ────────────────────────────────────────

function padRight(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width);
  return str + " ".repeat(width - str.length);
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString("en-US");
}

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

function timeAgo(dateStr: string): string {
  if (!dateStr || dateStr === "unknown") return "unknown";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

// ─── Box drawing ───────────────────────────────────────────────

const L = 28; // left column inner width
const R = 26; // right column inner width

function topBorder(leftTitle: string, rightTitle: string): string {
  const lt = `─ ${leftTitle} `;
  const rt = `─ ${rightTitle} `;
  return `┌${lt}${"─".repeat(Math.max(0, L - lt.length))}┬${rt}${"─".repeat(Math.max(0, R - rt.length))}┐`;
}

function midBorder(leftTitle: string, rightTitle: string): string {
  const lt = `─ ${leftTitle} `;
  const rt = `─ ${rightTitle} `;
  return `├${lt}${"─".repeat(Math.max(0, L - lt.length))}┼${rt}${"─".repeat(Math.max(0, R - rt.length))}┤`;
}

function bottomBorder(): string {
  return `└${"─".repeat(L)}┴${"─".repeat(R)}┘`;
}

function row(left: string, right: string): string {
  return `│ ${padRight(left, L - 2)} │ ${padRight(right, R - 2)} │`;
}

// ─── Main renderer ─────────────────────────────────────────────

export function renderDashboard(d: ProjectDashboard): string {
  const lines: string[] = [];

  // Row 1: Project + Tests
  lines.push(topBorder("Project", "Tests"));
  lines.push(row(`Name: ${d.project.name}`, `Framework: ${d.tests.framework}`));
  lines.push(row(`Language: ${d.project.language}`, `Total: ${d.tests.total}`));
  lines.push(row(`Files: ${formatNumber(d.project.files)}`, `\u2713 Passing: ${d.tests.passing}`));
  lines.push(row(`LoC: ${formatNumber(d.project.linesOfCode)}`, `\u2717 Failing: ${d.tests.failing}`));
  lines.push(row(
    `Last commit: ${timeAgo(d.project.lastCommit)}`,
    d.tests.coverage !== undefined ? `Coverage: ${d.tests.coverage}%` : "Coverage: N/A",
  ));

  // Row 2: Code Quality + Activity
  lines.push(midBorder("Code Quality", "Activity (7d)"));
  lines.push(row(`TODOs: ${d.codeQuality.todos}`, `Sessions: ${d.activity.sessionsLast7Days}`));
  lines.push(row(`Long functions: ${d.codeQuality.longFunctions}`, `Tokens: ${formatTokens(d.activity.tokensLast7Days)}`));
  lines.push(row(`Complexity: ${d.codeQuality.complexityScore}/100`, `Cost: ${formatCost(d.activity.costLast7Days)}`));

  const topToolsStr = d.activity.topTools.slice(0, 3).map(t => `${t.name}(${t.count})`).join(" ");
  lines.push(row(`Duplicates: ${d.codeQuality.duplicateCode}`, `Top: ${topToolsStr || "N/A"}`));

  // Row 3: Dependencies + AI Impact
  lines.push(midBorder("Dependencies", "AI Impact"));
  lines.push(row(`Total: ${d.dependencies.total}`, `Files modified: ${d.activity.filesModifiedByAI}`));
  lines.push(row(`Outdated: ${d.dependencies.outdated}`, ""));
  lines.push(row(
    `Vulnerable: ${d.dependencies.vulnerable}${d.dependencies.vulnerable === 0 ? " \u2713" : " \u26a0"}`,
    "",
  ));

  lines.push(bottomBorder());

  return lines.join("\n");
}

// ─── JSON renderer ─────────────────────────────────────────────

export function renderDashboardJson(d: ProjectDashboard): string {
  return JSON.stringify(d, null, 2);
}

// ─── Exports for testing ───────────────────────────────────────

export { padRight, formatNumber, formatCost, formatTokens, timeAgo };
