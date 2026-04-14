// Tests for phase 12 — plan reconciliation detection.
//
// Phase 11 (Write relative path) let the model complete the NASA Explorer
// task successfully. But the session ended with the plan showing 0/10
// unchecked because the model never marked steps done. Phase 12 detects
// that "task-complete declaration + unchecked plan steps" mismatch and
// forces the model to reconcile before proceeding.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildPlanReconciliationReminder,
  clearActivePlan,
  detectAbandonedPlan,
  setActivePlanForTesting,
  type Plan,
  type PlanStep,
} from "../tools/plan";

function makePlan(steps: PlanStep[]): Plan {
  return {
    id: "test-plan",
    title: "Test Plan",
    steps,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("detectAbandonedPlan", () => {
  beforeEach(() => clearActivePlan());
  afterEach(() => clearActivePlan());

  test("returns not-abandoned when no active plan", () => {
    const r = detectAbandonedPlan("Task completed.");
    expect(r.abandoned).toBe(false);
    expect(r.pendingSteps).toEqual([]);
  });

  test("returns not-abandoned when all steps are done", () => {
    setActivePlanForTesting(
      makePlan([
        { id: "1", title: "a", status: "done" },
        { id: "2", title: "b", status: "done" },
      ]),
    );
    const r = detectAbandonedPlan("Task completed successfully");
    expect(r.abandoned).toBe(false);
    expect(r.pendingSteps).toEqual([]);
  });

  test("returns not-abandoned when steps are skipped", () => {
    setActivePlanForTesting(
      makePlan([
        { id: "1", title: "a", status: "done" },
        { id: "2", title: "b", status: "skipped" },
      ]),
    );
    const r = detectAbandonedPlan("Delivered and done");
    expect(r.abandoned).toBe(false);
  });

  test("returns not-abandoned when text has no completion phrase", () => {
    setActivePlanForTesting(
      makePlan([{ id: "1", title: "a", status: "pending" }]),
    );
    const r = detectAbandonedPlan("Still working on step 1, will continue next turn.");
    expect(r.abandoned).toBe(false);
    expect(r.pendingSteps.length).toBe(1);
  });

  test("detects abandonment with 'Task completed' phrase", () => {
    setActivePlanForTesting(
      makePlan([
        { id: "1", title: "a", status: "pending" },
        { id: "2", title: "b", status: "done" },
      ]),
    );
    const r = detectAbandonedPlan("Task completed. Here's the summary...");
    expect(r.abandoned).toBe(true);
    expect(r.pendingSteps.length).toBe(1);
    expect(r.pendingSteps[0]!.id).toBe("1");
    expect(r.completionPhrase).toMatch(/task completed/i);
  });

  test("detects abandonment with 'Summary of changes' phrase", () => {
    setActivePlanForTesting(
      makePlan([{ id: "1", title: "a", status: "in_progress" }]),
    );
    const r = detectAbandonedPlan("Summary of changes:\n- Did X\n- Did Y");
    expect(r.abandoned).toBe(true);
    expect(r.completionPhrase).toMatch(/summary of changes/i);
  });

  test("detects abandonment with 'Delivered' phrase", () => {
    setActivePlanForTesting(
      makePlan([{ id: "1", title: "a", status: "pending" }]),
    );
    const r = detectAbandonedPlan("Delivered as requested.");
    expect(r.abandoned).toBe(true);
  });

  test("detects abandonment with 'the site is live' phrase", () => {
    setActivePlanForTesting(
      makePlan([{ id: "1", title: "a", status: "pending" }]),
    );
    const r = detectAbandonedPlan("The site is live at http://localhost:25632.");
    expect(r.abandoned).toBe(true);
  });

  test("detects abandonment with Spanish 'Tarea completada'", () => {
    setActivePlanForTesting(
      makePlan([{ id: "1", title: "a", status: "pending" }]),
    );
    const r = detectAbandonedPlan("Tarea completada. El archivo está listo.");
    expect(r.abandoned).toBe(true);
  });

  test("detects abandonment with the NASA Explorer session phrase", () => {
    // The exact phrase from the failing session:
    // "Refactored and delivered as nasa-explorer.html"
    setActivePlanForTesting(
      makePlan([
        { id: "1", title: "Create base HTML structure", status: "pending" },
        { id: "2", title: "Implement navbar", status: "pending" },
        { id: "3", title: "Build hero section", status: "pending" },
      ]),
    );
    const r = detectAbandonedPlan(
      "Refactored and delivered as `nasa-explorer.html` (single self-contained file).",
    );
    expect(r.abandoned).toBe(true);
    expect(r.pendingSteps.length).toBe(3);
  });

  test("in_progress step is still counted as pending", () => {
    setActivePlanForTesting(
      makePlan([
        { id: "1", title: "a", status: "done" },
        { id: "2", title: "b", status: "in_progress" },
      ]),
    );
    const r = detectAbandonedPlan("Task completed.");
    expect(r.abandoned).toBe(true);
    expect(r.pendingSteps.length).toBe(1);
    expect(r.pendingSteps[0]!.status).toBe("in_progress");
  });
});

describe("buildPlanReconciliationReminder", () => {
  test("contains PLAN RECONCILIATION header", () => {
    const out = buildPlanReconciliationReminder(
      [{ id: "1", title: "X", status: "pending" }],
      "Task completed",
    );
    expect(out).toContain("[PLAN RECONCILIATION]");
  });

  test("quotes the completion phrase that triggered it", () => {
    const out = buildPlanReconciliationReminder(
      [{ id: "1", title: "X", status: "pending" }],
      "Delivered as requested",
    );
    expect(out).toContain('"Delivered as requested"');
  });

  test("lists each pending step with status", () => {
    const out = buildPlanReconciliationReminder(
      [
        { id: "1", title: "Create HTML", status: "pending" },
        { id: "2", title: "Add navbar", status: "in_progress" },
      ],
      "Task completed",
    );
    expect(out).toContain("[pending] 1. Create HTML");
    expect(out).toContain("[in_progress] 2. Add navbar");
  });

  test("offers three reconciliation options a/b/c", () => {
    const out = buildPlanReconciliationReminder(
      [{ id: "1", title: "X", status: "pending" }],
      "Task completed",
    );
    expect(out).toMatch(/a\)\s+mark each finished step done/i);
    expect(out).toMatch(/b\)\s+mark each no-longer-needed step skipped/i);
    expect(out).toMatch(/c\)\s+explain precisely/i);
  });

  test("makes clear this is not a failure", () => {
    const out = buildPlanReconciliationReminder(
      [{ id: "1", title: "X", status: "pending" }],
      "Task completed",
    );
    expect(out).toMatch(/not a failure/i);
  });
});
