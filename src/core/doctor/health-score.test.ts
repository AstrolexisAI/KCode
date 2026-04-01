// KCode - Health Score Tests

import { describe, test, expect } from "bun:test";
import { calculateScore, scoreToGrade, renderHealthReport, type HealthCheck, type HealthReport } from "./health-score";

// ─── calculateScore ────────────────────────────────────────────

describe("calculateScore", () => {
  test("returns 100 for all passing checks", () => {
    const checks: HealthCheck[] = [
      { name: "A", category: "runtime", status: "pass", message: "", weight: 10 },
      { name: "B", category: "config", status: "pass", message: "", weight: 5 },
    ];
    expect(calculateScore(checks)).toBe(100);
  });

  test("returns 0 for all failing checks", () => {
    const checks: HealthCheck[] = [
      { name: "A", category: "runtime", status: "fail", message: "", weight: 10 },
      { name: "B", category: "config", status: "fail", message: "", weight: 5 },
    ];
    expect(calculateScore(checks)).toBe(0);
  });

  test("warns count as 50%", () => {
    const checks: HealthCheck[] = [
      { name: "A", category: "runtime", status: "warn", message: "", weight: 10 },
    ];
    expect(calculateScore(checks)).toBe(50);
  });

  test("skipped checks are excluded from calculation", () => {
    const checks: HealthCheck[] = [
      { name: "A", category: "runtime", status: "pass", message: "", weight: 10 },
      { name: "B", category: "gpu", status: "skip", message: "", weight: 7 },
    ];
    expect(calculateScore(checks)).toBe(100);
  });

  test("mixed pass/warn/fail calculates correctly", () => {
    const checks: HealthCheck[] = [
      { name: "A", category: "runtime", status: "pass", message: "", weight: 10 }, // +10
      { name: "B", category: "config", status: "warn", message: "", weight: 10 },  // +5
      { name: "C", category: "network", status: "fail", message: "", weight: 10 }, // +0
    ];
    // total = 30, earned = 15
    expect(calculateScore(checks)).toBe(50);
  });

  test("returns 100 for empty checks", () => {
    expect(calculateScore([])).toBe(100);
  });

  test("respects weight differences", () => {
    const checks: HealthCheck[] = [
      { name: "A", category: "runtime", status: "pass", message: "", weight: 10 }, // +10
      { name: "B", category: "plugin", status: "fail", message: "", weight: 1 },   // +0
    ];
    // total = 11, earned = 10
    expect(calculateScore(checks)).toBe(91);
  });
});

// ─── scoreToGrade ──────────────────────────────────────────────

describe("scoreToGrade", () => {
  test("90+ is A", () => expect(scoreToGrade(95)).toBe("A"));
  test("90 is A", () => expect(scoreToGrade(90)).toBe("A"));
  test("89 is B", () => expect(scoreToGrade(89)).toBe("B"));
  test("75 is B", () => expect(scoreToGrade(75)).toBe("B"));
  test("74 is C", () => expect(scoreToGrade(74)).toBe("C"));
  test("60 is C", () => expect(scoreToGrade(60)).toBe("C"));
  test("59 is D", () => expect(scoreToGrade(59)).toBe("D"));
  test("40 is D", () => expect(scoreToGrade(40)).toBe("D"));
  test("39 is F", () => expect(scoreToGrade(39)).toBe("F"));
  test("0 is F", () => expect(scoreToGrade(0)).toBe("F"));
  test("100 is A", () => expect(scoreToGrade(100)).toBe("A"));
});

// ─── renderHealthReport ────────────────────────────────────────

describe("renderHealthReport", () => {
  const report: HealthReport = {
    score: 85,
    grade: "B",
    checks: [
      { name: "Bun Runtime", category: "runtime", status: "pass", message: "Bun 1.3.10", weight: 10 },
      { name: "Storage", category: "storage", status: "warn", message: "DB is 600MB", fix: "Run `kcode db vacuum`", weight: 5 },
      { name: "GPU", category: "gpu", status: "skip", message: "No GPU detected", weight: 7 },
    ],
    summary: "Health Score: 85/100 (B)",
    criticalIssues: [],
    suggestions: ["Run `kcode db vacuum`"],
    timestamp: Date.now(),
  };

  test("includes score and grade", () => {
    const output = renderHealthReport(report);
    expect(output).toContain("85/100");
    expect(output).toContain("B");
  });

  test("includes check names", () => {
    const output = renderHealthReport(report);
    expect(output).toContain("Bun Runtime");
    expect(output).toContain("Storage");
    expect(output).toContain("GPU");
  });

  test("includes status tags", () => {
    const output = renderHealthReport(report);
    expect(output).toContain("[PASS]");
    expect(output).toContain("[WARN]");
    expect(output).toContain("[SKIP]");
  });

  test("includes suggestions", () => {
    const output = renderHealthReport(report);
    expect(output).toContain("Suggestions");
    expect(output).toContain("kcode db vacuum");
  });

  test("empty suggestions section is omitted", () => {
    const emptyReport = { ...report, suggestions: [] };
    const output = renderHealthReport(emptyReport);
    expect(output).not.toContain("Suggestions");
  });
});
