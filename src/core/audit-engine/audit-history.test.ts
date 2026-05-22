// KCode - audit-history tests (v2.10.469).
// Per-pattern empirical precision tracking.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetAuditHistoryForTest,
  getAllPatternPrecision,
  getPatternPrecision,
  getTotalVerdictCount,
  recordVerdict,
} from "./audit-history";

let TMP: string;
let ORIG: string | undefined;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "kcode-audit-history-"));
  ORIG = process.env.KCODE_AUDIT_HISTORY_PATH;
  process.env.KCODE_AUDIT_HISTORY_PATH = join(TMP, "audit-history.db");
  _resetAuditHistoryForTest();
});

afterEach(() => {
  _resetAuditHistoryForTest();
  if (ORIG === undefined) delete process.env.KCODE_AUDIT_HISTORY_PATH;
  else process.env.KCODE_AUDIT_HISTORY_PATH = ORIG;
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("recordVerdict / getPatternPrecision", () => {
  test("returns null for an unknown pattern", () => {
    expect(getPatternPrecision("never-seen")).toBe(null);
  });

  test("computes precision and confirm_rate after enough samples", () => {
    // js-001-eval: 1 confirmed, 8 FPs, 1 needs_context
    recordVerdict("js-001-eval", "confirmed", "/x/a.js");
    for (let i = 0; i < 8; i++) recordVerdict("js-001-eval", "false_positive", "/x/a.js");
    recordVerdict("js-001-eval", "needs_context", "/x/a.js");

    const p = getPatternPrecision("js-001-eval");
    expect(p).not.toBe(null);
    expect(p?.total).toBe(10);
    expect(p?.confirmed).toBe(1);
    expect(p?.false_positive).toBe(8);
    expect(p?.needs_context).toBe(1);
    // precision = confirmed / (confirmed + fp) = 1/9 ≈ 0.111
    expect(p?.precision).toBeCloseTo(1 / 9, 5);
    // confirm_rate = confirmed / total = 1/10 = 0.1
    expect(p?.confirm_rate).toBeCloseTo(0.1, 5);
  });

  test("respects minSamples threshold", () => {
    recordVerdict("rare", "confirmed", "/x/y.ts");
    recordVerdict("rare", "false_positive", "/x/y.ts");
    expect(getPatternPrecision("rare", 50)).toBe(null);
    expect(getPatternPrecision("rare", 2)).not.toBe(null);
  });
});

describe("getAllPatternPrecision — noisy-first sort", () => {
  test("orders by ascending confirm_rate, then by total desc", () => {
    // pattern-A: 9 fp / 1 confirmed = 10% confirm
    recordVerdict("pattern-A", "confirmed", "/f.ts");
    for (let i = 0; i < 9; i++) recordVerdict("pattern-A", "false_positive", "/f.ts");
    // pattern-B: 5 fp / 5 confirmed = 50% confirm
    for (let i = 0; i < 5; i++) recordVerdict("pattern-B", "confirmed", "/f.ts");
    for (let i = 0; i < 5; i++) recordVerdict("pattern-B", "false_positive", "/f.ts");
    // pattern-C: same 10% confirm but more total → comes BEFORE A (tie on rate, more samples first)
    for (let i = 0; i < 2; i++) recordVerdict("pattern-C", "confirmed", "/f.ts");
    for (let i = 0; i < 18; i++) recordVerdict("pattern-C", "false_positive", "/f.ts");

    const all = getAllPatternPrecision(10);
    expect(all.length).toBe(3);
    expect(all[0]?.pattern_id).toBe("pattern-C"); // tied 10% confirm, more samples
    expect(all[1]?.pattern_id).toBe("pattern-A");
    expect(all[2]?.pattern_id).toBe("pattern-B");
    expect(all[0]?.confirm_rate).toBeCloseTo(0.1, 5);
    expect(all[2]?.confirm_rate).toBeCloseTo(0.5, 5);
  });

  test("filters out patterns below minSamples", () => {
    recordVerdict("tiny", "confirmed", "/f.ts");
    const all = getAllPatternPrecision(50);
    expect(all.find((p) => p.pattern_id === "tiny")).toBeUndefined();
  });
});

describe("getTotalVerdictCount", () => {
  test("counts across all patterns", () => {
    expect(getTotalVerdictCount()).toBe(0);
    recordVerdict("a", "confirmed");
    recordVerdict("b", "false_positive");
    recordVerdict("c", "needs_context");
    expect(getTotalVerdictCount()).toBe(3);
  });
});

describe("resilience — DB failures are silent", () => {
  test("recordVerdict never throws on bad path", () => {
    process.env.KCODE_AUDIT_HISTORY_PATH = "/nonexistent-dir-x9z/db";
    _resetAuditHistoryForTest();
    expect(() => recordVerdict("p", "confirmed")).not.toThrow();
  });
});
