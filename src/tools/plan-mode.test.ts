// Tests for PlanMode tools — enter/exit plan mode restrictions
import { afterEach, describe, expect, test } from "bun:test";
import {
  enterPlanModeDefinition,
  executeEnterPlanMode,
  executeExitPlanMode,
  exitPlanModeDefinition,
  getPlanModeReason,
  isPlanModeActive,
  PLAN_MODE_ALLOWED_TOOLS,
} from "./plan-mode";

afterEach(async () => {
  // Reset state after each test
  if (isPlanModeActive()) {
    await executeExitPlanMode({});
  }
});

describe("plan mode definitions", () => {
  test("enterPlanModeDefinition has correct name", () => {
    expect(enterPlanModeDefinition.name).toBe("EnterPlanMode");
  });

  test("exitPlanModeDefinition has correct name", () => {
    expect(exitPlanModeDefinition.name).toBe("ExitPlanMode");
  });
});

describe("PLAN_MODE_ALLOWED_TOOLS", () => {
  test("includes read-only tools", () => {
    expect(PLAN_MODE_ALLOWED_TOOLS.has("Read")).toBe(true);
    expect(PLAN_MODE_ALLOWED_TOOLS.has("Glob")).toBe(true);
    expect(PLAN_MODE_ALLOWED_TOOLS.has("Grep")).toBe(true);
    expect(PLAN_MODE_ALLOWED_TOOLS.has("LS")).toBe(true);
  });

  test("includes planning tools", () => {
    expect(PLAN_MODE_ALLOWED_TOOLS.has("Plan")).toBe(true);
    expect(PLAN_MODE_ALLOWED_TOOLS.has("TaskCreate")).toBe(true);
    expect(PLAN_MODE_ALLOWED_TOOLS.has("ExitPlanMode")).toBe(true);
  });

  test("excludes write tools", () => {
    expect(PLAN_MODE_ALLOWED_TOOLS.has("Write")).toBe(false);
    expect(PLAN_MODE_ALLOWED_TOOLS.has("Edit")).toBe(false);
    expect(PLAN_MODE_ALLOWED_TOOLS.has("Bash")).toBe(false);
    expect(PLAN_MODE_ALLOWED_TOOLS.has("MultiEdit")).toBe(false);
  });

  test("excludes Agent (subagents bypass restriction)", () => {
    expect(PLAN_MODE_ALLOWED_TOOLS.has("Agent")).toBe(false);
  });
});

describe("executeEnterPlanMode", () => {
  test("activates plan mode with reason", async () => {
    const result = await executeEnterPlanMode({ reason: "refactoring auth" });
    expect(result.is_error).toBeFalsy();
    expect(isPlanModeActive()).toBe(true);
    expect(getPlanModeReason()).toBe("refactoring auth");
    expect(result.content).toContain("refactoring auth");
  });

  test("uses default reason when not provided", async () => {
    const result = await executeEnterPlanMode({});
    expect(isPlanModeActive()).toBe(true);
    expect(getPlanModeReason()).toBe("planning");
    expect(result.is_error).toBeFalsy();
  });

  test("returns message when already in plan mode", async () => {
    await executeEnterPlanMode({ reason: "first" });
    const result = await executeEnterPlanMode({ reason: "second" });
    expect(result.content).toContain("Already in plan mode");
    // Reason should not change
    expect(getPlanModeReason()).toBe("first");
  });

  test("lists allowed tools in output", async () => {
    const result = await executeEnterPlanMode({ reason: "test" });
    expect(result.content).toContain("Read");
    expect(result.content).toContain("Grep");
    expect(result.content).toContain("ExitPlanMode");
  });
});

describe("executeExitPlanMode", () => {
  test("deactivates plan mode", async () => {
    await executeEnterPlanMode({ reason: "test" });
    expect(isPlanModeActive()).toBe(true);

    const result = await executeExitPlanMode({});
    expect(result.is_error).toBeFalsy();
    expect(isPlanModeActive()).toBe(false);
    expect(getPlanModeReason()).toBe("");
  });

  test("returns message when not in plan mode", async () => {
    const result = await executeExitPlanMode({});
    expect(result.content).toContain("Not in plan mode");
  });

  test("reports previous reason on exit", async () => {
    await executeEnterPlanMode({ reason: "architecture review" });
    const result = await executeExitPlanMode({});
    expect(result.content).toContain("architecture review");
  });
});
