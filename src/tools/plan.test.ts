import { test, expect, describe, beforeEach } from "bun:test";
import { executePlan, getActivePlan, formatPlan } from "./plan";

describe("plan tool", () => {
  beforeEach(async () => {
    // Clear any active plan
    await executePlan({ mode: "clear" });
  });

  test("create a plan", async () => {
    const result = await executePlan({
      mode: "create",
      title: "Build feature X",
      steps: [
        { id: "1", title: "Read existing code" },
        { id: "2", title: "Implement changes" },
        { id: "3", title: "Write tests" },
      ],
    });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Plan created");
    expect(result.content).toContain("3 steps");

    const plan = getActivePlan();
    expect(plan).not.toBeNull();
    expect(plan!.title).toBe("Build feature X");
    expect(plan!.steps).toHaveLength(3);
    expect(plan!.steps[0]!.status).toBe("pending");
  });

  test("update step statuses", async () => {
    await executePlan({
      mode: "create",
      title: "Test plan",
      steps: [
        { id: "1", title: "Step one" },
        { id: "2", title: "Step two" },
      ],
    });

    const result = await executePlan({
      mode: "update",
      updates: [{ id: "1", status: "done" }],
    });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Updated 1 step");

    const plan = getActivePlan();
    expect(plan!.steps[0]!.status).toBe("done");
    expect(plan!.steps[1]!.status).toBe("pending");
  });

  test("add steps to existing plan", async () => {
    await executePlan({
      mode: "create",
      title: "Growing plan",
      steps: [{ id: "1", title: "First step" }],
    });

    const result = await executePlan({
      mode: "add",
      steps: [{ id: "2", title: "Second step" }],
    });

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Added 1 step");

    const plan = getActivePlan();
    expect(plan!.steps).toHaveLength(2);
  });

  test("error on update without active plan", async () => {
    const result = await executePlan({
      mode: "update",
      updates: [{ id: "1", status: "done" }],
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("No active plan");
  });

  test("error on duplicate step id", async () => {
    await executePlan({
      mode: "create",
      title: "Dupe test",
      steps: [{ id: "1", title: "Step one" }],
    });

    const result = await executePlan({
      mode: "add",
      steps: [{ id: "1", title: "Duplicate" }],
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("already exists");
  });

  test("clear removes the plan", async () => {
    await executePlan({
      mode: "create",
      title: "To be cleared",
      steps: [{ id: "1", title: "Step" }],
    });

    const result = await executePlan({ mode: "clear" });
    expect(result.is_error).toBeUndefined();
    expect(getActivePlan()).toBeNull();
  });

  test("create requires title and steps", async () => {
    const r1 = await executePlan({ mode: "create" });
    expect(r1.is_error).toBe(true);

    const r2 = await executePlan({ mode: "create", title: "No steps" });
    expect(r2.is_error).toBe(true);
  });

  test("formatPlan shows progress", async () => {
    await executePlan({
      mode: "create",
      title: "Format test",
      steps: [
        { id: "1", title: "Done step", status: "done" },
        { id: "2", title: "Pending step" },
      ],
    });

    const plan = getActivePlan()!;
    const formatted = formatPlan(plan);
    expect(formatted).toContain("Format test");
    expect(formatted).toContain("1/2");
    expect(formatted).toContain("50%");
    expect(formatted).toContain("[x]");
    expect(formatted).toContain("[ ]");
  });
});
