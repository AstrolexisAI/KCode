// F8.3 — regression-test the public benchmark.
//
// Locks the audit's static-only metrics so accidental regressions
// (a regex tuning change that drops recall, a new pattern that
// floods FPs) fail CI before the next release goes out.
//
// Thresholds are intentionally a few points below the live baseline
// so noise from pattern micro-tunings doesn't fail the build, but
// any structural drop is caught.
//
// Live baseline at v2.10.366 (after F4 taint-lite + propagation-js fixture):
//   precision = 1.000  (100.0%)
//   recall    = 0.692  (69.2%)
//   f1        = 0.818
//   mean scan = ~12 ms / fixture
//
// Regression thresholds:
//   precision ≥ 0.95
//   recall    ≥ 0.60
//   f1        ≥ 0.75

import { describe, expect, test } from "bun:test";
import { runBenchmark } from "./run";

describe("audit benchmark — static-only regression", () => {
  test("precision >= 0.95", async () => {
    const out = await runBenchmark({ withVerifier: false });
    expect(out.json.metrics.precision).toBeGreaterThanOrEqual(0.95);
  });

  test("recall >= 0.60", async () => {
    const out = await runBenchmark({ withVerifier: false });
    expect(out.json.metrics.recall).toBeGreaterThanOrEqual(0.6);
  });

  test("f1 >= 0.75", async () => {
    const out = await runBenchmark({ withVerifier: false });
    expect(out.json.metrics.f1).toBeGreaterThanOrEqual(0.75);
  });

  test("every fixture runs in < 1 second (static-only)", async () => {
    const out = await runBenchmark({ withVerifier: false });
    for (const f of out.json.fixtures) {
      expect(f.duration_ms).toBeLessThan(1000);
    }
  });

  test("negative fixtures produce zero false positives", async () => {
    const out = await runBenchmark({ withVerifier: false });
    const negatives = out.json.fixtures.filter((f) => f.kind === "negative");
    expect(negatives.length).toBeGreaterThan(0);
    for (const n of negatives) {
      expect(n.false_positives).toBe(0);
    }
  });

  test("aggregate counts are internally consistent", async () => {
    const out = await runBenchmark({ withVerifier: false });
    const m = out.json.metrics;
    const summed = out.json.fixtures.reduce(
      (acc, f) => ({
        tp: acc.tp + f.true_positives,
        fp: acc.fp + f.false_positives,
        fn: acc.fn + f.false_negatives,
      }),
      { tp: 0, fp: 0, fn: 0 },
    );
    expect(m.true_positives).toBe(summed.tp);
    expect(m.false_positives).toBe(summed.fp);
    expect(m.false_negatives).toBe(summed.fn);
  });
});
