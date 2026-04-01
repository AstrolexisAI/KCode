// Startup Profiler — Enhanced version with memory tracking and recommendations.
// Records timestamps, memory usage, and module counts at key init phases.
// Activated via KCODE_PROFILE=1 or KCODE_PROFILE_STARTUP=1.

import type { ProfileCheckpoint, ProfileReport } from "./types";

class StartupProfiler {
  private checkpoints: ProfileCheckpoint[] = [];
  private startTime: number;
  private enabled: boolean;

  constructor(enabled?: boolean) {
    this.startTime = performance.now();
    this.enabled =
      enabled ??
      (process.env.KCODE_PROFILE === "1" || process.env.KCODE_PROFILE_STARTUP === "1");
  }

  /** Whether profiling is active */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Record a checkpoint with the given name. No-op if profiling disabled. */
  checkpoint(name: string): void {
    if (!this.enabled) return;

    const now = performance.now();
    const prev = this.checkpoints.at(-1)?.timestamp ?? 0;
    const timestamp = Math.round(now - this.startTime);

    this.checkpoints.push({
      name,
      timestamp,
      deltaMs: timestamp - prev,
      memoryMB: Math.round((process.memoryUsage.rss() / 1024 / 1024) * 10) / 10,
      importsLoaded: Object.keys(require.cache ?? {}).length,
    });
  }

  /** Generate report with automatic recommendations */
  report(): ProfileReport {
    if (this.checkpoints.length === 0) {
      return {
        checkpoints: [],
        totalMs: 0,
        peakMemoryMB: 0,
        slowestPhase: "N/A",
        recommendations: [],
      };
    }

    const totalMs = this.checkpoints.at(-1)!.timestamp;
    const sorted = [...this.checkpoints].sort((a, b) => b.deltaMs - a.deltaMs);
    const recommendations: string[] = [];

    for (const cp of this.checkpoints) {
      if (cp.deltaMs > 100) {
        recommendations.push(
          `"${cp.name}" took ${cp.deltaMs}ms — consider lazy-loading or caching`,
        );
      }
    }

    if (totalMs > 500) {
      recommendations.push(
        `Total startup ${totalMs}ms exceeds 500ms target`,
      );
    }

    return {
      checkpoints: [...this.checkpoints],
      totalMs,
      peakMemoryMB: Math.max(...this.checkpoints.map((c) => c.memoryMB)),
      slowestPhase: sorted[0]?.name ?? "N/A",
      recommendations,
    };
  }

  /** Print report as a formatted table to stderr */
  print(): void {
    const r = this.report();
    if (r.checkpoints.length === 0) {
      console.error("  No startup profile data recorded.");
      console.error("  Set KCODE_PROFILE=1 to enable profiling.");
      return;
    }

    console.error("\n\x1b[1m--- Startup Profile ---\x1b[0m");
    for (const cp of r.checkpoints) {
      const bar = "\u2588".repeat(Math.min(50, Math.round(cp.deltaMs / 10)));
      const mem = `${cp.memoryMB}MB`;
      const slow = cp.deltaMs > 100 ? "  \x1b[33m[SLOW]\x1b[0m" : "";
      console.error(
        `  ${cp.name.padEnd(25)} ${String(cp.deltaMs).padStart(6)}ms  ${mem.padStart(8)}  ${bar}${slow}`,
      );
    }

    const status =
      r.totalMs < 200
        ? "\x1b[32m[OK]\x1b[0m"
        : r.totalMs < 500
          ? "\x1b[33m[SLOW]\x1b[0m"
          : "\x1b[31m[VERY SLOW]\x1b[0m";
    console.error(
      `  ${"TOTAL".padEnd(25)} ${String(r.totalMs).padStart(6)}ms  ${`${r.peakMemoryMB}MB`.padStart(8)}  ${status}`,
    );

    if (r.recommendations.length > 0) {
      console.error("\n  Recommendations:");
      for (const rec of r.recommendations) {
        console.error(`    ! ${rec}`);
      }
    }
  }

  /** Reset all entries (for testing) */
  _reset(): void {
    this.checkpoints.length = 0;
    this.startTime = performance.now();
  }
}

// ── Global singleton + convenience wrappers (backwards-compatible) ──

let _globalProfiler: StartupProfiler | undefined;

/** Get or create the global profiler singleton */
export function getStartupProfiler(): StartupProfiler {
  if (!_globalProfiler) {
    _globalProfiler = new StartupProfiler();
  }
  return _globalProfiler;
}

/** Convenience: record a checkpoint on the global profiler */
export function profileCheckpoint(name: string): void {
  getStartupProfiler().checkpoint(name);
}

/** Convenience: check if profiling enabled */
export function isProfilingEnabled(): boolean {
  return getStartupProfiler().isEnabled();
}

/** Convenience: get report entries (legacy compat) */
export function getProfileReport() {
  return getStartupProfiler().report().checkpoints;
}

/** Convenience: print report */
export function printProfileReport(): void {
  getStartupProfiler().print();
}

/** Reset for testing */
export function _resetProfiler(): void {
  _globalProfiler = undefined;
}

export { StartupProfiler };
export type { ProfileCheckpoint, ProfileReport };
