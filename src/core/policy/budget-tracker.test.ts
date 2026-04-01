import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BudgetTracker } from "./budget-tracker";

describe("BudgetTracker", () => {
  let db: Database;
  let tracker: BudgetTracker;

  beforeEach(() => {
    db = new Database(":memory:");
    tracker = new BudgetTracker(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("recordUsage", () => {
    test("records tokens and cost for today", () => {
      tracker.recordUsage(1000, 0.05);
      const usage = tracker.getTodayUsage();
      expect(usage.tokensUsed).toBe(1000);
      expect(usage.costUsd).toBeCloseTo(0.05, 4);
    });

    test("accumulates multiple recordings", () => {
      tracker.recordUsage(500, 0.02);
      tracker.recordUsage(300, 0.01);
      const usage = tracker.getTodayUsage();
      expect(usage.tokensUsed).toBe(800);
      expect(usage.costUsd).toBeCloseTo(0.03, 4);
    });
  });

  describe("recordSession", () => {
    test("increments session count", () => {
      tracker.recordSession();
      tracker.recordSession();
      const usage = tracker.getTodayUsage();
      expect(usage.sessions).toBe(2);
    });

    test("does not affect tokens or cost", () => {
      tracker.recordUsage(100, 0.01);
      tracker.recordSession();
      const usage = tracker.getTodayUsage();
      expect(usage.tokensUsed).toBe(100);
      expect(usage.sessions).toBe(1);
    });
  });

  describe("getUsage", () => {
    test("returns null for missing date", () => {
      expect(tracker.getUsage("2020-01-01")).toBeNull();
    });

    test("returns record for existing date", () => {
      tracker.recordUsage(500, 0.03);
      const today = new Date().toISOString().slice(0, 10);
      const usage = tracker.getUsage(today);
      expect(usage).not.toBeNull();
      expect(usage!.tokensUsed).toBe(500);
    });
  });

  describe("getTodayUsage", () => {
    test("returns zero record if nothing recorded", () => {
      const usage = tracker.getTodayUsage();
      expect(usage.tokensUsed).toBe(0);
      expect(usage.costUsd).toBe(0);
      expect(usage.sessions).toBe(0);
    });
  });

  describe("getRecentUsage", () => {
    test("returns empty when no data", () => {
      const recent = tracker.getRecentUsage(7);
      expect(recent).toHaveLength(0);
    });

    test("returns available records up to limit", () => {
      tracker.recordUsage(100, 0.01);
      tracker.recordSession();
      const recent = tracker.getRecentUsage(7);
      expect(recent).toHaveLength(1);
      expect(recent[0].tokensUsed).toBe(100);
    });
  });

  describe("getRangeTotal", () => {
    test("returns zeros for empty range", () => {
      const total = tracker.getRangeTotal("2020-01-01", "2020-01-31");
      expect(total.tokensUsed).toBe(0);
      expect(total.costUsd).toBe(0);
      expect(total.sessions).toBe(0);
    });

    test("sums records in range", () => {
      // Insert records for specific dates via direct SQL
      db.run(
        "INSERT INTO daily_usage (date, tokens_used, cost_usd, sessions) VALUES (?, ?, ?, ?)",
        ["2025-03-01", 1000, 0.1, 2],
      );
      db.run(
        "INSERT INTO daily_usage (date, tokens_used, cost_usd, sessions) VALUES (?, ?, ?, ?)",
        ["2025-03-02", 2000, 0.2, 3],
      );
      db.run(
        "INSERT INTO daily_usage (date, tokens_used, cost_usd, sessions) VALUES (?, ?, ?, ?)",
        ["2025-03-10", 500, 0.05, 1],
      );

      const total = tracker.getRangeTotal("2025-03-01", "2025-03-05");
      expect(total.tokensUsed).toBe(3000);
      expect(total.costUsd).toBeCloseTo(0.3, 4);
      expect(total.sessions).toBe(5);
    });
  });

  describe("prune", () => {
    test("removes old records", () => {
      // Insert old record
      db.run(
        "INSERT INTO daily_usage (date, tokens_used, cost_usd, sessions) VALUES (?, ?, ?, ?)",
        ["2020-01-01", 1000, 0.1, 1],
      );
      // Insert recent record
      tracker.recordUsage(500, 0.05);

      const removed = tracker.prune(30);
      expect(removed).toBe(1);

      // Recent should still exist
      const today = tracker.getTodayUsage();
      expect(today.tokensUsed).toBe(500);
    });

    test("returns 0 when nothing to prune", () => {
      tracker.recordUsage(100, 0.01);
      const removed = tracker.prune(30);
      expect(removed).toBe(0);
    });
  });

  describe("table creation", () => {
    test("creates table on initialization", () => {
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_usage'")
        .all();
      expect(tables).toHaveLength(1);
    });

    test("idempotent — safe to create tracker twice", () => {
      const tracker2 = new BudgetTracker(db);
      tracker.recordUsage(100, 0.01);
      tracker2.recordUsage(200, 0.02);
      const usage = tracker.getTodayUsage();
      expect(usage.tokensUsed).toBe(300);
    });
  });
});
