// KCode - Compaction Circuit Breaker
// Prevents infinite retry loops when LLM-based compaction keeps failing

import type { CircuitBreakerConfig, CircuitBreakerState } from "./types.js";
import { log } from "../logger.js";

export class CompactionCircuitBreaker {
  private consecutiveFailures = 0;
  private isOpen = false;
  private lastFailure: Date | null = null;
  private readonly maxFailures: number;
  private readonly resetAfterMs: number;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.maxFailures = config?.maxFailures ?? 3;
    this.resetAfterMs = config?.resetAfterMs ?? 300_000; // 5 minutes
  }

  /** Register a failure. If consecutiveFailures >= max, opens the circuit. */
  recordFailure(error?: Error): void {
    this.consecutiveFailures++;
    this.lastFailure = new Date();

    if (this.consecutiveFailures >= this.maxFailures && !this.isOpen) {
      this.isOpen = true;
      log.warn(
        "compaction",
        `Circuit breaker open after ${this.consecutiveFailures} consecutive failures` +
          (error ? `: ${error.message}` : ""),
      );
    }
  }

  /** Register success. Resets the failure counter and closes the circuit. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.isOpen = false;
    this.lastFailure = null;
  }

  /**
   * Check if a compaction attempt can proceed.
   * Returns true if the circuit is closed, OR if enough time has passed
   * since the last failure (half-open state for retry).
   */
  canAttempt(): boolean {
    if (!this.isOpen) return true;

    // Check if enough time has passed for auto-reset (half-open)
    if (this.lastFailure) {
      const elapsed = Date.now() - this.lastFailure.getTime();
      if (elapsed >= this.resetAfterMs) {
        log.info("compaction", "Circuit breaker auto-reset after cooldown period");
        this.reset();
        return true;
      }
    }

    return false;
  }

  /** Manually reset the circuit breaker. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.isOpen = false;
    this.lastFailure = null;
  }

  /** Get the current state for inspection/debugging. */
  getState(): CircuitBreakerState {
    return {
      consecutiveFailures: this.consecutiveFailures,
      maxFailures: this.maxFailures,
      isOpen: this.isOpen,
      lastFailure: this.lastFailure,
      resetAfterMs: this.resetAfterMs,
    };
  }
}
