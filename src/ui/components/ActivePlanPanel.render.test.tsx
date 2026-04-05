// E2E render tests for ActivePlanPanel
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import type { Plan } from "../../tools/plan";
import { ThemeProvider } from "../ThemeContext";
import ActivePlanPanel from "./ActivePlanPanel";

function renderWithTheme(element: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, element));
}

const makePlan = (overrides: Partial<Plan> = {}): Plan => ({
  id: "test-plan",
  title: "Test Plan",
  steps: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

describe("ActivePlanPanel render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("renders nothing when plan is null", () => {
    instance = renderWithTheme(<ActivePlanPanel plan={null} />);
    expect(instance.lastFrame()).toBe("");
  });

  test("shows plan title", () => {
    const plan = makePlan({ title: "Auditar proyecto cFS" });
    instance = renderWithTheme(<ActivePlanPanel plan={plan} />);
    expect(instance.lastFrame()).toContain("Auditar proyecto cFS");
  });

  test("shows progress count 0/0 when no steps", () => {
    const plan = makePlan({ title: "Empty" });
    instance = renderWithTheme(<ActivePlanPanel plan={plan} />);
    expect(instance.lastFrame()).toContain("0/0");
  });

  test("shows percentage complete", () => {
    const plan = makePlan({
      steps: [
        { id: "1", title: "Step 1", status: "done" },
        { id: "2", title: "Step 2", status: "done" },
        { id: "3", title: "Step 3", status: "pending" },
        { id: "4", title: "Step 4", status: "pending" },
      ],
    });
    instance = renderWithTheme(<ActivePlanPanel plan={plan} />);
    const out = instance.lastFrame()!;
    expect(out).toContain("2/4");
    expect(out).toContain("50%");
  });

  test("renders done steps with [x]", () => {
    const plan = makePlan({
      steps: [{ id: "1", title: "Completed", status: "done" }],
    });
    instance = renderWithTheme(<ActivePlanPanel plan={plan} />);
    expect(instance.lastFrame()).toContain("[x]");
  });

  test("renders pending steps with [ ]", () => {
    const plan = makePlan({
      steps: [{ id: "1", title: "Not done", status: "pending" }],
    });
    instance = renderWithTheme(<ActivePlanPanel plan={plan} />);
    expect(instance.lastFrame()).toContain("[ ]");
  });

  test("renders in_progress steps with [~]", () => {
    const plan = makePlan({
      steps: [{ id: "1", title: "Working", status: "in_progress" }],
    });
    instance = renderWithTheme(<ActivePlanPanel plan={plan} />);
    expect(instance.lastFrame()).toContain("[~]");
  });

  test("renders skipped steps with [-]", () => {
    const plan = makePlan({
      steps: [{ id: "1", title: "Skipped", status: "skipped" }],
    });
    instance = renderWithTheme(<ActivePlanPanel plan={plan} />);
    expect(instance.lastFrame()).toContain("[-]");
  });

  test("renders all step titles", () => {
    const plan = makePlan({
      steps: [
        { id: "1", title: "Fix strcpy", status: "done" },
        { id: "2", title: "Add tests", status: "in_progress" },
        { id: "3", title: "Deploy", status: "pending" },
      ],
    });
    instance = renderWithTheme(<ActivePlanPanel plan={plan} />);
    const out = instance.lastFrame()!;
    expect(out).toContain("Fix strcpy");
    expect(out).toContain("Add tests");
    expect(out).toContain("Deploy");
  });

  test("shows 100% when all done", () => {
    const plan = makePlan({
      steps: [
        { id: "1", title: "A", status: "done" },
        { id: "2", title: "B", status: "done" },
      ],
    });
    instance = renderWithTheme(<ActivePlanPanel plan={plan} />);
    const out = instance.lastFrame()!;
    expect(out).toContain("2/2");
    expect(out).toContain("100%");
  });

  test("shows step IDs", () => {
    const plan = makePlan({
      steps: [
        { id: "alpha", title: "First", status: "pending" },
        { id: "beta", title: "Second", status: "pending" },
      ],
    });
    instance = renderWithTheme(<ActivePlanPanel plan={plan} />);
    const out = instance.lastFrame()!;
    expect(out).toContain("alpha.");
    expect(out).toContain("beta.");
  });
});
