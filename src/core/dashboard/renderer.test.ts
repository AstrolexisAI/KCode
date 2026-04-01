// KCode - Dashboard Renderer Tests

import { describe, expect, test } from "bun:test";
import {
  formatCost,
  formatNumber,
  formatTokens,
  padRight,
  renderDashboard,
  renderDashboardJson,
  timeAgo,
} from "./renderer";
import type { ProjectDashboard } from "./types";

// ─── Helper data ───────────────────────────────────────────────

function makeDashboard(overrides?: Partial<ProjectDashboard>): ProjectDashboard {
  return {
    project: {
      name: "test-app",
      language: "TypeScript",
      files: 156,
      linesOfCode: 12456,
      lastCommit: new Date().toISOString(),
    },
    tests: {
      framework: "bun:test",
      total: 234,
      passing: 230,
      failing: 4,
      coverage: 78,
      lastRun: "2m ago",
    },
    codeQuality: {
      todos: 23,
      todoList: [],
      longFunctions: 8,
      duplicateCode: 3,
      complexityScore: 72,
    },
    activity: {
      sessionsLast7Days: 12,
      tokensLast7Days: 450_000,
      costLast7Days: 3.45,
      topTools: [
        { name: "Bash", count: 45 },
        { name: "Edit", count: 32 },
      ],
      filesModifiedByAI: 34,
    },
    dependencies: { total: 45, outdated: 7, vulnerable: 0 },
    ...overrides,
  };
}

// ─── padRight ──────────────────────────────────────────────────

describe("padRight", () => {
  test("pads short strings", () => {
    expect(padRight("hello", 10)).toBe("hello     ");
  });

  test("truncates long strings", () => {
    expect(padRight("hello world", 5)).toBe("hello");
  });

  test("handles exact length", () => {
    expect(padRight("abc", 3)).toBe("abc");
  });

  test("handles empty string", () => {
    expect(padRight("", 5)).toBe("     ");
  });
});

// ─── formatNumber ──────────────────────────────────────────────

describe("formatNumber", () => {
  test("formats small numbers", () => {
    expect(formatNumber(42)).toBe("42");
  });

  test("formats thousands", () => {
    expect(formatNumber(1500)).toBe("1.5K");
  });

  test("formats large thousands", () => {
    expect(formatNumber(12456)).toBe("12K");
  });

  test("formats millions", () => {
    expect(formatNumber(1_500_000)).toBe("1.5M");
  });
});

// ─── formatCost ────────────────────────────────────────────────

describe("formatCost", () => {
  test("formats zero", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  test("formats small amounts", () => {
    expect(formatCost(0.005)).toBe("$0.0050");
  });

  test("formats normal amounts", () => {
    expect(formatCost(3.45)).toBe("$3.45");
  });
});

// ─── formatTokens ──────────────────────────────────────────────

describe("formatTokens", () => {
  test("formats small counts", () => {
    expect(formatTokens(500)).toBe("500");
  });

  test("formats thousands", () => {
    expect(formatTokens(450_000)).toBe("450K");
  });

  test("formats millions", () => {
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });
});

// ─── timeAgo ───────────────────────────────────────────────────

describe("timeAgo", () => {
  test("handles recent dates", () => {
    const now = new Date().toISOString();
    expect(timeAgo(now)).toBe("just now");
  });

  test("handles minutes ago", () => {
    const d = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(timeAgo(d)).toBe("5m ago");
  });

  test("handles hours ago", () => {
    const d = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(timeAgo(d)).toBe("3h ago");
  });

  test("handles days ago", () => {
    const d = new Date(Date.now() - 5 * 86_400_000).toISOString();
    expect(timeAgo(d)).toBe("5d ago");
  });

  test("handles unknown", () => {
    expect(timeAgo("unknown")).toBe("unknown");
  });

  test("handles empty string", () => {
    expect(timeAgo("")).toBe("unknown");
  });
});

// ─── renderDashboard ───────────────────────────────────────────

describe("renderDashboard", () => {
  test("produces valid box-drawing output", () => {
    const output = renderDashboard(makeDashboard());
    expect(output).toContain("┌");
    expect(output).toContain("┘");
    expect(output).toContain("┤");
    expect(output).toContain("│");
  });

  test("includes project name", () => {
    const output = renderDashboard(makeDashboard());
    expect(output).toContain("test-app");
  });

  test("includes language", () => {
    const output = renderDashboard(makeDashboard());
    expect(output).toContain("TypeScript");
  });

  test("includes test info", () => {
    const output = renderDashboard(makeDashboard());
    expect(output).toContain("bun:test");
    expect(output).toContain("234");
    expect(output).toContain("230");
  });

  test("includes coverage percentage", () => {
    const output = renderDashboard(makeDashboard());
    expect(output).toContain("78%");
  });

  test("shows N/A for missing coverage", () => {
    const d = makeDashboard();
    d.tests.coverage = undefined;
    const output = renderDashboard(d);
    expect(output).toContain("N/A");
  });

  test("includes code quality metrics", () => {
    const output = renderDashboard(makeDashboard());
    expect(output).toContain("TODOs: 23");
    expect(output).toContain("72/100");
  });

  test("includes activity", () => {
    const output = renderDashboard(makeDashboard());
    expect(output).toContain("Sessions: 12");
    expect(output).toContain("450K");
  });

  test("includes top tools", () => {
    const output = renderDashboard(makeDashboard());
    expect(output).toContain("Bash(45)");
    expect(output).toContain("Edit(32)");
  });

  test("includes dependencies", () => {
    const output = renderDashboard(makeDashboard());
    expect(output).toContain("Total: 45");
    expect(output).toContain("Outdated: 7");
    expect(output).toContain("Vulnerable: 0");
  });

  test("handles zero values", () => {
    const d = makeDashboard({
      activity: {
        sessionsLast7Days: 0,
        tokensLast7Days: 0,
        costLast7Days: 0,
        topTools: [],
        filesModifiedByAI: 0,
      },
      dependencies: { total: 0, outdated: 0, vulnerable: 0 },
    });
    const output = renderDashboard(d);
    expect(output).toContain("Sessions: 0");
    expect(output).toContain("N/A"); // no top tools
  });
});

// ─── renderDashboardJson ───────────────────────────────────────

describe("renderDashboardJson", () => {
  test("produces valid JSON", () => {
    const d = makeDashboard();
    const json = renderDashboardJson(d);
    const parsed = JSON.parse(json);
    expect(parsed.project.name).toBe("test-app");
  });

  test("includes all sections", () => {
    const json = JSON.parse(renderDashboardJson(makeDashboard()));
    expect(json.project).toBeDefined();
    expect(json.tests).toBeDefined();
    expect(json.codeQuality).toBeDefined();
    expect(json.activity).toBeDefined();
    expect(json.dependencies).toBeDefined();
  });
});
