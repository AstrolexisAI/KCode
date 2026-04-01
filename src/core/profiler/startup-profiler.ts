// Startup Profiler — Enhanced version with memory tracking, categories, and recommendations.
// Records timestamps, memory usage, and module counts at key init phases.
// Activated via KCODE_PROFILE=1, KCODE_PROFILE_STARTUP=1, or --startup-profile flag.

import type { ProfileCheckpoint, ProfileReport, PhaseCategory } from "./types";
import { STARTUP_TARGETS } from "./types";

/** Map checkpoint names to categories for grouped reporting */
const PHASE_CATEGORIES: Record<string, PhaseCategory> = {
  process_start: "init",
  cli_defined: "init",
  config_loading: "config",
  config_loaded: "config",
  server_check: "server",
  server_ready: "server",
  plugins_loaded: "plugins",
  mcp_loading: "plugins",
  tools_registering: "tools",
  tools_registered: "tools",
  conversation_init: "tools",
  conversation_ready: "tools",
  ready: "ui",
  ui_rendering: "ui",
};

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
      category: PHASE_CATEGORIES[name] ?? "other",
    });
  }

  /** Generate report with automatic recommendations */
  report(): ProfileReport {
    const emptyCategoryTotals: Record<PhaseCategory, number> = {
      init: 0, config: 0, server: 0, plugins: 0, tools: 0, ui: 0, other: 0,
    };

    if (this.checkpoints.length === 0) {
      return {
        checkpoints: [],
        totalMs: 0,
        peakMemoryMB: 0,
        slowestPhase: "N/A",
        recommendations: [],
        categoryTotals: emptyCategoryTotals,
      };
    }

    const totalMs = this.checkpoints.at(-1)!.timestamp;
    const sorted = [...this.checkpoints].sort((a, b) => b.deltaMs - a.deltaMs);
    const recommendations: string[] = [];

    // Build category totals
    const categoryTotals = { ...emptyCategoryTotals };
    for (const cp of this.checkpoints) {
      const cat = cp.category ?? "other";
      categoryTotals[cat] += cp.deltaMs;
    }

    // Phase-level recommendations
    for (const cp of this.checkpoints) {
      if (cp.deltaMs > STARTUP_TARGETS.phaseCriticalMs) {
        recommendations.push(
          `"${cp.name}" took ${cp.deltaMs}ms [CRITICAL] — investigate or defer`,
        );
      } else if (cp.deltaMs > STARTUP_TARGETS.phaseWarningMs) {
        recommendations.push(
          `"${cp.name}" took ${cp.deltaMs}ms — consider lazy-loading or caching`,
        );
      }
    }

    // Check if server phase is included (local model startup is expected to be slow)
    const hasServerPhase = this.checkpoints.some(
      (cp) => cp.name === "server_ready",
    );
    const target = hasServerPhase
      ? STARTUP_TARGETS.coldStartWithServerMs
      : STARTUP_TARGETS.coldStartNoServerMs;

    if (totalMs > target) {
      recommendations.push(
        `Total startup ${totalMs}ms exceeds ${target}ms target${hasServerPhase ? " (with server)" : ""}`,
      );
    }

    // Category-level insights
    const slowestCategory = (Object.entries(categoryTotals) as [PhaseCategory, number][])
      .sort(([, a], [, b]) => b - a)[0];
    if (slowestCategory && slowestCategory[1] > STARTUP_TARGETS.phaseWarningMs) {
      recommendations.push(
        `Slowest category: "${slowestCategory[0]}" at ${slowestCategory[1]}ms`,
      );
    }

    return {
      checkpoints: [...this.checkpoints],
      totalMs,
      peakMemoryMB: Math.max(...this.checkpoints.map((c) => c.memoryMB)),
      slowestPhase: sorted[0]?.name ?? "N/A",
      recommendations,
      categoryTotals,
    };
  }

  /** Print report as a formatted table to stderr */
  print(): void {
    const r = this.report();
    if (r.checkpoints.length === 0) {
      console.error("  No startup profile data recorded.");
      console.error("  Set KCODE_PROFILE=1 or use --startup-profile to enable profiling.");
      return;
    }

    console.error("\n\x1b[1m--- Startup Profile ---\x1b[0m");
    for (const cp of r.checkpoints) {
      const bar = "\u2588".repeat(Math.min(50, Math.round(cp.deltaMs / 10)));
      const mem = `${cp.memoryMB}MB`;
      const color =
        cp.deltaMs > STARTUP_TARGETS.phaseCriticalMs
          ? "\x1b[31m"
          : cp.deltaMs > STARTUP_TARGETS.phaseWarningMs
            ? "\x1b[33m"
            : "\x1b[32m";
      const label =
        cp.deltaMs > STARTUP_TARGETS.phaseCriticalMs
          ? "  \x1b[31m[CRITICAL]\x1b[0m"
          : cp.deltaMs > STARTUP_TARGETS.phaseWarningMs
            ? "  \x1b[33m[SLOW]\x1b[0m"
            : "";
      const cat = (cp.category ?? "other").padEnd(8);
      console.error(
        `  ${cat} ${cp.name.padEnd(22)} ${color}${String(cp.deltaMs).padStart(6)}ms\x1b[0m  ${mem.padStart(8)}  ${bar}${label}`,
      );
    }

    // Category summary
    console.error("\n\x1b[1m  Category Breakdown:\x1b[0m");
    for (const [cat, ms] of Object.entries(r.categoryTotals) as [PhaseCategory, number][]) {
      if (ms === 0) continue;
      const bar = "\u2588".repeat(Math.min(30, Math.round(ms / 20)));
      console.error(`    ${cat.padEnd(10)} ${String(ms).padStart(6)}ms  ${bar}`);
    }

    const hasServer = r.checkpoints.some((cp) => cp.name === "server_ready");
    const target = hasServer
      ? STARTUP_TARGETS.coldStartWithServerMs
      : STARTUP_TARGETS.coldStartNoServerMs;
    const status =
      r.totalMs <= target * 0.5
        ? "\x1b[32m[FAST]\x1b[0m"
        : r.totalMs <= target
          ? "\x1b[32m[OK]\x1b[0m"
          : r.totalMs <= target * 1.5
            ? "\x1b[33m[SLOW]\x1b[0m"
            : "\x1b[31m[VERY SLOW]\x1b[0m";
    console.error(
      `\n  ${"TOTAL".padEnd(31)} ${String(r.totalMs).padStart(6)}ms  ${`${r.peakMemoryMB}MB`.padStart(8)}  ${status} (target: ${target}ms)`,
    );

    if (r.recommendations.length > 0) {
      console.error("\n  Recommendations:");
      for (const rec of r.recommendations) {
        console.error(`    ! ${rec}`);
      }
    }
    console.error("");
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
