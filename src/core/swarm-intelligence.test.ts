import { test, expect, describe, beforeEach } from "bun:test";
import { SwarmIntelligence, DEFAULT_AGENT_SPECS } from "./swarm-intelligence";

describe("SwarmIntelligence", () => {
  let swarm: SwarmIntelligence;

  beforeEach(() => {
    swarm = new SwarmIntelligence();
  });

  describe("agent management", () => {
    test("addAgent creates agent with correct role", () => {
      const agent = swarm.addAgent("backend", "gpt-4o");
      expect(agent.role).toBe("backend");
      expect(agent.model).toBe("gpt-4o");
      expect(agent.specialization).toContain("backend");
    });

    test("createDefaultSwarm creates 5 agents", () => {
      const agents = swarm.createDefaultSwarm("test-model");
      expect(agents).toHaveLength(5);
      expect(agents.map(a => a.role)).toContain("architect");
      expect(agents.map(a => a.role)).toContain("security");
    });
  });

  describe("task distribution", () => {
    test("assigns files to agents by pattern", () => {
      swarm.addAgent("frontend", "m1");
      swarm.addAgent("backend", "m2");

      const plan = swarm.planDistribution("fix bugs", [
        "src/ui/App.tsx",
        "src/core/config.ts",
      ]);

      expect(plan.assignments.length).toBeGreaterThanOrEqual(1);
      expect(plan.status).toBe("planning");
    });

    test("architect gets priority on shared files", () => {
      swarm.addAgent("architect", "m1");
      swarm.addAgent("backend", "m2");

      const plan = swarm.planDistribution("review", ["src/core/types.ts"]);
      // types.ts matches architect's pattern (**/*.ts via index.ts patterns)
      expect(plan.assignments.length).toBeGreaterThanOrEqual(1);
    });

    test("unassigned files go to general agent", () => {
      swarm.addAgent("frontend", "m1");
      swarm.addAgent("general", "m2");

      const plan = swarm.planDistribution("review", [
        "random/unknown.xyz",
      ]);

      const generalAssignment = plan.assignments.find(
        (a) => a.agentId.includes("general"),
      );
      expect(generalAssignment).toBeDefined();
    });
  });

  describe("conflict resolution", () => {
    test("prefer-higher-priority selects correct agent", () => {
      swarm.addAgent("security", "m1");  // priority 8
      swarm.addAgent("frontend", "m2");  // priority 5

      const resolution = swarm.resolveConflict(
        "src/ui/auth.tsx",
        ["security-0", "frontend-1"],
        "prefer-higher-priority",
      );

      expect(resolution.resolvedBy).toBe("security-0");
    });

    test("architect-decides delegates to architect", () => {
      swarm.addAgent("architect", "m1");
      swarm.addAgent("backend", "m2");

      const resolution = swarm.resolveConflict(
        "src/core/api.ts",
        ["architect-0", "backend-1"],
        "architect-decides",
      );

      expect(resolution.resolvedBy).toBe("architect-0");
    });

    test("tracks conflicts", () => {
      swarm.addAgent("backend", "m1");
      swarm.resolveConflict("a.ts", ["backend-0"], "prefer-higher-priority");
      swarm.resolveConflict("b.ts", ["backend-0"], "prefer-higher-priority");
      expect(swarm.getState().conflictCount).toBe(2);
    });
  });

  describe("messaging", () => {
    test("sendMessage records message", () => {
      swarm.sendMessage({
        fromAgent: "backend-0",
        toAgent: "broadcast",
        type: "proposal",
        content: "I suggest we refactor the API",
        timestamp: Date.now(),
      });
      expect(swarm.getState().messageCount).toBe(1);
    });
  });

  describe("learnings", () => {
    test("addLearning records insight", () => {
      swarm.addLearning("API endpoints should use consistent naming");
      expect(swarm.getState().learnings).toHaveLength(1);
    });
  });

  describe("DEFAULT_AGENT_SPECS", () => {
    test("all roles have specializations", () => {
      for (const [role, spec] of Object.entries(DEFAULT_AGENT_SPECS)) {
        expect(spec.specialization.length).toBeGreaterThan(0);
        expect(spec.filePatterns.length).toBeGreaterThan(0);
        expect(spec.priority).toBeGreaterThan(0);
      }
    });
  });

  describe("reset", () => {
    test("clears all state", () => {
      swarm.createDefaultSwarm("m1");
      swarm.addLearning("test");
      swarm.reset();
      const state = swarm.getState();
      expect(state.agents).toHaveLength(0);
      expect(state.learnings).toHaveLength(0);
    });
  });
});
