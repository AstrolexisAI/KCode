import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS, PolicyEngine } from "./limits";

describe("PolicyEngine", () => {
  let engine: PolicyEngine;

  describe("defaults", () => {
    beforeEach(() => {
      engine = new PolicyEngine();
    });

    test("default limits allow everything", () => {
      expect(engine.checkRequest(100000).allowed).toBe(true);
      expect(engine.checkToolCall("Bash").allowed).toBe(true);
      expect(engine.checkAgentSpawn().allowed).toBe(true);
      expect(engine.checkBudget(100).allowed).toBe(true);
      expect(engine.checkModel("gpt-4").allowed).toBe(true);
    });

    test("DEFAULT_LIMITS has sensible values", () => {
      expect(DEFAULT_LIMITS.maxTokensPerSession).toBe(0);
      expect(DEFAULT_LIMITS.maxToolCallsPerTurn).toBe(50);
      expect(DEFAULT_LIMITS.maxConcurrentAgents).toBe(10);
      expect(DEFAULT_LIMITS.blockedTools).toEqual([]);
      expect(DEFAULT_LIMITS.allowedModels).toEqual([]);
    });
  });

  describe("token limits", () => {
    beforeEach(() => {
      engine = new PolicyEngine({ maxTokensPerSession: 10000 });
    });

    test("allows requests under limit", () => {
      expect(engine.checkRequest(5000).allowed).toBe(true);
    });

    test("blocks requests over limit", () => {
      engine.recordUsage(9000, 0);
      const result = engine.checkRequest(2000);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.violation.type).toBe("token_limit");
        expect(result.violation.current).toBe(9000);
        expect(result.violation.limit).toBe(10000);
      }
    });

    test("allows request exactly at limit", () => {
      engine.recordUsage(5000, 0);
      expect(engine.checkRequest(5000).allowed).toBe(true);
    });

    test("blocks request one over limit", () => {
      engine.recordUsage(5000, 0);
      const result = engine.checkRequest(5001);
      expect(result.allowed).toBe(false);
    });
  });

  describe("tool call limits", () => {
    beforeEach(() => {
      engine = new PolicyEngine({ maxToolCallsPerTurn: 3 });
    });

    test("allows tool calls under limit", () => {
      engine.recordToolCall();
      engine.recordToolCall();
      expect(engine.checkToolCall("Read").allowed).toBe(true);
    });

    test("blocks at limit", () => {
      engine.recordToolCall();
      engine.recordToolCall();
      engine.recordToolCall();
      const result = engine.checkToolCall("Read");
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.violation.type).toBe("tool_limit");
      }
    });

    test("resetTurnToolCalls resets the counter", () => {
      engine.recordToolCall();
      engine.recordToolCall();
      engine.recordToolCall();
      engine.resetTurnToolCalls();
      expect(engine.checkToolCall("Read").allowed).toBe(true);
    });
  });

  describe("blocked tools", () => {
    beforeEach(() => {
      engine = new PolicyEngine({ blockedTools: ["Bash", "Write"] });
    });

    test("blocks listed tools", () => {
      const result = engine.checkToolCall("Bash");
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.violation.type).toBe("blocked_tool");
        expect(result.violation.message).toContain("Bash");
      }
    });

    test("allows unlisted tools", () => {
      expect(engine.checkToolCall("Read").allowed).toBe(true);
      expect(engine.checkToolCall("Glob").allowed).toBe(true);
    });
  });

  describe("model allowlist", () => {
    beforeEach(() => {
      engine = new PolicyEngine({
        allowedModels: ["claude-3-opus", "gpt-4"],
      });
    });

    test("allows listed models", () => {
      expect(engine.checkModel("claude-3-opus").allowed).toBe(true);
      expect(engine.checkModel("gpt-4").allowed).toBe(true);
    });

    test("blocks unlisted models", () => {
      const result = engine.checkModel("llama-7b");
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.violation.type).toBe("blocked_model");
      }
    });

    test("empty allowlist means all allowed", () => {
      const e = new PolicyEngine({ allowedModels: [] });
      expect(e.checkModel("anything").allowed).toBe(true);
    });
  });

  describe("agent limits", () => {
    beforeEach(() => {
      engine = new PolicyEngine({ maxConcurrentAgents: 2 });
    });

    test("allows up to limit", () => {
      engine.recordAgentSpawn();
      expect(engine.checkAgentSpawn().allowed).toBe(true);
    });

    test("blocks at limit", () => {
      engine.recordAgentSpawn();
      engine.recordAgentSpawn();
      const result = engine.checkAgentSpawn();
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.violation.type).toBe("agent_limit");
      }
    });

    test("allows after agent completes", () => {
      engine.recordAgentSpawn();
      engine.recordAgentSpawn();
      engine.recordAgentComplete();
      expect(engine.checkAgentSpawn().allowed).toBe(true);
    });

    test("recordAgentComplete does not go below 0", () => {
      engine.recordAgentComplete();
      engine.recordAgentComplete();
      const status = engine.getStatus();
      expect(status.activeAgents).toBe(0);
    });
  });

  describe("rate limiting", () => {
    test("allows first request with no cooldown", () => {
      engine = new PolicyEngine({ minRequestIntervalMs: 1000 });
      expect(engine.checkRequest(100).allowed).toBe(true);
    });

    test("blocks rapid requests", () => {
      engine = new PolicyEngine({ minRequestIntervalMs: 1000 });
      engine.recordUsage(100, 0); // sets lastRequestTime
      const result = engine.checkRequest(100);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.violation.type).toBe("rate_limit");
      }
    });

    test("allows after cooldown", async () => {
      engine = new PolicyEngine({ minRequestIntervalMs: 50 });
      engine.recordUsage(100, 0);
      await Bun.sleep(60);
      expect(engine.checkRequest(100).allowed).toBe(true);
    });
  });

  describe("budget limits", () => {
    test("session budget blocks when exceeded", () => {
      engine = new PolicyEngine({ maxBudgetUsd: 1.0 });
      engine.recordUsage(1000, 0.8);
      const result = engine.checkBudget(0.3);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.violation.type).toBe("budget_limit");
        expect(result.violation.message).toContain("Session");
      }
    });

    test("daily budget blocks when exceeded", () => {
      engine = new PolicyEngine({ maxDailyBudgetUsd: 5.0 });
      engine.recordUsage(100000, 4.8);
      const result = engine.checkBudget(0.3);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.violation.type).toBe("budget_limit");
        expect(result.violation.message).toContain("Daily");
      }
    });

    test("allows when under budget", () => {
      engine = new PolicyEngine({ maxBudgetUsd: 10.0 });
      engine.recordUsage(1000, 2.0);
      expect(engine.checkBudget(1.0).allowed).toBe(true);
    });
  });

  describe("getStatus", () => {
    test("returns current snapshot", () => {
      engine = new PolicyEngine({ maxTokensPerSession: 5000 });
      engine.recordUsage(1000, 0.5);
      engine.recordToolCall();
      engine.recordToolCall();
      engine.recordAgentSpawn();

      const status = engine.getStatus();
      expect(status.sessionTokensUsed).toBe(1000);
      expect(status.sessionCostUsd).toBe(0.5);
      expect(status.turnToolCalls).toBe(2);
      expect(status.activeAgents).toBe(1);
      expect(status.limits.maxTokensPerSession).toBe(5000);
    });
  });

  describe("updateLimits", () => {
    test("updates limits at runtime", () => {
      engine = new PolicyEngine({ maxTokensPerSession: 1000 });
      engine.recordUsage(900, 0);
      expect(engine.checkRequest(200).allowed).toBe(false);

      engine.updateLimits({ maxTokensPerSession: 5000 });
      expect(engine.checkRequest(200).allowed).toBe(true);
    });
  });
});
