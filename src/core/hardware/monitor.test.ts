import { test, expect, describe, beforeEach } from "bun:test";
import { PerformanceMonitor, getPerformanceMonitor, _resetPerformanceMonitor } from "./monitor";
import type { PerformanceMetrics } from "./types";

describe("PerformanceMonitor", () => {
  let monitor: PerformanceMonitor;

  beforeEach(() => {
    monitor = new PerformanceMonitor();
  });

  // ─── record() & count ─────────────────────────────────────────

  describe("record()", () => {
    test("records metrics and increments count", () => {
      expect(monitor.count).toBe(0);

      monitor.record({
        tokensPerSecond: 30,
        timeToFirstToken: 200,
        ramUsed: 8,
        cpuUtilization: 45,
      });

      expect(monitor.count).toBe(1);
    });

    test("respects maxHistory limit", () => {
      const small = new PerformanceMonitor(5);
      for (let i = 0; i < 10; i++) {
        small.record({
          tokensPerSecond: i,
          timeToFirstToken: 100,
          ramUsed: 4,
          cpuUtilization: 30,
        });
      }
      expect(small.count).toBe(5);
      // The earliest entries should have been dropped
      const history = small.getHistory();
      expect(history[0].tokensPerSecond).toBe(5);
    });

    test("adds timestamp if not provided", () => {
      monitor.record({
        tokensPerSecond: 30,
        timeToFirstToken: 200,
        ramUsed: 8,
        cpuUtilization: 45,
      });
      const history = monitor.getHistory();
      expect(history[0].timestamp).toBeDefined();
      expect(typeof history[0].timestamp).toBe("number");
    });
  });

  // ─── clear() ──────────────────────────────────────────────────

  describe("clear()", () => {
    test("removes all entries", () => {
      monitor.record({ tokensPerSecond: 30, timeToFirstToken: 200, ramUsed: 8, cpuUtilization: 45 });
      monitor.record({ tokensPerSecond: 25, timeToFirstToken: 250, ramUsed: 9, cpuUtilization: 50 });
      expect(monitor.count).toBe(2);

      monitor.clear();
      expect(monitor.count).toBe(0);
    });
  });

  // ─── average() ────────────────────────────────────────────────

  describe("average()", () => {
    test("returns null when empty", () => {
      expect(monitor.average()).toBeNull();
    });

    test("returns correct average for single entry", () => {
      monitor.record({
        tokensPerSecond: 30,
        timeToFirstToken: 200,
        ramUsed: 8,
        cpuUtilization: 45,
      });
      const avg = monitor.average()!;
      expect(avg.tokensPerSecond).toBe(30);
      expect(avg.timeToFirstToken).toBe(200);
      expect(avg.ramUsed).toBe(8);
      expect(avg.cpuUtilization).toBe(45);
    });

    test("returns correct average for multiple entries", () => {
      monitor.record({ tokensPerSecond: 20, timeToFirstToken: 100, ramUsed: 6, cpuUtilization: 40 });
      monitor.record({ tokensPerSecond: 40, timeToFirstToken: 300, ramUsed: 10, cpuUtilization: 60 });

      const avg = monitor.average()!;
      expect(avg.tokensPerSecond).toBe(30);
      expect(avg.timeToFirstToken).toBe(200);
      expect(avg.ramUsed).toBe(8);
      expect(avg.cpuUtilization).toBe(50);
    });

    test("handles GPU metrics correctly when present", () => {
      monitor.record({
        tokensPerSecond: 30,
        timeToFirstToken: 200,
        gpuUtilization: 80,
        gpuMemoryUsed: 20,
        ramUsed: 8,
        cpuUtilization: 45,
      });
      monitor.record({
        tokensPerSecond: 30,
        timeToFirstToken: 200,
        gpuUtilization: 60,
        gpuMemoryUsed: 18,
        ramUsed: 8,
        cpuUtilization: 45,
      });

      const avg = monitor.average()!;
      expect(avg.gpuUtilization).toBe(70);
      expect(avg.gpuMemoryUsed).toBe(19);
    });

    test("returns undefined for GPU metrics when not present", () => {
      monitor.record({ tokensPerSecond: 30, timeToFirstToken: 200, ramUsed: 8, cpuUtilization: 45 });
      const avg = monitor.average()!;
      expect(avg.gpuUtilization).toBeUndefined();
      expect(avg.gpuMemoryUsed).toBeUndefined();
    });
  });

  // ─── detectDegradation() ──────────────────────────────────────

  describe("detectDegradation()", () => {
    test("returns null with too few entries", () => {
      for (let i = 0; i < 15; i++) {
        monitor.record({ tokensPerSecond: 30, timeToFirstToken: 200, ramUsed: 8, cpuUtilization: 45 });
      }
      expect(monitor.detectDegradation()).toBeNull();
    });

    test("returns null when performance is stable", () => {
      for (let i = 0; i < 30; i++) {
        monitor.record({ tokensPerSecond: 30, timeToFirstToken: 200, ramUsed: 8, cpuUtilization: 45 });
      }
      expect(monitor.detectDegradation()).toBeNull();
    });

    test("detects TPS drop > 30%", () => {
      // Baseline: 10 entries at 30 tps
      for (let i = 0; i < 10; i++) {
        monitor.record({ tokensPerSecond: 30, timeToFirstToken: 200, ramUsed: 8, cpuUtilization: 45 });
      }
      // Middle padding
      for (let i = 0; i < 5; i++) {
        monitor.record({ tokensPerSecond: 25, timeToFirstToken: 200, ramUsed: 8, cpuUtilization: 45 });
      }
      // Recent: 10 entries at 10 tps (67% drop, exceeds the >50% critical threshold)
      for (let i = 0; i < 10; i++) {
        monitor.record({ tokensPerSecond: 10, timeToFirstToken: 200, ramUsed: 8, cpuUtilization: 45 });
      }

      const alert = monitor.detectDegradation();
      expect(alert).not.toBeNull();
      expect(alert!.type).toBe("tps_drop");
      expect(alert!.severity).toBe("critical");
      expect(alert!.currentValue).toBe(10);
      expect(alert!.baselineValue).toBe(30);
    });

    test("detects TPS drop > 30% as warning (not critical)", () => {
      // Baseline: 30 tps
      for (let i = 0; i < 10; i++) {
        monitor.record({ tokensPerSecond: 30, timeToFirstToken: 200, ramUsed: 8, cpuUtilization: 45 });
      }
      // Padding
      for (let i = 0; i < 5; i++) {
        monitor.record({ tokensPerSecond: 25, timeToFirstToken: 200, ramUsed: 8, cpuUtilization: 45 });
      }
      // Recent: 20 tps (33% drop)
      for (let i = 0; i < 10; i++) {
        monitor.record({ tokensPerSecond: 20, timeToFirstToken: 200, ramUsed: 8, cpuUtilization: 45 });
      }

      const alert = monitor.detectDegradation();
      expect(alert).not.toBeNull();
      expect(alert!.type).toBe("tps_drop");
      expect(alert!.severity).toBe("warning");
    });

    test("detects TTFT increase > 50%", () => {
      // Baseline: 200ms TTFT
      for (let i = 0; i < 10; i++) {
        monitor.record({ tokensPerSecond: 30, timeToFirstToken: 200, ramUsed: 8, cpuUtilization: 45 });
      }
      // Padding
      for (let i = 0; i < 5; i++) {
        monitor.record({ tokensPerSecond: 30, timeToFirstToken: 250, ramUsed: 8, cpuUtilization: 45 });
      }
      // Recent: 500ms TTFT (150% increase, exceeds the >100% critical threshold)
      for (let i = 0; i < 10; i++) {
        monitor.record({ tokensPerSecond: 30, timeToFirstToken: 500, ramUsed: 8, cpuUtilization: 45 });
      }

      const alert = monitor.detectDegradation();
      expect(alert).not.toBeNull();
      expect(alert!.type).toBe("ttft_increase");
      expect(alert!.severity).toBe("critical");
    });

    test("detects GPU memory high > 95%", () => {
      // Baseline
      for (let i = 0; i < 10; i++) {
        monitor.record({
          tokensPerSecond: 30, timeToFirstToken: 200, ramUsed: 8, cpuUtilization: 45,
          gpuUtilization: 80, gpuMemoryUsed: 70,
        });
      }
      // Padding
      for (let i = 0; i < 5; i++) {
        monitor.record({
          tokensPerSecond: 30, timeToFirstToken: 200, ramUsed: 8, cpuUtilization: 45,
          gpuUtilization: 85, gpuMemoryUsed: 80,
        });
      }
      // Recent: GPU memory at 97%
      for (let i = 0; i < 10; i++) {
        monitor.record({
          tokensPerSecond: 30, timeToFirstToken: 200, ramUsed: 8, cpuUtilization: 45,
          gpuUtilization: 95, gpuMemoryUsed: 97,
        });
      }

      const alert = monitor.detectDegradation();
      expect(alert).not.toBeNull();
      expect(alert!.type).toBe("gpu_memory_high");
      expect(alert!.severity).toBe("critical");
    });
  });

  // ─── suggestOptimizations() ───────────────────────────────────

  describe("suggestOptimizations()", () => {
    test("returns empty array when no data", () => {
      expect(monitor.suggestOptimizations()).toEqual([]);
    });

    test("suggests action for low GPU utilization", () => {
      monitor.record({
        tokensPerSecond: 30, timeToFirstToken: 200, ramUsed: 8, cpuUtilization: 45,
        gpuUtilization: 30,
      });

      const suggestions = monitor.suggestOptimizations();
      expect(suggestions.some(s => s.includes("GPU underutilized"))).toBe(true);
    });

    test("suggests action for very low speed", () => {
      monitor.record({
        tokensPerSecond: 3, timeToFirstToken: 200, ramUsed: 8, cpuUtilization: 45,
      });

      const suggestions = monitor.suggestOptimizations();
      expect(suggestions.some(s => s.includes("low speed") || s.includes("Very low speed"))).toBe(true);
    });

    test("suggests action for high TTFT", () => {
      monitor.record({
        tokensPerSecond: 30, timeToFirstToken: 6000, ramUsed: 8, cpuUtilization: 45,
      });

      const suggestions = monitor.suggestOptimizations();
      expect(suggestions.some(s => s.includes("TTFT") || s.includes("context"))).toBe(true);
    });

    test("suggests action for CPU bottleneck", () => {
      monitor.record({
        tokensPerSecond: 30, timeToFirstToken: 200, ramUsed: 8, cpuUtilization: 95,
        gpuUtilization: 20,
      });

      const suggestions = monitor.suggestOptimizations();
      expect(suggestions.some(s => s.includes("CPU bottleneck"))).toBe(true);
    });

    test("returns no suggestions for healthy metrics", () => {
      monitor.record({
        tokensPerSecond: 30, timeToFirstToken: 200, ramUsed: 8, cpuUtilization: 45,
        gpuUtilization: 80,
      });

      const suggestions = monitor.suggestOptimizations();
      expect(suggestions.length).toBe(0);
    });
  });

  // ─── getRecent() ──────────────────────────────────────────────

  describe("getRecent()", () => {
    test("returns last N entries", () => {
      for (let i = 0; i < 20; i++) {
        monitor.record({ tokensPerSecond: i, timeToFirstToken: 100, ramUsed: 4, cpuUtilization: 30 });
      }

      const recent = monitor.getRecent(5);
      expect(recent.length).toBe(5);
      expect(recent[0].tokensPerSecond).toBe(15);
      expect(recent[4].tokensPerSecond).toBe(19);
    });
  });

  // ─── Singleton ────────────────────────────────────────────────

  describe("singleton", () => {
    test("getPerformanceMonitor returns same instance", () => {
      _resetPerformanceMonitor();
      const m1 = getPerformanceMonitor();
      const m2 = getPerformanceMonitor();
      expect(m1).toBe(m2);
    });

    test("_resetPerformanceMonitor creates new instance", () => {
      const m1 = getPerformanceMonitor();
      _resetPerformanceMonitor();
      const m2 = getPerformanceMonitor();
      expect(m1).not.toBe(m2);
    });
  });
});
