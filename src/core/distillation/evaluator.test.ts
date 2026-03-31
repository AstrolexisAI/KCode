import { test, expect, describe, beforeEach } from "bun:test";

import { ModelEvaluator } from "./evaluator";
import type { EvalConfig, EvalReport, EvalTask } from "./types";

// ─── Test Helpers ──────────────────────────────────────────────

let evaluator: ModelEvaluator;

function makeConfig(overrides?: Partial<EvalConfig>): EvalConfig {
  return ModelEvaluator.defaults({
    modelPath: "test-model",
    ...overrides,
  });
}

function makeReport(overrides?: Partial<EvalReport>): EvalReport {
  return {
    modelPath: "test-model",
    benchmark: "coding-tasks",
    totalTasks: 10,
    passed: 7,
    failed: 3,
    avgLatencyMs: 500,
    avgTokens: 200,
    passRate: 0.7,
    taskResults: [],
    ...overrides,
  };
}

// ─── Setup ─────────────────────────────────────────────────────

beforeEach(() => {
  evaluator = new ModelEvaluator();
});

// ─── Tests ─────────────────────────────────────────────────────

describe("ModelEvaluator", () => {
  // ─── defaults() ─────────────────────────────────────────────

  test("defaults() returns valid EvalConfig", () => {
    const config = ModelEvaluator.defaults();
    expect(config.modelPath).toBe("");
    expect(config.benchmark).toBe("coding-tasks");
    expect(config.numPrompts).toBe(50);
    expect(config.apiBase).toBe("http://localhost:10091");
  });

  test("defaults() merges partial overrides", () => {
    const config = ModelEvaluator.defaults({
      modelPath: "my-model.gguf",
      benchmark: "general",
    });
    expect(config.modelPath).toBe("my-model.gguf");
    expect(config.benchmark).toBe("general");
    expect(config.numPrompts).toBe(50); // unchanged
  });

  // ─── getTasks() ─────────────────────────────────────────────

  describe("getTasks", () => {
    test("returns coding tasks", () => {
      const tasks = evaluator.getTasks("coding-tasks", 100);
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks[0]).toHaveProperty("id");
      expect(tasks[0]).toHaveProperty("prompt");
      expect(tasks[0]).toHaveProperty("category");
    });

    test("returns general tasks", () => {
      const tasks = evaluator.getTasks("general", 100);
      expect(tasks.length).toBeGreaterThan(0);
      for (const task of tasks) {
        expect(task.id).toMatch(/^gen-/);
      }
    });

    test("returns tool-use tasks", () => {
      const tasks = evaluator.getTasks("tool-use", 100);
      expect(tasks.length).toBeGreaterThan(0);
      for (const task of tasks) {
        expect(task.id).toMatch(/^tool-/);
      }
    });

    test("limits tasks to the specified count", () => {
      const tasks = evaluator.getTasks("coding-tasks", 3);
      expect(tasks.length).toBe(3);
    });

    test("returns coding tasks for unknown benchmark", () => {
      const tasks = evaluator.getTasks("unknown-benchmark", 100);
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks[0]!.id).toMatch(/^code-/);
    });
  });

  // ─── evaluateTask() ────────────────────────────────────────

  describe("evaluateTask", () => {
    test("returns failed result when API is unreachable", async () => {
      const task: EvalTask = {
        id: "test-1",
        prompt: "Say hello",
        expectedPattern: "hello",
        category: "test",
      };

      const config = makeConfig({
        apiBase: "http://localhost:19999", // Unreachable
      });

      const result = await evaluator.evaluateTask(task, config);
      expect(result.taskId).toBe("test-1");
      expect(result.passed).toBe(false);
      expect(result.responseLength).toBe(0);
      expect(result.tokensUsed).toBe(0);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── compareReports() ─────────────────────────────────────

  describe("compareReports", () => {
    test("detects improvement when pass rate increases and latency decreases", () => {
      const base = makeReport({ passRate: 0.6, avgLatencyMs: 600, avgTokens: 200 });
      const distilled = makeReport({
        passRate: 0.8,
        avgLatencyMs: 400,
        avgTokens: 180,
      });

      const comparison = evaluator.compareReports(distilled, base);
      expect(comparison.improved).toBe(true);
      expect(comparison.passRateDelta).toBeCloseTo(0.2);
      expect(comparison.latencyDelta).toBe(-200);
      expect(comparison.tokensDelta).toBe(-20);
      expect(comparison.summary).toContain("improvement");
    });

    test("detects no improvement when pass rate decreases", () => {
      const base = makeReport({ passRate: 0.8, avgLatencyMs: 400, avgTokens: 200 });
      const distilled = makeReport({
        passRate: 0.5,
        avgLatencyMs: 300,
        avgTokens: 180,
      });

      const comparison = evaluator.compareReports(distilled, base);
      expect(comparison.improved).toBe(false);
      expect(comparison.passRateDelta).toBeCloseTo(-0.3);
      expect(comparison.summary).toContain("did not clearly improve");
    });

    test("detects no improvement when latency increases even if pass rate same", () => {
      const base = makeReport({ passRate: 0.7, avgLatencyMs: 300, avgTokens: 200 });
      const distilled = makeReport({
        passRate: 0.7,
        avgLatencyMs: 500,
        avgTokens: 250,
      });

      const comparison = evaluator.compareReports(distilled, base);
      expect(comparison.improved).toBe(false);
      expect(comparison.latencyDelta).toBe(200);
    });

    test("reports delta values correctly", () => {
      const base = makeReport({ passRate: 0.5, avgLatencyMs: 1000, avgTokens: 300 });
      const distilled = makeReport({
        passRate: 0.9,
        avgLatencyMs: 500,
        avgTokens: 200,
      });

      const comparison = evaluator.compareReports(distilled, base);
      expect(comparison.passRateDelta).toBeCloseTo(0.4);
      expect(comparison.latencyDelta).toBe(-500);
      expect(comparison.tokensDelta).toBe(-100);
    });

    test("summary includes percentage values", () => {
      const base = makeReport({ passRate: 0.6, avgLatencyMs: 500, avgTokens: 200 });
      const distilled = makeReport({
        passRate: 0.8,
        avgLatencyMs: 400,
        avgTokens: 180,
      });

      const comparison = evaluator.compareReports(distilled, base);
      expect(comparison.summary).toContain("60%");
      expect(comparison.summary).toContain("80%");
      expect(comparison.summary).toContain("Pass rate");
      expect(comparison.summary).toContain("Avg latency");
      expect(comparison.summary).toContain("Avg tokens");
    });
  });

  // ─── evaluate() integration (with unreachable server) ─────

  test("evaluate handles unreachable server gracefully", async () => {
    const config = makeConfig({
      apiBase: "http://localhost:19999",
      numPrompts: 2,
      benchmark: "coding-tasks",
    });

    const report = await evaluator.evaluate(config);

    expect(report.modelPath).toBe("test-model");
    expect(report.benchmark).toBe("coding-tasks");
    expect(report.totalTasks).toBe(2);
    expect(report.passed).toBe(0); // All should fail
    expect(report.failed).toBe(2);
    expect(report.passRate).toBe(0);
    expect(report.taskResults.length).toBe(2);
  });
});
