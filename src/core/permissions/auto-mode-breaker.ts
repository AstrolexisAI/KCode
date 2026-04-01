// KCode - Auto-Mode Circuit Breaker
// Prevents runaway tool execution in auto mode by tracking failures,
// denials, and suspicious patterns. Escalates to "ask" mode when tripped.

import { log } from "../logger";

export interface AutoModeBreakerConfig {
  /** Max consecutive tool failures before tripping (default: 5) */
  maxConsecutiveFailures: number;
  /** Max consecutive permission denials before tripping (default: 3) */
  maxConsecutiveDenials: number;
  /** Max tool executions per minute before rate limiting (default: 30) */
  maxToolsPerMinute: number;
  /** Auto-reset after this many milliseconds (default: 5 minutes) */
  resetAfterMs: number;
  /** Whether remote kill switch is active */
  remoteDisabled: boolean;
}

export interface BreakerState {
  isOpen: boolean;
  reason: string | null;
  consecutiveFailures: number;
  consecutiveDenials: number;
  toolExecutionsInWindow: number;
  lastTripped: Date | null;
  totalTrips: number;
}

const DEFAULT_CONFIG: AutoModeBreakerConfig = {
  maxConsecutiveFailures: 5,
  maxConsecutiveDenials: 3,
  maxToolsPerMinute: 30,
  resetAfterMs: 300_000, // 5 minutes
  remoteDisabled: false,
};

export class AutoModeBreaker {
  private config: AutoModeBreakerConfig;
  private consecutiveFailures = 0;
  private consecutiveDenials = 0;
  private toolTimestamps: number[] = [];
  private isTripped = false;
  private tripReason: string | null = null;
  private lastTripped: Date | null = null;
  private totalTrips = 0;

  /** Callback invoked when the breaker trips (for UI notification) */
  onTrip: ((reason: string) => void) | null = null;
  /** Callback invoked when the breaker resets */
  onReset: (() => void) | null = null;

  constructor(config?: Partial<AutoModeBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Check if auto-mode is currently safe to use */
  isAutoModeAllowed(): boolean {
    // Remote kill switch
    if (this.config.remoteDisabled) {
      return false;
    }

    // Check if tripped and potentially auto-reset
    if (this.isTripped) {
      if (this.lastTripped && this.config.resetAfterMs > 0) {
        const elapsed = Date.now() - this.lastTripped.getTime();
        if (elapsed >= this.config.resetAfterMs) {
          this.reset();
          return true;
        }
      }
      return false;
    }

    return true;
  }

  /** Record a successful tool execution */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.consecutiveDenials = 0;
    this.recordToolExecution();
  }

  /** Record a tool execution failure */
  recordFailure(toolName: string, error?: string): void {
    this.consecutiveFailures++;
    this.recordToolExecution();

    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      this.trip(
        `${this.consecutiveFailures} consecutive tool failures (last: ${toolName}${error ? ` — ${error.slice(0, 100)}` : ""})`,
      );
    }
  }

  /** Record a permission denial */
  recordDenial(toolName: string): void {
    this.consecutiveDenials++;

    if (this.consecutiveDenials >= this.config.maxConsecutiveDenials) {
      this.trip(
        `${this.consecutiveDenials} consecutive permission denials (last: ${toolName})`,
      );
    }
  }

  /** Check rate limit before executing a tool. Returns true if within limits. */
  checkRateLimit(): boolean {
    const now = Date.now();
    const windowStart = now - 60_000;

    // Clean old timestamps
    this.toolTimestamps = this.toolTimestamps.filter((t) => t > windowStart);

    if (this.toolTimestamps.length >= this.config.maxToolsPerMinute) {
      this.trip(
        `Rate limit exceeded: ${this.toolTimestamps.length} tools in 60s (max: ${this.config.maxToolsPerMinute})`,
      );
      return false;
    }

    return true;
  }

  /** Get the current breaker state */
  getState(): BreakerState {
    return {
      isOpen: this.isTripped,
      reason: this.tripReason,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveDenials: this.consecutiveDenials,
      toolExecutionsInWindow: this.toolTimestamps.length,
      lastTripped: this.lastTripped,
      totalTrips: this.totalTrips,
    };
  }

  /** Manually reset the breaker */
  reset(): void {
    const wasTripped = this.isTripped;
    this.isTripped = false;
    this.tripReason = null;
    this.consecutiveFailures = 0;
    this.consecutiveDenials = 0;
    this.toolTimestamps = [];

    if (wasTripped) {
      log.info("permissions", "Auto-mode circuit breaker reset");
      this.onReset?.();
    }
  }

  /** Set the remote disable flag (from marketplace config) */
  setRemoteDisabled(disabled: boolean): void {
    this.config.remoteDisabled = disabled;
    if (disabled) {
      this.trip("Remote kill switch activated");
    }
  }

  // ─── Internal ────────────────────────────────────────────────

  private trip(reason: string): void {
    if (this.isTripped) return;

    this.isTripped = true;
    this.tripReason = reason;
    this.lastTripped = new Date();
    this.totalTrips++;

    log.warn("permissions", `Auto-mode circuit breaker tripped: ${reason}`);
    this.onTrip?.(reason);
  }

  private recordToolExecution(): void {
    this.toolTimestamps.push(Date.now());
  }
}

// ─── Singleton ─────────────────────────────────────────────────

let _globalBreaker: AutoModeBreaker | null = null;

export function getAutoModeBreaker(config?: Partial<AutoModeBreakerConfig>): AutoModeBreaker {
  if (!_globalBreaker) {
    _globalBreaker = new AutoModeBreaker(config);
  }
  return _globalBreaker;
}

export function _resetAutoModeBreaker(): void {
  _globalBreaker = null;
}
