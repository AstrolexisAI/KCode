import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";

// Use temp DB for tests
process.env.DB_PATH = `/tmp/kcode-test-db-${Date.now()}.db`;

import {
  findCustomerByEmail,
  findCustomerByKey,
  findCustomerByStripeId,
  findTrialByEmail,
  findTrialByKey,
  getDb,
  insertTrial,
  isWebhookProcessed,
  markTrialConverted,
  recordWebhookEvent,
  updateCustomerStatus,
  upsertCustomer,
} from "./db";

beforeAll(() => {
  getDb(); // Initialize
});

afterAll(() => {
  const dbPath = process.env.DB_PATH!;
  try { unlinkSync(dbPath); } catch {}
  try { unlinkSync(`${dbPath}-wal`); } catch {}
  try { unlinkSync(`${dbPath}-shm`); } catch {}
});

describe("customer operations", () => {
  test("upsert and find by key", () => {
    upsertCustomer({
      stripeId: "cus_001",
      email: "alice@test.com",
      proKey: "kcode_pro_testkey001",
      plan: "pro",
    });

    const customer = findCustomerByKey("kcode_pro_testkey001");
    expect(customer).not.toBeNull();
    expect(customer!.email).toBe("alice@test.com");
    expect(customer!.plan).toBe("pro");
    expect(customer!.status).toBe("active");
  });

  test("find by stripe ID", () => {
    const customer = findCustomerByStripeId("cus_001");
    expect(customer).not.toBeNull();
    expect(customer!.email).toBe("alice@test.com");
  });

  test("find by email", () => {
    const customer = findCustomerByEmail("alice@test.com");
    expect(customer).not.toBeNull();
    expect(customer!.stripe_id).toBe("cus_001");
  });

  test("upsert updates existing on conflict", () => {
    upsertCustomer({
      stripeId: "cus_001",
      email: "alice-new@test.com",
      proKey: "kcode_pro_testkey001_v2",
      plan: "team",
    });

    const customer = findCustomerByStripeId("cus_001");
    expect(customer!.email).toBe("alice-new@test.com");
    expect(customer!.plan).toBe("team");
  });

  test("update status", () => {
    updateCustomerStatus("cus_001", "canceled");
    const customer = findCustomerByStripeId("cus_001");
    expect(customer!.status).toBe("canceled");
  });

  test("returns null for nonexistent", () => {
    expect(findCustomerByKey("nonexistent")).toBeNull();
    expect(findCustomerByStripeId("nonexistent")).toBeNull();
    expect(findCustomerByEmail("nobody@test.com")).toBeNull();
  });
});

describe("trial operations", () => {
  test("insert and find by email", () => {
    insertTrial("bob@test.com", "kcode_trial_testkey001", "2030-01-01T00:00:00Z");

    const trial = findTrialByEmail("bob@test.com");
    expect(trial).not.toBeNull();
    expect(trial!.trial_key).toBe("kcode_trial_testkey001");
    expect(trial!.converted).toBe(0);
  });

  test("find by key", () => {
    const trial = findTrialByKey("kcode_trial_testkey001");
    expect(trial).not.toBeNull();
    expect(trial!.email).toBe("bob@test.com");
  });

  test("mark as converted", () => {
    markTrialConverted("bob@test.com");
    const trial = findTrialByEmail("bob@test.com");
    expect(trial!.converted).toBe(1);
  });

  test("upsert on email conflict", () => {
    insertTrial("bob@test.com", "kcode_trial_newkey", "2031-01-01T00:00:00Z");
    const trial = findTrialByEmail("bob@test.com");
    expect(trial!.trial_key).toBe("kcode_trial_newkey");
    expect(trial!.converted).toBe(0); // Reset
  });
});

describe("webhook deduplication", () => {
  const evtId = `evt_db_${Date.now()}`;

  test("new event not processed", () => {
    expect(isWebhookProcessed(evtId)).toBe(false);
  });

  test("record marks as processed", () => {
    recordWebhookEvent(evtId, "checkout.session.completed", "{}");
    expect(isWebhookProcessed(evtId)).toBe(true);
  });

  test("duplicate insert doesn't throw", () => {
    expect(() => recordWebhookEvent(evtId, "checkout.session.completed", "{}")).not.toThrow();
  });
});
