// KCode - Doctor Health Score System
// Modular health checks with weighted scoring and grade calculation.

import { log } from "../logger";
import { checkConfig } from "./checks/config-check";
import { checkGpu } from "./checks/gpu-check";
import { checkModels } from "./checks/model-check";
import { checkNetwork } from "./checks/network-check";
import { checkPlugins } from "./checks/plugin-check";
import { checkRuntime } from "./checks/runtime-check";
import { checkStorage } from "./checks/storage-check";

// ─── Types ─────────────────────────────────────────────────────

export interface HealthCheck {
  name: string;
  category: "runtime" | "model" | "config" | "network" | "storage" | "gpu" | "plugin";
  status: "pass" | "warn" | "fail" | "skip";
  message: string;
  fix?: string;
  weight: number;
}

export interface HealthReport {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  checks: HealthCheck[];
  summary: string;
  criticalIssues: HealthCheck[];
  suggestions: string[];
  timestamp: number;
}

// ─── Score calculation ─────────────────────────────────────────

export function calculateScore(checks: HealthCheck[]): number {
  let totalWeight = 0;
  let earnedWeight = 0;

  for (const check of checks) {
    if (check.status === "skip") continue;
    totalWeight += check.weight;
    if (check.status === "pass") earnedWeight += check.weight;
    else if (check.status === "warn") earnedWeight += check.weight * 0.5;
    // fail = 0 points
  }

  return totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 100;
}

export function scoreToGrade(score: number): HealthReport["grade"] {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

// ─── Run all checks ────────────────────────────────────────────

export async function runHealthChecks(): Promise<HealthReport> {
  const checks: HealthCheck[] = [];

  const runners = [
    checkRuntime,
    checkModels,
    checkConfig,
    checkNetwork,
    checkStorage,
    checkGpu,
    checkPlugins,
  ];

  for (const runner of runners) {
    try {
      const result = await runner();
      if (Array.isArray(result)) checks.push(...result);
      else checks.push(result);
    } catch (err) {
      log.debug("doctor/health", `Check failed: ${err}`);
    }
  }

  const score = calculateScore(checks);
  const grade = scoreToGrade(score);
  const criticalIssues = checks.filter((c) => c.status === "fail");
  const suggestions = checks.filter((c) => c.fix).map((c) => c.fix!);

  return {
    score,
    grade,
    checks,
    summary: `Health Score: ${score}/100 (${grade}) — ${criticalIssues.length} critical issue${criticalIssues.length !== 1 ? "s" : ""}`,
    criticalIssues,
    suggestions,
    timestamp: Date.now(),
  };
}

// ─── Render report ─────────────────────────────────────────────

export function renderHealthReport(report: HealthReport): string {
  const lines: string[] = [];
  const icon = (s: string) =>
    s === "pass"
      ? "\x1b[32m✓\x1b[0m"
      : s === "warn"
        ? "\x1b[33m!\x1b[0m"
        : s === "fail"
          ? "\x1b[31m✗\x1b[0m"
          : "\x1b[2m-\x1b[0m";
  const tag = (s: string) =>
    s === "pass"
      ? "\x1b[32m[PASS]\x1b[0m"
      : s === "warn"
        ? "\x1b[33m[WARN]\x1b[0m"
        : s === "fail"
          ? "\x1b[31m[FAIL]\x1b[0m"
          : "\x1b[2m[SKIP]\x1b[0m";

  const gradeColor =
    report.grade === "A"
      ? "\x1b[32m"
      : report.grade === "B"
        ? "\x1b[32m"
        : report.grade === "C"
          ? "\x1b[33m"
          : "\x1b[31m";

  lines.push("");
  lines.push(
    `  KCode Health Report — Score: ${gradeColor}${report.score}/100 (${report.grade})\x1b[0m`,
  );
  lines.push("");

  for (const check of report.checks) {
    const nameCol = check.name.padEnd(22);
    const msgCol = check.message.length > 50 ? check.message.slice(0, 47) + "..." : check.message;
    lines.push(`  ${icon(check.status)} ${nameCol} ${msgCol.padEnd(50)} ${tag(check.status)}`);
  }

  if (report.suggestions.length > 0) {
    lines.push("");
    lines.push("  \x1b[1mSuggestions:\x1b[0m");
    report.suggestions.forEach((s, i) => {
      lines.push(`    ${i + 1}. ${s}`);
    });
  }

  lines.push("");
  return lines.join("\n");
}
