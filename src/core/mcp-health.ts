// KCode - MCP Health Monitor & Circuit Breaker
// Tracks MCP server health, latency, and implements a lightweight circuit breaker
// that uses timestamp checks instead of background timers.

import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export interface ServerHealth {
  serverName: string;
  status: "healthy" | "degraded" | "down" | "unknown";
  lastCheck: number;
  lastSuccess: number;
  consecutiveFailures: number;
  averageLatencyMs: number;
  circuitOpen: boolean;
  totalRequests: number;
  totalFailures: number;
}

export interface CircuitBreakerConfig {
  /** Consecutive failures before opening the circuit (default: 5) */
  failureThreshold: number;
  /** Time in ms before attempting a half-open probe (default: 30000) */
  resetTimeoutMs: number;
  /** Successful probes in half-open state before closing the circuit (default: 2) */
  halfOpenMaxAttempts: number;
}

// ─── Internal State ─────────────────────────────────────────────

interface ServerState {
  serverName: string;
  lastCheck: number;
  lastSuccess: number;
  consecutiveFailures: number;
  latencies: number[];          // rolling window of last N latencies
  circuitOpenedAt: number;      // timestamp when circuit was opened (0 = closed)
  halfOpenSuccesses: number;    // successful probes in half-open state
  totalRequests: number;
  totalFailures: number;
}

const MAX_LATENCY_WINDOW = 20;
const DEGRADED_THRESHOLD = 2; // consecutive failures before "degraded" status

// ─── McpHealthMonitor ───────────────────────────────────────────

export class McpHealthMonitor {
  private config: CircuitBreakerConfig;
  private states = new Map<string, ServerState>();

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = {
      failureThreshold: config?.failureThreshold ?? 5,
      resetTimeoutMs: config?.resetTimeoutMs ?? 30_000,
      halfOpenMaxAttempts: config?.halfOpenMaxAttempts ?? 2,
    };
  }

  /**
   * Record a successful request to a server.
   */
  recordSuccess(serverName: string, latencyMs: number): void {
    const state = this.getOrCreateState(serverName);
    const now = Date.now();

    state.lastCheck = now;
    state.lastSuccess = now;
    state.totalRequests++;

    // Push latency into rolling window
    state.latencies.push(latencyMs);
    if (state.latencies.length > MAX_LATENCY_WINDOW) {
      state.latencies.shift();
    }

    // If circuit was half-open, count toward closing it
    if (state.circuitOpenedAt > 0) {
      state.halfOpenSuccesses++;
      if (state.halfOpenSuccesses >= this.config.halfOpenMaxAttempts) {
        // Close the circuit — server has recovered
        state.circuitOpenedAt = 0;
        state.halfOpenSuccesses = 0;
        state.consecutiveFailures = 0;
        log.info("mcp-health", `Circuit closed for "${serverName}" — server recovered`);
      }
    } else {
      state.consecutiveFailures = 0;
    }
  }

  /**
   * Record a failed request to a server.
   */
  recordFailure(serverName: string, error?: string): void {
    const state = this.getOrCreateState(serverName);
    const now = Date.now();

    state.lastCheck = now;
    state.totalRequests++;
    state.totalFailures++;
    state.consecutiveFailures++;

    // If in half-open state, re-open immediately on failure
    if (state.circuitOpenedAt > 0) {
      state.circuitOpenedAt = now;
      state.halfOpenSuccesses = 0;
      log.warn("mcp-health", `Circuit re-opened for "${serverName}" — half-open probe failed${error ? ": " + error : ""}`);
      return;
    }

    // Open the circuit if failure threshold is reached
    if (state.consecutiveFailures >= this.config.failureThreshold) {
      state.circuitOpenedAt = now;
      state.halfOpenSuccesses = 0;
      log.warn("mcp-health", `Circuit opened for "${serverName}" after ${state.consecutiveFailures} consecutive failures`);
    }
  }

  /**
   * Check if the circuit breaker is open (requests should be blocked).
   * Returns false if the circuit is closed or if it's time for a half-open probe.
   */
  isCircuitOpen(serverName: string): boolean {
    const state = this.states.get(serverName);
    if (!state || state.circuitOpenedAt === 0) return false;

    const elapsed = Date.now() - state.circuitOpenedAt;
    if (elapsed >= this.config.resetTimeoutMs) {
      // Allow a half-open probe — don't block this request
      return false;
    }

    return true;
  }

  /**
   * Get health info for a single server.
   */
  getHealth(serverName: string): ServerHealth {
    const state = this.states.get(serverName);
    if (!state) {
      return {
        serverName,
        status: "unknown",
        lastCheck: 0,
        lastSuccess: 0,
        consecutiveFailures: 0,
        averageLatencyMs: 0,
        circuitOpen: false,
        totalRequests: 0,
        totalFailures: 0,
      };
    }

    return {
      serverName: state.serverName,
      status: this.computeStatus(state),
      lastCheck: state.lastCheck,
      lastSuccess: state.lastSuccess,
      consecutiveFailures: state.consecutiveFailures,
      averageLatencyMs: this.computeAverageLatency(state),
      circuitOpen: state.circuitOpenedAt > 0 && (Date.now() - state.circuitOpenedAt) < this.config.resetTimeoutMs,
      totalRequests: state.totalRequests,
      totalFailures: state.totalFailures,
    };
  }

  /**
   * Get health info for all tracked servers.
   */
  getAllHealth(): ServerHealth[] {
    return Array.from(this.states.keys()).map((name) => this.getHealth(name));
  }

  /**
   * Manually reset the circuit breaker for a server.
   */
  resetCircuit(serverName: string): void {
    const state = this.states.get(serverName);
    if (state) {
      state.circuitOpenedAt = 0;
      state.halfOpenSuccesses = 0;
      state.consecutiveFailures = 0;
      log.info("mcp-health", `Circuit manually reset for "${serverName}"`);
    }
  }

  /**
   * Format a human-readable health report table for all tracked servers.
   */
  formatHealthReport(): string {
    const allHealth = this.getAllHealth();
    if (allHealth.length === 0) {
      return "  No MCP server health data available.";
    }

    const lines: string[] = ["  MCP Server Health:"];
    lines.push("  " + "-".repeat(72));
    lines.push("  " + padRight("Server", 20) + padRight("Status", 12) + padRight("Circuit", 10) + padRight("Failures", 10) + padRight("Avg Latency", 12) + "Requests");
    lines.push("  " + "-".repeat(72));

    for (const h of allHealth) {
      const statusIcon = h.status === "healthy" ? "\x1b[32m●\x1b[0m" :
                         h.status === "degraded" ? "\x1b[33m●\x1b[0m" :
                         h.status === "down" ? "\x1b[31m●\x1b[0m" : "\x1b[90m●\x1b[0m";
      const circuitLabel = h.circuitOpen ? "\x1b[31mOPEN\x1b[0m" : "\x1b[32mclosed\x1b[0m";
      const latency = h.averageLatencyMs > 0 ? `${Math.round(h.averageLatencyMs)}ms` : "-";

      lines.push(
        "  " +
        padRight(h.serverName, 20) +
        statusIcon + " " + padRight(h.status, 10) +
        padRight(circuitLabel.length > 10 ? circuitLabel : circuitLabel, 10) +
        padRight(String(h.totalFailures), 10) +
        padRight(latency, 12) +
        String(h.totalRequests)
      );
    }

    lines.push("  " + "-".repeat(72));
    return lines.join("\n");
  }

  // ─── Private ──────────────────────────────────────────────────

  private getOrCreateState(serverName: string): ServerState {
    let state = this.states.get(serverName);
    if (!state) {
      state = {
        serverName,
        lastCheck: 0,
        lastSuccess: 0,
        consecutiveFailures: 0,
        latencies: [],
        circuitOpenedAt: 0,
        halfOpenSuccesses: 0,
        totalRequests: 0,
        totalFailures: 0,
      };
      this.states.set(serverName, state);
    }
    return state;
  }

  private computeStatus(state: ServerState): ServerHealth["status"] {
    // Circuit is open and not yet timed out — server is down
    if (state.circuitOpenedAt > 0 && (Date.now() - state.circuitOpenedAt) < this.config.resetTimeoutMs) {
      return "down";
    }
    // Circuit is in half-open recovery (timed out, but not yet closed)
    if (state.circuitOpenedAt > 0 && state.halfOpenSuccesses > 0) {
      return "degraded";
    }
    if (state.consecutiveFailures >= this.config.failureThreshold) {
      return "down";
    }
    if (state.consecutiveFailures >= DEGRADED_THRESHOLD) {
      return "degraded";
    }
    if (state.totalRequests === 0) {
      return "unknown";
    }
    return "healthy";
  }

  private computeAverageLatency(state: ServerState): number {
    if (state.latencies.length === 0) return 0;
    const sum = state.latencies.reduce((a, b) => a + b, 0);
    return sum / state.latencies.length;
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function padRight(str: string, len: number): string {
  // Strip ANSI codes for length calculation
  const visible = str.replace(/\x1b\[[0-9;]*m/g, "");
  if (visible.length >= len) return str;
  return str + " ".repeat(len - visible.length);
}
