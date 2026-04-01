// KCode Backend — SQLite database for customers, subscriptions, and trials
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH ?? "./data/kcode.db";

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH, { create: true });
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");

  migrate(_db);
  return _db;
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id            TEXT PRIMARY KEY,
      stripe_id     TEXT UNIQUE NOT NULL,
      email         TEXT NOT NULL,
      pro_key       TEXT UNIQUE NOT NULL,
      plan          TEXT NOT NULL DEFAULT 'pro',
      status        TEXT NOT NULL DEFAULT 'active',
      activated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at    TEXT,
      canceled_at   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
    CREATE INDEX IF NOT EXISTS idx_customers_stripe_id ON customers(stripe_id);
    CREATE INDEX IF NOT EXISTS idx_customers_pro_key ON customers(pro_key);

    CREATE TABLE IF NOT EXISTS trials (
      id            TEXT PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      trial_key     TEXT UNIQUE NOT NULL,
      expires_at    TEXT NOT NULL,
      converted     INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_trials_email ON trials(email);
    CREATE INDEX IF NOT EXISTS idx_trials_key ON trials(trial_key);

    CREATE TABLE IF NOT EXISTS webhook_events (
      id            TEXT PRIMARY KEY,
      stripe_event_id TEXT UNIQUE NOT NULL,
      event_type    TEXT NOT NULL,
      processed     INTEGER NOT NULL DEFAULT 0,
      payload       TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_stripe_id ON webhook_events(stripe_event_id);
  `);
}

// ─── Customer queries ─────────────────────────────────────────

export interface Customer {
  id: string;
  stripe_id: string;
  email: string;
  pro_key: string;
  plan: string;
  status: string;
  activated_at: string;
  expires_at: string | null;
  canceled_at: string | null;
}

export function findCustomerByKey(key: string): Customer | null {
  const db = getDb();
  return db.query("SELECT * FROM customers WHERE pro_key = ?").get(key) as Customer | null;
}

export function findCustomerByStripeId(stripeId: string): Customer | null {
  const db = getDb();
  return db.query("SELECT * FROM customers WHERE stripe_id = ?").get(stripeId) as Customer | null;
}

export function findCustomerByEmail(email: string): Customer | null {
  const db = getDb();
  return db.query("SELECT * FROM customers WHERE email = ? ORDER BY created_at DESC LIMIT 1").get(email) as Customer | null;
}

export function upsertCustomer(data: {
  stripeId: string;
  email: string;
  proKey: string;
  plan?: string;
  status?: string;
  expiresAt?: string;
}): void {
  const db = getDb();
  const id = crypto.randomUUID();
  db.query(`
    INSERT INTO customers (id, stripe_id, email, pro_key, plan, status, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stripe_id) DO UPDATE SET
      email = excluded.email,
      pro_key = excluded.pro_key,
      plan = COALESCE(excluded.plan, customers.plan),
      status = COALESCE(excluded.status, customers.status),
      expires_at = COALESCE(excluded.expires_at, customers.expires_at),
      updated_at = datetime('now')
  `).run(
    id,
    data.stripeId,
    data.email,
    data.proKey,
    data.plan ?? "pro",
    data.status ?? "active",
    data.expiresAt ?? null,
  );
}

export function updateCustomerStatus(stripeId: string, status: string): void {
  const db = getDb();
  db.query(`
    UPDATE customers SET status = ?, updated_at = datetime('now'),
      canceled_at = CASE WHEN ? IN ('canceled', 'unpaid') THEN datetime('now') ELSE canceled_at END
    WHERE stripe_id = ?
  `).run(status, status, stripeId);
}

// ─── Trial queries ────────────────────────────────────────────

export interface Trial {
  id: string;
  email: string;
  trial_key: string;
  expires_at: string;
  converted: number;
}

export function findTrialByEmail(email: string): Trial | null {
  const db = getDb();
  return db.query("SELECT * FROM trials WHERE email = ?").get(email) as Trial | null;
}

export function findTrialByKey(key: string): Trial | null {
  const db = getDb();
  return db.query("SELECT * FROM trials WHERE trial_key = ?").get(key) as Trial | null;
}

export function insertTrial(email: string, trialKey: string, expiresAt: string): void {
  const db = getDb();
  const id = crypto.randomUUID();
  db.query(`
    INSERT INTO trials (id, email, trial_key, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      trial_key = excluded.trial_key,
      expires_at = excluded.expires_at,
      converted = 0
  `).run(id, email, trialKey, expiresAt);
}

export function markTrialConverted(email: string): void {
  const db = getDb();
  db.query("UPDATE trials SET converted = 1 WHERE email = ?").run(email);
}

// ─── Webhook dedup ────────────────────────────────────────────

export function isWebhookProcessed(stripeEventId: string): boolean {
  const db = getDb();
  const row = db.query("SELECT processed FROM webhook_events WHERE stripe_event_id = ?").get(stripeEventId) as { processed: number } | null;
  return row?.processed === 1;
}

export function recordWebhookEvent(stripeEventId: string, eventType: string, payload: string): void {
  const db = getDb();
  const id = crypto.randomUUID();
  db.query(`
    INSERT INTO webhook_events (id, stripe_event_id, event_type, payload, processed)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(stripe_event_id) DO UPDATE SET processed = 1
  `).run(id, stripeEventId, eventType, payload);
}

// Run migrations if executed directly
if (import.meta.main) {
  getDb();
  console.log("Database migrated successfully at", DB_PATH);
}
