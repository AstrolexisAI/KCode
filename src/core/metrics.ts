// KCode - LLM Performance Metrics
// In-memory metrics collector for tracking model request performance

// ─── Types ──────────────────────────────────────────────────────

interface RequestDataPoint {
  timestamp: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

interface ErrorDataPoint {
  timestamp: number;
  errorType: string;
}

export interface ModelMetrics {
  model: string;
  totalRequests: number;
  avgDurationMs: number;
  p95DurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  errorRate: number;
  errorsByType: Record<string, number>;
}

// ─── Constants ──────────────────────────────────────────────────

const MAX_DATA_POINTS = 1000;

// ─── MetricsCollector ───────────────────────────────────────────

export class MetricsCollector {
  private requests: Map<string, RequestDataPoint[]> = new Map();
  private errors: Map<string, ErrorDataPoint[]> = new Map();

  /**
   * Record a successful LLM request.
   */
  recordRequest(model: string, durationMs: number, inputTokens: number, outputTokens: number): void {
    if (!this.requests.has(model)) {
      this.requests.set(model, []);
    }

    const points = this.requests.get(model)!;
    points.push({
      timestamp: Date.now(),
      durationMs,
      inputTokens,
      outputTokens,
    });

    // Trim to max data points
    if (points.length > MAX_DATA_POINTS) {
      points.splice(0, points.length - MAX_DATA_POINTS);
    }
  }

  /**
   * Record an LLM request error.
   */
  recordError(model: string, errorType: string): void {
    if (!this.errors.has(model)) {
      this.errors.set(model, []);
    }

    const points = this.errors.get(model)!;
    points.push({
      timestamp: Date.now(),
      errorType,
    });

    // Trim to max data points
    if (points.length > MAX_DATA_POINTS) {
      points.splice(0, points.length - MAX_DATA_POINTS);
    }
  }

  /**
   * Get computed metrics for all tracked models.
   */
  getMetrics(): ModelMetrics[] {
    const allModels = new Set([...this.requests.keys(), ...this.errors.keys()]);
    const results: ModelMetrics[] = [];

    for (const model of allModels) {
      const requestPoints = this.requests.get(model) ?? [];
      const errorPoints = this.errors.get(model) ?? [];

      const totalRequests = requestPoints.length;
      const totalErrors = errorPoints.length;
      const totalAttempts = totalRequests + totalErrors;

      // Compute average duration
      const avgDurationMs =
        totalRequests > 0
          ? requestPoints.reduce((sum, p) => sum + p.durationMs, 0) / totalRequests
          : 0;

      // Compute p95 duration
      const p95DurationMs = computeP95(requestPoints.map((p) => p.durationMs));

      // Compute token totals
      const totalInputTokens = requestPoints.reduce((sum, p) => sum + p.inputTokens, 0);
      const totalOutputTokens = requestPoints.reduce((sum, p) => sum + p.outputTokens, 0);

      // Compute error rate
      const errorRate = totalAttempts > 0 ? totalErrors / totalAttempts : 0;

      // Count errors by type
      const errorsByType: Record<string, number> = {};
      for (const ep of errorPoints) {
        errorsByType[ep.errorType] = (errorsByType[ep.errorType] || 0) + 1;
      }

      results.push({
        model,
        totalRequests,
        avgDurationMs,
        p95DurationMs,
        totalInputTokens,
        totalOutputTokens,
        errorRate,
        errorsByType,
      });
    }

    // Sort by total requests descending
    results.sort((a, b) => b.totalRequests - a.totalRequests);
    return results;
  }

  /**
   * Format metrics as a human-readable string for terminal display.
   */
  formatMetrics(): string {
    const metrics = this.getMetrics();

    if (metrics.length === 0) {
      return "No metrics recorded yet.";
    }

    const lines: string[] = [];
    lines.push("LLM Performance Metrics");
    lines.push("");

    for (const m of metrics) {
      lines.push(`Model: ${m.model}`);
      lines.push(`  Requests:      ${m.totalRequests}`);
      lines.push(`  Avg duration:  ${m.avgDurationMs.toFixed(0)}ms`);
      lines.push(`  P95 duration:  ${m.p95DurationMs.toFixed(0)}ms`);
      lines.push(`  Input tokens:  ${formatNumber(m.totalInputTokens)}`);
      lines.push(`  Output tokens: ${formatNumber(m.totalOutputTokens)}`);
      lines.push(`  Error rate:    ${(m.errorRate * 100).toFixed(1)}%`);

      const errorTypes = Object.entries(m.errorsByType);
      if (errorTypes.length > 0) {
        lines.push("  Errors:");
        for (const [type, count] of errorTypes.sort((a, b) => b[1] - a[1])) {
          lines.push(`    ${type}: ${count}`);
        }
      }

      lines.push("");
    }

    return lines.join("\n").trimEnd();
  }

  /**
   * Reset all collected metrics.
   */
  reset(): void {
    this.requests.clear();
    this.errors.clear();
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function computeP95(values: number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}
