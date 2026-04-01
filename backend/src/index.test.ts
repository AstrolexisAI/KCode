import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";

// Use temp DB for API tests
process.env.DB_PATH = `/tmp/kcode-test-api-${Date.now()}.db`;

import { getDb, upsertCustomer, insertTrial } from "./db";

// Import the Hono app
import app from "./index";

const BASE = `http://localhost:${process.env.PORT || 10080}`;

function req(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`${BASE}${path}`, init));
}

function jsonPost(path: string, body: Record<string, unknown>): Promise<Response> {
  return req(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  getDb();
});

afterAll(() => {
  const dbPath = process.env.DB_PATH!;
  try { unlinkSync(dbPath); } catch {}
  try { unlinkSync(`${dbPath}-wal`); } catch {}
  try { unlinkSync(`${dbPath}-shm`); } catch {}
});

describe("GET /health", () => {
  test("returns ok", async () => {
    const resp = await req("/health");
    expect(resp.status).toBe(200);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.status).toBe("ok");
    expect(data.service).toBe("kcode-backend");
  });
});

describe("POST /api/pro/validate", () => {
  test("rejects missing key", async () => {
    const resp = await jsonPost("/api/pro/validate", {});
    expect(resp.status).toBe(400);
  });

  test("rejects invalid format", async () => {
    const resp = await jsonPost("/api/pro/validate", { key: "bad_key" });
    expect(resp.status).toBe(400);
  });

  test("returns false for unknown key", async () => {
    // Valid format but not in DB — all-hex legacy key
    const resp = await jsonPost("/api/pro/validate", { key: "kcode_pro_" + "a".repeat(32) });
    const data = await resp.json() as Record<string, unknown>;
    expect(data.valid).toBe(false);
  });

  test("validates active customer key", async () => {
    const key = "kcode_pro_" + "b".repeat(32);
    upsertCustomer({
      stripeId: "cus_validate_test",
      email: "validate@test.com",
      proKey: key,
      status: "active",
    });

    const resp = await jsonPost("/api/pro/validate", { key });
    const data = await resp.json() as Record<string, unknown>;
    expect(data.valid).toBe(true);
  });

  test("rejects canceled customer", async () => {
    const key = "kcode_pro_" + "c".repeat(32);
    upsertCustomer({
      stripeId: "cus_canceled_test",
      email: "canceled@test.com",
      proKey: key,
      status: "canceled",
    });

    const resp = await jsonPost("/api/pro/validate", { key });
    const data = await resp.json() as Record<string, unknown>;
    expect(data.valid).toBe(false);
  });

  test("validates active trial key", async () => {
    const key = "kcode_trial_" + "d".repeat(32);
    insertTrial("trial-validate@test.com", key, new Date(Date.now() + 86400000).toISOString());

    const resp = await jsonPost("/api/pro/validate", { key });
    const data = await resp.json() as Record<string, unknown>;
    expect(data.valid).toBe(true);
  });

  test("rejects expired trial", async () => {
    const key = "kcode_trial_" + "e".repeat(32);
    insertTrial("trial-expired@test.com", key, "2020-01-01T00:00:00Z");

    const resp = await jsonPost("/api/pro/validate", { key });
    const data = await resp.json() as Record<string, unknown>;
    expect(data.valid).toBe(false);
  });
});

describe("POST /api/pro/trial", () => {
  test("rejects missing email", async () => {
    const resp = await jsonPost("/api/pro/trial", {});
    expect(resp.status).toBe(400);
  });

  test("rejects invalid email", async () => {
    const resp = await jsonPost("/api/pro/trial", { email: "nope" });
    expect(resp.status).toBe(400);
  });

  test("creates trial for new email", async () => {
    const resp = await jsonPost("/api/pro/trial", { email: `trial-${Date.now()}@test.com` });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.success).toBe(true);
    expect(typeof data.trial_key).toBe("string");
    expect((data.trial_key as string).startsWith("kcode_trial_")).toBe(true);
    expect(data.days).toBe(14);
  });

  test("rejects duplicate trial", async () => {
    // Use the email from db.test.ts which already has a trial
    const resp = await jsonPost("/api/pro/trial", { email: "bob@test.com" });
    expect(resp.status).toBe(409);
  });

  test("rejects trial for active pro customer", async () => {
    upsertCustomer({
      stripeId: "cus_trial_block",
      email: "pro-user@test.com",
      proKey: "kcode_pro_" + "f".repeat(32),
      status: "active",
    });

    const resp = await jsonPost("/api/pro/trial", { email: "pro-user@test.com" });
    expect(resp.status).toBe(409);
  });
});

describe("POST /api/pro/portal", () => {
  test("rejects missing key", async () => {
    const resp = await jsonPost("/api/pro/portal", {});
    expect(resp.status).toBe(400);
  });

  test("returns 404 for unknown key", async () => {
    const resp = await jsonPost("/api/pro/portal", { key: "kcode_pro_unknown" });
    expect(resp.status).toBe(404);
  });
});

describe("POST /api/pro/checkout-session", () => {
  test("rejects missing email", async () => {
    const resp = await jsonPost("/api/pro/checkout-session", {});
    expect(resp.status).toBe(400);
  });

  test("rejects invalid email", async () => {
    const resp = await jsonPost("/api/pro/checkout-session", { email: "bad" });
    expect(resp.status).toBe(400);
  });

  // Note: actual Stripe calls require STRIPE_SECRET_KEY, so this will fail gracefully
  test("fails without Stripe key configured", async () => {
    const resp = await jsonPost("/api/pro/checkout-session", { email: "test@example.com", plan: "pro" });
    expect(resp.status).toBe(500);
  });
});

describe("POST /api/pro/webhook", () => {
  test("rejects missing signature", async () => {
    const resp = await req("/api/pro/webhook", {
      method: "POST",
      body: "{}",
    });
    expect(resp.status).toBe(400);
  });
});

describe("GET /api/admin/customers", () => {
  test("rejects without admin key", async () => {
    const resp = await req("/api/admin/customers");
    expect(resp.status).toBe(401);
  });
});
