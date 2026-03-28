// KCode - MCP Health Monitor & Aliases Tests
// Tests for circuit breaker logic, health recording, latency tracking, and tool aliases

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { McpHealthMonitor, type ServerHealth } from "./mcp-health";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Health Monitor Tests ───────────────────────────────────────

describe("McpHealthMonitor", () => {
  let monitor: McpHealthMonitor;

  beforeEach(() => {
    monitor = new McpHealthMonitor({ failureThreshold: 3, resetTimeoutMs: 100, halfOpenMaxAttempts: 2 });
  });

  test("unknown status for untracked server", () => {
    const health = monitor.getHealth("nonexistent");
    expect(health.status).toBe("unknown");
    expect(health.totalRequests).toBe(0);
    expect(health.circuitOpen).toBe(false);
  });

  test("records success and tracks latency", () => {
    monitor.recordSuccess("server-a", 50);
    monitor.recordSuccess("server-a", 100);
    monitor.recordSuccess("server-a", 150);

    const health = monitor.getHealth("server-a");
    expect(health.status).toBe("healthy");
    expect(health.totalRequests).toBe(3);
    expect(health.totalFailures).toBe(0);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.averageLatencyMs).toBe(100); // (50+100+150)/3
  });

  test("records failure and updates consecutive count", () => {
    monitor.recordFailure("server-b", "timeout");
    monitor.recordFailure("server-b", "connection refused");

    const health = monitor.getHealth("server-b");
    expect(health.consecutiveFailures).toBe(2);
    expect(health.totalFailures).toBe(2);
    expect(health.totalRequests).toBe(2);
    expect(health.status).toBe("degraded");
  });

  test("success resets consecutive failure count", () => {
    monitor.recordFailure("server-c");
    monitor.recordFailure("server-c");
    expect(monitor.getHealth("server-c").consecutiveFailures).toBe(2);

    monitor.recordSuccess("server-c", 50);
    const health = monitor.getHealth("server-c");
    expect(health.consecutiveFailures).toBe(0);
    expect(health.totalFailures).toBe(2); // total doesn't reset
    expect(health.status).toBe("healthy");
  });

  test("circuit opens after failure threshold", () => {
    monitor.recordFailure("server-d");
    monitor.recordFailure("server-d");
    expect(monitor.isCircuitOpen("server-d")).toBe(false);

    monitor.recordFailure("server-d"); // 3rd = threshold
    expect(monitor.isCircuitOpen("server-d")).toBe(true);
    expect(monitor.getHealth("server-d").circuitOpen).toBe(true);
    expect(monitor.getHealth("server-d").status).toBe("down");
  });

  test("circuit allows half-open probe after timeout", async () => {
    // Use a very short reset timeout
    monitor = new McpHealthMonitor({ failureThreshold: 2, resetTimeoutMs: 50, halfOpenMaxAttempts: 1 });

    monitor.recordFailure("server-e");
    monitor.recordFailure("server-e");
    expect(monitor.isCircuitOpen("server-e")).toBe(true);

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 60));

    // Should allow the probe through
    expect(monitor.isCircuitOpen("server-e")).toBe(false);
  });

  test("circuit closes after enough half-open successes", async () => {
    monitor = new McpHealthMonitor({ failureThreshold: 2, resetTimeoutMs: 30, halfOpenMaxAttempts: 2 });

    monitor.recordFailure("server-f");
    monitor.recordFailure("server-f");
    expect(monitor.isCircuitOpen("server-f")).toBe(true);

    // Wait for timeout to allow half-open
    await new Promise((r) => setTimeout(r, 40));

    // First half-open success
    monitor.recordSuccess("server-f", 50);
    // Circuit is still in half-open (need 2 successes)
    const midHealth = monitor.getHealth("server-f");
    expect(midHealth.status).not.toBe("down"); // transitioning

    // Second half-open success — circuit should close
    monitor.recordSuccess("server-f", 40);
    const health = monitor.getHealth("server-f");
    expect(health.circuitOpen).toBe(false);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.status).toBe("healthy");
  });

  test("half-open failure re-opens circuit", async () => {
    monitor = new McpHealthMonitor({ failureThreshold: 2, resetTimeoutMs: 30, halfOpenMaxAttempts: 2 });

    monitor.recordFailure("server-g");
    monitor.recordFailure("server-g");
    expect(monitor.isCircuitOpen("server-g")).toBe(true);

    await new Promise((r) => setTimeout(r, 40));

    // Probe fails — circuit should re-open
    monitor.recordFailure("server-g", "still broken");
    expect(monitor.isCircuitOpen("server-g")).toBe(true);
    expect(monitor.getHealth("server-g").status).toBe("down");
  });

  test("manual reset clears circuit breaker", () => {
    monitor.recordFailure("server-h");
    monitor.recordFailure("server-h");
    monitor.recordFailure("server-h");
    expect(monitor.isCircuitOpen("server-h")).toBe(true);

    monitor.resetCircuit("server-h");
    expect(monitor.isCircuitOpen("server-h")).toBe(false);
    expect(monitor.getHealth("server-h").consecutiveFailures).toBe(0);
  });

  test("getAllHealth returns all tracked servers", () => {
    monitor.recordSuccess("alpha", 10);
    monitor.recordFailure("beta");

    const all = monitor.getAllHealth();
    expect(all.length).toBe(2);
    const names = all.map((h) => h.serverName).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  test("formatHealthReport returns formatted output", () => {
    monitor.recordSuccess("my-server", 42);
    monitor.recordFailure("bad-server");
    monitor.recordFailure("bad-server");
    monitor.recordFailure("bad-server");

    const report = monitor.formatHealthReport();
    expect(report).toContain("MCP Server Health:");
    expect(report).toContain("my-server");
    expect(report).toContain("bad-server");
    expect(report).toContain("healthy");
    expect(report).toContain("down");
  });

  test("formatHealthReport handles empty state", () => {
    const report = monitor.formatHealthReport();
    expect(report).toContain("No MCP server health data");
  });

  test("latency rolling window caps at 20 entries", () => {
    for (let i = 1; i <= 25; i++) {
      monitor.recordSuccess("server-lat", i * 10);
    }
    // Average should be based on the last 20 entries (60..250)
    const health = monitor.getHealth("server-lat");
    expect(health.totalRequests).toBe(25);
    // Last 20: 60,70,...,250 => sum=3100, avg=155
    expect(health.averageLatencyMs).toBe(155);
  });

  test("isCircuitOpen returns false for unknown servers", () => {
    expect(monitor.isCircuitOpen("never-seen")).toBe(false);
  });

  test("resetCircuit is safe on unknown servers", () => {
    // Should not throw
    monitor.resetCircuit("does-not-exist");
    expect(monitor.isCircuitOpen("does-not-exist")).toBe(false);
  });
});

// ─── Alias Tests ────────────────────────────────────────────────

// Note: alias tests use the real awareness.db via getDb().
// We test at the module level to verify DB integration.

describe("MCP Tool Aliases", () => {
  // Use dynamic import so the DB schema is created on demand
  let addAlias: typeof import("./mcp-aliases").addAlias;
  let removeAlias: typeof import("./mcp-aliases").removeAlias;
  let resolveAlias: typeof import("./mcp-aliases").resolveAlias;
  let listAliases: typeof import("./mcp-aliases").listAliases;

  beforeEach(async () => {
    const mod = await import("./mcp-aliases");
    addAlias = mod.addAlias;
    removeAlias = mod.removeAlias;
    resolveAlias = mod.resolveAlias;
    listAliases = mod.listAliases;

    // Clean up any leftover test aliases
    for (const alias of listAliases()) {
      if (alias.alias.startsWith("test_")) {
        removeAlias(alias.alias);
      }
    }
  });

  test("add and resolve alias", () => {
    addAlias("test_search", "mcp__github__search_repos", "Search GitHub repos");
    expect(resolveAlias("test_search")).toBe("mcp__github__search_repos");
  });

  test("resolveAlias returns original name for non-aliases", () => {
    expect(resolveAlias("not_an_alias_xyz")).toBe("not_an_alias_xyz");
  });

  test("listAliases returns all aliases", () => {
    addAlias("test_a", "mcp__s1__tool1");
    addAlias("test_b", "mcp__s2__tool2", "second alias");

    const all = listAliases();
    const testAliases = all.filter((a) => a.alias.startsWith("test_"));
    expect(testAliases.length).toBeGreaterThanOrEqual(2);

    const aliasA = testAliases.find((a) => a.alias === "test_a");
    expect(aliasA?.target).toBe("mcp__s1__tool1");
  });

  test("removeAlias deletes alias", () => {
    addAlias("test_remove_me", "mcp__s__t");
    expect(resolveAlias("test_remove_me")).toBe("mcp__s__t");

    const removed = removeAlias("test_remove_me");
    expect(removed).toBe(true);
    expect(resolveAlias("test_remove_me")).toBe("test_remove_me");
  });

  test("removeAlias returns false for non-existent alias", () => {
    const removed = removeAlias("test_nonexistent_alias_xyz");
    expect(removed).toBe(false);
  });

  // Clean up all test aliases after the suite
  afterAll(async () => {
    try {
      const mod = await import("./mcp-aliases");
      for (const alias of mod.listAliases()) {
        if (alias.alias.startsWith("test_")) {
          mod.removeAlias(alias.alias);
        }
      }
    } catch { /* ignore cleanup errors */ }
  });
});
