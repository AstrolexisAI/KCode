// Tests for AutoAgentManager — plan evaluation + spawn orchestration
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AutoAgentManager, type AgentStatus } from "./auto-agents";
import type { Plan, PlanStep } from "../tools/plan";
import type { KCodeConfig } from "./types";

const mockConfig: KCodeConfig = {
  model: "claude-opus-4-6",
  workingDirectory: "/tmp/test-cwd",
  permissionMode: "ask",
  maxTokens: 4096,
  version: "test",
};

function makeMockPlan(steps: PlanStep[]): Plan {
  return {
    id: "test-plan",
    title: "Test Plan",
    steps,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// Use module mocking via internal state
let mockPlan: Plan | null = null;

beforeEach(async () => {
  mockPlan = null;
  mock.module("../tools/plan.js", () => ({
    getActivePlan: () => mockPlan,
    clearActivePlan: () => {
      mockPlan = null;
    },
  }));
});

afterEach(() => {
  mockPlan = null;
});

describe("AutoAgentManager — evaluate", () => {
  test("returns shouldSpawn=false when no active plan", async () => {
    const statuses: AgentStatus[] = [];
    const mgr = new AutoAgentManager(
      { cwd: "/tmp", model: "m", config: mockConfig },
      (s) => {
        statuses.push(...s);
      },
    );
    const result = await mgr.evaluate();
    expect(result.shouldSpawn).toBe(false);
    expect(result.steps).toEqual([]);
  });

  test("returns shouldSpawn=false when plan has fewer than minPendingSteps", async () => {
    mockPlan = makeMockPlan([
      { id: "1", title: "Step 1", status: "pending" },
      { id: "2", title: "Step 2", status: "pending" },
    ]);
    const mgr = new AutoAgentManager(
      { cwd: "/tmp", model: "m", config: mockConfig, minPendingSteps: 3 },
      () => {},
    );
    const result = await mgr.evaluate();
    expect(result.shouldSpawn).toBe(false);
  });

  test("returns shouldSpawn=true with steps when threshold reached", async () => {
    mockPlan = makeMockPlan([
      { id: "1", title: "Fix bug A", status: "pending" },
      { id: "2", title: "Add test B", status: "pending" },
      { id: "3", title: "Refactor C", status: "pending" },
      { id: "4", title: "Document D", status: "pending" },
    ]);
    const mgr = new AutoAgentManager(
      { cwd: "/tmp", model: "m", config: mockConfig, minPendingSteps: 3 },
      () => {},
    );
    const result = await mgr.evaluate();
    expect(result.shouldSpawn).toBe(true);
    expect(result.steps.length).toBe(4);
    expect(result.steps[0]).toEqual({ id: "1", title: "Fix bug A" });
  });

  test("caps steps at maxAgents", async () => {
    mockPlan = makeMockPlan([
      { id: "1", title: "A", status: "pending" },
      { id: "2", title: "B", status: "pending" },
      { id: "3", title: "C", status: "pending" },
      { id: "4", title: "D", status: "pending" },
      { id: "5", title: "E", status: "pending" },
      { id: "6", title: "F", status: "pending" },
    ]);
    const mgr = new AutoAgentManager(
      { cwd: "/tmp", model: "m", config: mockConfig, minPendingSteps: 3, maxAgents: 2 },
      () => {},
    );
    const result = await mgr.evaluate();
    expect(result.steps.length).toBe(2);
  });

  test("only counts pending steps (ignores done/in_progress)", async () => {
    mockPlan = makeMockPlan([
      { id: "1", title: "A", status: "done" },
      { id: "2", title: "B", status: "in_progress" },
      { id: "3", title: "C", status: "pending" },
      { id: "4", title: "D", status: "pending" },
    ]);
    const mgr = new AutoAgentManager(
      { cwd: "/tmp", model: "m", config: mockConfig, minPendingSteps: 3 },
      () => {},
    );
    const result = await mgr.evaluate();
    // Only 2 pending, below threshold
    expect(result.shouldSpawn).toBe(false);
  });
});

describe("AutoAgentManager — state", () => {
  test("starts inactive", () => {
    const mgr = new AutoAgentManager(
      { cwd: "/tmp", model: "m", config: mockConfig },
      () => {},
    );
    expect(mgr.isActive()).toBe(false);
  });

  test("getStatuses returns empty array initially", () => {
    const mgr = new AutoAgentManager(
      { cwd: "/tmp", model: "m", config: mockConfig },
      () => {},
    );
    expect(mgr.getStatuses()).toEqual([]);
  });

  test("getResults returns empty array when no agents completed", () => {
    const mgr = new AutoAgentManager(
      { cwd: "/tmp", model: "m", config: mockConfig },
      () => {},
    );
    expect(mgr.getResults()).toEqual([]);
  });
});

describe("AutoAgentManager — config defaults", () => {
  test("uses default minPendingSteps of 3", async () => {
    mockPlan = makeMockPlan([
      { id: "1", title: "A", status: "pending" },
      { id: "2", title: "B", status: "pending" },
    ]);
    const mgr = new AutoAgentManager(
      { cwd: "/tmp", model: "m", config: mockConfig },
      () => {},
    );
    const result = await mgr.evaluate();
    // Default 3, only 2 pending
    expect(result.shouldSpawn).toBe(false);
  });

  test("uses default maxAgents of 4", async () => {
    const steps = Array.from({ length: 10 }, (_, i) => ({
      id: String(i + 1),
      title: `Step ${i + 1}`,
      status: "pending" as const,
    }));
    mockPlan = makeMockPlan(steps);
    const mgr = new AutoAgentManager(
      { cwd: "/tmp", model: "m", config: mockConfig },
      () => {},
    );
    const result = await mgr.evaluate();
    expect(result.steps.length).toBe(4);
  });
});
