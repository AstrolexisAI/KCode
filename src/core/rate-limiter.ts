// KCode - Rate Limiter
// Simple sliding window + semaphore rate limiter for local LLM API calls

const WINDOW_MS = 60_000; // 1 minute sliding window

export class RateLimiter {
  private maxPerMinute: number;
  private maxConcurrent: number;
  private timestamps: number[] = [];
  private activeCount = 0;
  private waitQueue: Array<() => void> = [];

  constructor(maxRequestsPerMinute: number = 60, maxConcurrent: number = 2) {
    this.maxPerMinute = maxRequestsPerMinute;
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Wait until a request slot is available (both rate limit and concurrency).
   * Resolves when the caller may proceed with the request.
   */
  async acquire(): Promise<void> {
    // Wait until we have capacity in both the sliding window and the semaphore
    while (true) {
      this.pruneOldTimestamps();

      const rateLimitOk = this.timestamps.length < this.maxPerMinute;
      const concurrencyOk = this.activeCount < this.maxConcurrent;

      if (rateLimitOk && concurrencyOk) {
        // Record this request and take a concurrency slot
        this.timestamps.push(Date.now());
        this.activeCount++;
        return;
      }

      // Need to wait - figure out how long
      if (!rateLimitOk) {
        // Wait until the oldest timestamp in the window expires
        const oldestInWindow = this.timestamps[0]!;
        const waitMs = oldestInWindow + WINDOW_MS - Date.now() + 1;
        if (waitMs > 0) {
          await this.delay(waitMs);
        }
      } else {
        // Concurrency full - wait for a release() signal
        await new Promise<void>((resolve) => {
          this.waitQueue.push(resolve);
        });
      }
    }
  }

  /**
   * Release a concurrency slot after a request completes.
   */
  release(): void {
    if (this.activeCount > 0) {
      this.activeCount--;
    }
    // Wake up the next waiter, if any
    const next = this.waitQueue.shift();
    if (next) {
      next();
    }
  }

  /**
   * Current rate limiter statistics.
   */
  get stats(): {
    pending: number;
    activeRequests: number;
    requestsThisMinute: number;
  } {
    this.pruneOldTimestamps();
    return {
      pending: this.waitQueue.length,
      activeRequests: this.activeCount,
      requestsThisMinute: this.timestamps.length,
    };
  }

  // ─── Internals ──────────────────────────────────────────────────

  private pruneOldTimestamps(): void {
    const cutoff = Date.now() - WINDOW_MS;
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
