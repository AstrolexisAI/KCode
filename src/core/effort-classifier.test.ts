import { describe, expect, test } from "bun:test";
import { classifyEffort, EFFORT_PROFILES, getEffortProfile } from "./effort-classifier";

describe("effort-classifier", () => {
  describe("classifyEffort", () => {
    test("simple question → low", () => {
      const result = classifyEffort("What is this function?");
      expect(result.level).toBe("low");
    });

    test("explain request → low", () => {
      const result = classifyEffort("Explain what this code does");
      expect(result.level).toBe("low");
    });

    test("bug fix → medium", () => {
      const result = classifyEffort("Fix the bug in the login handler");
      expect(["medium", "high"]).toContain(result.level);
    });

    test("add test → medium", () => {
      const result = classifyEffort("Write a test for the parser function");
      expect(["medium", "high"]).toContain(result.level);
    });

    test("multi-file refactor → high or max", () => {
      const result = classifyEffort(
        "Refactor the authentication system across the codebase to use the new patterns",
      );
      expect(["high", "max"]).toContain(result.level);
    });

    test("performance optimization → high or max", () => {
      const result = classifyEffort(
        "Optimize the performance of the database query system across multiple modules",
      );
      expect(["high", "max"]).toContain(result.level);
    });

    test("full rewrite → max", () => {
      const result = classifyEffort(
        "Do a full rewrite of the router from scratch with a new architecture",
      );
      expect(result.level).toBe("max");
    });

    test("architect new system → max", () => {
      const result = classifyEffort("Design the architecture for a new microservices system");
      expect(result.level).toBe("max");
    });

    test("short message → tends lower", () => {
      const result = classifyEffort("ls");
      expect(["low", "medium"]).toContain(result.level);
    });

    test("returns signals", () => {
      const result = classifyEffort("Fix the bug");
      expect(result.signals.length).toBeGreaterThan(0);
    });

    test("returns confidence between 0 and 1", () => {
      const result = classifyEffort("Refactor everything");
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    test("many file references → higher effort", () => {
      const result = classifyEffort(
        "Update src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts, src/f.ts to use the new API",
      );
      expect(["high", "max"]).toContain(result.level);
    });
  });

  describe("EFFORT_PROFILES", () => {
    test("low has fewer turns", () => {
      expect(EFFORT_PROFILES.low.maxTurns).toBeLessThan(EFFORT_PROFILES.medium.maxTurns);
    });

    test("max has most turns", () => {
      expect(EFFORT_PROFILES.max.maxTurns).toBeGreaterThan(EFFORT_PROFILES.high.maxTurns);
    });

    test("low uses minimal prompt depth", () => {
      expect(EFFORT_PROFILES.low.promptDepth).toBe("minimal");
    });

    test("low has reduced reasoning multiplier", () => {
      expect(EFFORT_PROFILES.low.reasoningMultiplier).toBeLessThan(1);
    });

    test("max has highest reasoning multiplier", () => {
      expect(EFFORT_PROFILES.max.reasoningMultiplier).toBe(2.0);
    });
  });

  describe("getEffortProfile", () => {
    test("returns profile for explicit level", () => {
      expect(getEffortProfile("high")).toBe(EFFORT_PROFILES.high);
    });

    test("auto with message classifies", () => {
      const profile = getEffortProfile("auto", "What is this?");
      expect(profile.level).toBe("low");
    });

    test("auto without message defaults to medium", () => {
      const profile = getEffortProfile("auto");
      expect(profile.level).toBe("medium");
    });
  });
});
