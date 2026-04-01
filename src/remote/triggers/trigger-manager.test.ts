// KCode - Remote Trigger Manager Tests

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { TriggerApiClient } from "./trigger-api";
import { TriggerManager, validateCron } from "./trigger-manager";
import type { RemoteTrigger, TriggerRunResult } from "./types";
import { TriggerValidationError } from "./types";

const sampleTrigger: RemoteTrigger = {
  id: "trg_001",
  name: "Daily lint",
  schedule: "0 9 * * 1-5",
  prompt: "Run lint and fix issues",
  status: "active",
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

const sampleRunResult: TriggerRunResult = {
  triggerId: "trg_001",
  status: "success",
  summary: "Lint completed with 0 errors",
  messagesCount: 5,
  tokensUsed: 2400,
  costUsd: 0.012,
  durationMs: 15000,
};

function createMockApi(): TriggerApiClient & {
  createTrigger: ReturnType<typeof mock>;
  listTriggers: ReturnType<typeof mock>;
  getTrigger: ReturnType<typeof mock>;
  updateTrigger: ReturnType<typeof mock>;
  deleteTrigger: ReturnType<typeof mock>;
  runTrigger: ReturnType<typeof mock>;
  getTriggerHistory: ReturnType<typeof mock>;
} {
  return {
    createTrigger: mock(() => Promise.resolve(sampleTrigger)),
    listTriggers: mock(() => Promise.resolve([sampleTrigger])),
    getTrigger: mock(() => Promise.resolve(sampleTrigger)),
    updateTrigger: mock(() => Promise.resolve({ ...sampleTrigger, status: "paused" as const })),
    deleteTrigger: mock(() => Promise.resolve(undefined)),
    runTrigger: mock(() => Promise.resolve(sampleRunResult)),
    getTriggerHistory: mock(() => Promise.resolve([sampleRunResult])),
  } as unknown as TriggerApiClient & {
    createTrigger: ReturnType<typeof mock>;
    listTriggers: ReturnType<typeof mock>;
    getTrigger: ReturnType<typeof mock>;
    updateTrigger: ReturnType<typeof mock>;
    deleteTrigger: ReturnType<typeof mock>;
    runTrigger: ReturnType<typeof mock>;
    getTriggerHistory: ReturnType<typeof mock>;
  };
}

describe("validateCron", () => {
  test("accepts valid expression: 0 9 * * 1-5", () => {
    expect(() => validateCron("0 9 * * 1-5")).not.toThrow();
  });

  test("accepts valid expression: */5 * * * *", () => {
    expect(() => validateCron("*/5 * * * *")).not.toThrow();
  });

  test("accepts valid expression: 30 2 15 * *", () => {
    expect(() => validateCron("30 2 15 * *")).not.toThrow();
  });

  test("accepts valid expression: 0 0 1 1 *", () => {
    expect(() => validateCron("0 0 1 1 *")).not.toThrow();
  });

  test("accepts valid expression with lists: 0,30 9,17 * * *", () => {
    expect(() => validateCron("0,30 9,17 * * *")).not.toThrow();
  });

  test("accepts valid expression with step on range: 0-30/5 * * * *", () => {
    expect(() => validateCron("0-30/5 * * * *")).not.toThrow();
  });

  test("accepts day of week 7 (Sunday alternate)", () => {
    expect(() => validateCron("0 0 * * 7")).not.toThrow();
  });

  test("rejects wrong field count - too few", () => {
    expect(() => validateCron("0 9 *")).toThrow(TriggerValidationError);
    expect(() => validateCron("0 9 *")).toThrow("exactly 5 fields");
  });

  test("rejects wrong field count - too many", () => {
    expect(() => validateCron("0 9 * * * *")).toThrow(TriggerValidationError);
  });

  test("rejects empty string", () => {
    expect(() => validateCron("")).toThrow(TriggerValidationError);
  });

  test("rejects minute out of range (60)", () => {
    expect(() => validateCron("60 0 * * *")).toThrow(TriggerValidationError);
    expect(() => validateCron("60 0 * * *")).toThrow("out of range");
  });

  test("rejects hour out of range (24)", () => {
    expect(() => validateCron("0 24 * * *")).toThrow(TriggerValidationError);
    expect(() => validateCron("0 24 * * *")).toThrow("out of range");
  });

  test("rejects day of month out of range (0)", () => {
    expect(() => validateCron("0 0 0 * *")).toThrow(TriggerValidationError);
  });

  test("rejects day of month out of range (32)", () => {
    expect(() => validateCron("0 0 32 * *")).toThrow(TriggerValidationError);
  });

  test("rejects month out of range (13)", () => {
    expect(() => validateCron("0 0 * 13 *")).toThrow(TriggerValidationError);
  });

  test("rejects month out of range (0)", () => {
    expect(() => validateCron("0 0 * 0 *")).toThrow(TriggerValidationError);
  });

  test("rejects day of week out of range (8)", () => {
    expect(() => validateCron("0 0 * * 8")).toThrow(TriggerValidationError);
  });

  test("rejects non-numeric values", () => {
    expect(() => validateCron("abc 0 * * *")).toThrow(TriggerValidationError);
  });

  test("rejects invalid step value", () => {
    expect(() => validateCron("*/0 * * * *")).toThrow(TriggerValidationError);
  });

  test("rejects reversed range", () => {
    expect(() => validateCron("30-10 * * * *")).toThrow(TriggerValidationError);
    expect(() => validateCron("30-10 * * * *")).toThrow("greater than end");
  });
});

describe("TriggerManager", () => {
  let mockApi: ReturnType<typeof createMockApi>;
  let manager: TriggerManager;

  beforeEach(() => {
    mockApi = createMockApi();
    manager = new TriggerManager(mockApi);
  });

  test("create validates cron expression", async () => {
    const result = await manager.create({
      name: "Daily lint",
      schedule: "0 9 * * 1-5",
      prompt: "Run lint and fix issues",
    });

    expect(result.id).toBe("trg_001");
    expect(mockApi.createTrigger).toHaveBeenCalledTimes(1);
  });

  test("create rejects invalid cron", async () => {
    try {
      await manager.create({
        name: "Bad trigger",
        schedule: "invalid",
        prompt: "test",
      });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TriggerValidationError);
    }
  });

  test("create rejects empty name", async () => {
    try {
      await manager.create({
        name: "",
        schedule: "0 9 * * *",
        prompt: "test",
      });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TriggerValidationError);
      expect((err as Error).message).toContain("name is required");
    }
  });

  test("create rejects empty prompt", async () => {
    try {
      await manager.create({
        name: "Test",
        schedule: "0 9 * * *",
        prompt: "",
      });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TriggerValidationError);
      expect((err as Error).message).toContain("prompt is required");
    }
  });

  test("create rejects invalid maxTurns", async () => {
    try {
      await manager.create({
        name: "Test",
        schedule: "0 9 * * *",
        prompt: "test",
        maxTurns: 0,
      });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TriggerValidationError);
      expect((err as Error).message).toContain("maxTurns");
    }
  });

  test("list delegates to API", async () => {
    const result = await manager.list();

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(mockApi.listTriggers).toHaveBeenCalledTimes(1);
  });

  test("get delegates to API", async () => {
    const result = await manager.get("trg_001");
    expect(result).toEqual(sampleTrigger);
    expect(mockApi.getTrigger).toHaveBeenCalledTimes(1);
  });

  test("update validates cron if schedule changed", async () => {
    try {
      await manager.update("trg_001", { schedule: "bad" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TriggerValidationError);
    }
  });

  test("update allows valid schedule change", async () => {
    await manager.update("trg_001", { schedule: "0 12 * * *" });
    expect(mockApi.updateTrigger).toHaveBeenCalledTimes(1);
  });

  test("update rejects empty name", async () => {
    try {
      await manager.update("trg_001", { name: "  " });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TriggerValidationError);
    }
  });

  test("pause updates status to paused", async () => {
    await manager.pause("trg_001");

    expect(mockApi.updateTrigger).toHaveBeenCalledTimes(1);
    const callArgs = mockApi.updateTrigger.mock.calls[0];
    expect(callArgs[0]).toBe("trg_001");
    expect(callArgs[1]).toEqual({ status: "paused" });
  });

  test("resume updates status to active", async () => {
    await manager.resume("trg_001");

    expect(mockApi.updateTrigger).toHaveBeenCalledTimes(1);
    const callArgs = mockApi.updateTrigger.mock.calls[0];
    expect(callArgs[0]).toBe("trg_001");
    expect(callArgs[1]).toEqual({ status: "active" });
  });

  test("runNow delegates to API", async () => {
    const result = await manager.runNow("trg_001");

    expect(result.triggerId).toBe("trg_001");
    expect(result.status).toBe("success");
    expect(mockApi.runTrigger).toHaveBeenCalledTimes(1);
  });

  test("getHistory returns results", async () => {
    const results = await manager.getHistory("trg_001", 5);

    expect(results).toHaveLength(1);
    expect(results[0].triggerId).toBe("trg_001");
    expect(mockApi.getTriggerHistory).toHaveBeenCalledTimes(1);
    expect(mockApi.getTriggerHistory.mock.calls[0][1]).toBe(5);
  });

  test("getHistory works without limit", async () => {
    await manager.getHistory("trg_001");
    expect(mockApi.getTriggerHistory).toHaveBeenCalledTimes(1);
    expect(mockApi.getTriggerHistory.mock.calls[0][1]).toBeUndefined();
  });

  test("delete delegates to API", async () => {
    await manager.delete("trg_001");
    expect(mockApi.deleteTrigger).toHaveBeenCalledTimes(1);
    expect(mockApi.deleteTrigger.mock.calls[0][0]).toBe("trg_001");
  });
});
