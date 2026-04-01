import { describe, expect, test } from "bun:test";
import { type CircuitBreakerState, CompactionManager } from "./compaction.ts";

describe("CompactionManager", () => {
  test("can be instantiated", () => {
    const manager = new CompactionManager("test-key", "test-model", "http://localhost:1234");
    expect(manager).toBeDefined();
  });

  test("getCompactionCount starts at 0", () => {
    const manager = new CompactionManager();
    expect(manager.getCompactionCount()).toBe(0);
  });

  test("reset resets compaction count", () => {
    const manager = new CompactionManager();
    manager.reset();
    expect(manager.getCompactionCount()).toBe(0);
  });

  test("compact returns null for empty messages", async () => {
    const manager = new CompactionManager();
    const result = await manager.compact([]);
    expect(result).toBeNull();
  });
});

describe("Circuit Breaker", () => {
  test("starts with 0 failures and not tripped", () => {
    const manager = new CompactionManager();
    const state = manager.getCircuitBreakerState();
    expect(state.failures).toBe(0);
    expect(state.tripped).toBe(false);
  });

  test("compact returns null when circuit breaker is tripped", async () => {
    const manager = new CompactionManager("key", "model", "http://localhost:99999");

    // Force 3 failures by calling compact with unreachable server
    for (let i = 0; i < 3; i++) {
      await manager.compact([
        {
          role: "user",
          content: [{ type: "text", text: "test message" }],
        },
      ]);
    }

    const state = manager.getCircuitBreakerState();
    expect(state.failures).toBe(3);
    expect(state.tripped).toBe(true);

    // Further compaction attempts return null immediately
    const result = await manager.compact([
      {
        role: "user",
        content: [{ type: "text", text: "another test" }],
      },
    ]);
    expect(result).toBeNull();
    // Failures should not increment further since we short-circuit
    expect(manager.getCircuitBreakerState().failures).toBe(3);
  });

  test("resetCircuitBreaker re-enables compaction", async () => {
    const manager = new CompactionManager("key", "model", "http://localhost:99999");

    // Trip the circuit breaker
    for (let i = 0; i < 3; i++) {
      await manager.compact([
        {
          role: "user",
          content: [{ type: "text", text: "test" }],
        },
      ]);
    }
    expect(manager.getCircuitBreakerState().tripped).toBe(true);

    manager.resetCircuitBreaker();
    const state = manager.getCircuitBreakerState();
    expect(state.failures).toBe(0);
    expect(state.tripped).toBe(false);
  });

  test("circuit breaker does not trip with fewer than 3 failures", async () => {
    const manager = new CompactionManager("key", "model", "http://localhost:99999");

    // Only 2 failures
    for (let i = 0; i < 2; i++) {
      await manager.compact([
        {
          role: "user",
          content: [{ type: "text", text: "test" }],
        },
      ]);
    }

    const state = manager.getCircuitBreakerState();
    expect(state.failures).toBe(2);
    expect(state.tripped).toBe(false);
  });
});
