// KCode - Performance Monitor
// Tracks inference performance metrics and detects degradation in real-time.

import type { PerformanceMetrics, DegradationAlert } from "./types";
import { log } from "../logger";

export class PerformanceMonitor {
  private history: PerformanceMetrics[] = [];
  private maxHistory: number;

  constructor(maxHistory: number = 100) {
    this.maxHistory = maxHistory;
  }

  /**
   * Record metrics from a completed inference request.
   */
  record(metrics: PerformanceMetrics): void {
    const entry = { ...metrics, timestamp: metrics.timestamp ?? Date.now() };
    this.history.push(entry);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  /**
   * Get the number of recorded metric entries.
   */
  get count(): number {
    return this.history.length;
  }

  /**
   * Get all recorded metrics (copy).
   */
  getHistory(): PerformanceMetrics[] {
    return [...this.history];
  }

  /**
   * Clear all recorded metrics.
   */
  clear(): void {
    this.history = [];
  }

  /**
   * Compute average metrics across all history entries.
   * Returns null if no entries recorded.
   */
  average(): PerformanceMetrics | null {
    if (this.history.length === 0) return null;

    const sum = this.history.reduce(
      (acc, m) => ({
        tokensPerSecond: acc.tokensPerSecond + m.tokensPerSecond,
        timeToFirstToken: acc.timeToFirstToken + m.timeToFirstToken,
        gpuUtilization:
          acc.gpuUtilization !== undefined && m.gpuUtilization !== undefined
            ? acc.gpuUtilization + m.gpuUtilization
            : acc.gpuUtilization,
        gpuMemoryUsed:
          acc.gpuMemoryUsed !== undefined && m.gpuMemoryUsed !== undefined
            ? acc.gpuMemoryUsed + m.gpuMemoryUsed
            : acc.gpuMemoryUsed,
        ramUsed: acc.ramUsed + m.ramUsed,
        cpuUtilization: acc.cpuUtilization + m.cpuUtilization,
      }),
      {
        tokensPerSecond: 0,
        timeToFirstToken: 0,
        gpuUtilization: this.history[0].gpuUtilization !== undefined ? 0 : undefined,
        gpuMemoryUsed: this.history[0].gpuMemoryUsed !== undefined ? 0 : undefined,
        ramUsed: 0,
        cpuUtilization: 0,
      } as PerformanceMetrics
    );

    const n = this.history.length;
    return {
      tokensPerSecond: sum.tokensPerSecond / n,
      timeToFirstToken: sum.timeToFirstToken / n,
      gpuUtilization: sum.gpuUtilization !== undefined ? sum.gpuUtilization / n : undefined,
      gpuMemoryUsed: sum.gpuMemoryUsed !== undefined ? sum.gpuMemoryUsed / n : undefined,
      ramUsed: sum.ramUsed / n,
      cpuUtilization: sum.cpuUtilization / n,
    };
  }

  /**
   * Detect performance degradation by comparing recent metrics to the baseline.
   * Requires at least 20 entries (10 baseline + 10 recent) to function.
   * Returns a DegradationAlert if a significant degradation is detected, null otherwise.
   */
  detectDegradation(): DegradationAlert | null {
    if (this.history.length < 20) return null;

    const baseline = this.history.slice(0, 10);
    const recent = this.history.slice(-10);

    const avgBaseline = this.computeSliceAverage(baseline);
    const avgRecent = this.computeSliceAverage(recent);

    // Check TPS drop > 30%
    if (avgBaseline.tokensPerSecond > 0) {
      const tpsDrop = (avgBaseline.tokensPerSecond - avgRecent.tokensPerSecond) / avgBaseline.tokensPerSecond;
      if (tpsDrop > 0.3) {
        return {
          type: "tps_drop",
          message: `Tokens/second dropped by ${Math.round(tpsDrop * 100)}% (${avgRecent.tokensPerSecond.toFixed(1)} vs baseline ${avgBaseline.tokensPerSecond.toFixed(1)})`,
          severity: tpsDrop > 0.5 ? "critical" : "warning",
          currentValue: avgRecent.tokensPerSecond,
          baselineValue: avgBaseline.tokensPerSecond,
        };
      }
    }

    // Check TTFT increase > 50%
    if (avgBaseline.timeToFirstToken > 0) {
      const ttftIncrease = (avgRecent.timeToFirstToken - avgBaseline.timeToFirstToken) / avgBaseline.timeToFirstToken;
      if (ttftIncrease > 0.5) {
        return {
          type: "ttft_increase",
          message: `Time to first token increased by ${Math.round(ttftIncrease * 100)}% (${avgRecent.timeToFirstToken.toFixed(0)}ms vs baseline ${avgBaseline.timeToFirstToken.toFixed(0)}ms)`,
          severity: ttftIncrease > 1.0 ? "critical" : "warning",
          currentValue: avgRecent.timeToFirstToken,
          baselineValue: avgBaseline.timeToFirstToken,
        };
      }
    }

    // Check GPU memory > 95%
    if (avgRecent.gpuMemoryUsed !== undefined && avgRecent.gpuUtilization !== undefined) {
      // Use gpuMemoryUsed as a percentage proxy if it's between 0-100
      // Otherwise treat as absolute GB value
      if (avgRecent.gpuMemoryUsed > 95) {
        return {
          type: "gpu_memory_high",
          message: `GPU memory usage is critically high at ${avgRecent.gpuMemoryUsed.toFixed(1)}%`,
          severity: "critical",
          currentValue: avgRecent.gpuMemoryUsed,
          baselineValue: avgBaseline.gpuMemoryUsed ?? 0,
        };
      }
    }

    return null;
  }

  /**
   * Suggest optimizations based on current average metrics.
   */
  suggestOptimizations(): string[] {
    const avg = this.average();
    if (!avg) return [];

    const suggestions: string[] = [];

    if (avg.gpuUtilization !== undefined && avg.gpuUtilization < 50) {
      suggestions.push("GPU underutilized. Consider increasing batch_size or using a larger model.");
    }

    if (avg.tokensPerSecond < 5) {
      suggestions.push("Very low speed. Consider using more aggressive quantization (Q4_0) or a smaller model.");
    }

    if (avg.timeToFirstToken > 5000) {
      suggestions.push("High TTFT. The context may be too large. Consider reducing context_window.");
    }

    if (avg.cpuUtilization > 90 && avg.gpuUtilization !== undefined && avg.gpuUtilization < 30) {
      suggestions.push("CPU bottleneck detected. Ensure GPU offloading is enabled (gpu_layers: -1).");
    }

    if (avg.ramUsed > 0 && avg.tokensPerSecond < 10) {
      suggestions.push("Low throughput with high RAM usage. Model may be partially running on CPU. Check gpu_layers setting.");
    }

    return suggestions;
  }

  /**
   * Get the last N recorded metrics.
   */
  getRecent(n: number = 10): PerformanceMetrics[] {
    return this.history.slice(-n);
  }

  private computeSliceAverage(slice: PerformanceMetrics[]): PerformanceMetrics {
    if (slice.length === 0) {
      return { tokensPerSecond: 0, timeToFirstToken: 0, ramUsed: 0, cpuUtilization: 0 };
    }

    const n = slice.length;
    let tps = 0, ttft = 0, gpuUtil = 0, gpuMem = 0, ram = 0, cpu = 0;
    let gpuUtilCount = 0, gpuMemCount = 0;

    for (const m of slice) {
      tps += m.tokensPerSecond;
      ttft += m.timeToFirstToken;
      ram += m.ramUsed;
      cpu += m.cpuUtilization;
      if (m.gpuUtilization !== undefined) { gpuUtil += m.gpuUtilization; gpuUtilCount++; }
      if (m.gpuMemoryUsed !== undefined) { gpuMem += m.gpuMemoryUsed; gpuMemCount++; }
    }

    return {
      tokensPerSecond: tps / n,
      timeToFirstToken: ttft / n,
      gpuUtilization: gpuUtilCount > 0 ? gpuUtil / gpuUtilCount : undefined,
      gpuMemoryUsed: gpuMemCount > 0 ? gpuMem / gpuMemCount : undefined,
      ramUsed: ram / n,
      cpuUtilization: cpu / n,
    };
  }
}

// Singleton
let _monitor: PerformanceMonitor | null = null;

export function getPerformanceMonitor(): PerformanceMonitor {
  if (!_monitor) _monitor = new PerformanceMonitor();
  return _monitor;
}

/**
 * Reset the singleton (for testing).
 */
export function _resetPerformanceMonitor(): void {
  _monitor = null;
}
