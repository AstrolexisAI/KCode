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

    -- ─── OAuth: human users (login/signup) ────────────────────────
    -- Distinct from customers table (which is Stripe-centric). A user
    -- may exist without an active customer (free tier) and vice
    -- versa. Linked by email.
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    -- ─── OAuth: browser session cookies ───────────────────────────
    -- Server-side sessions for the astrolexis.space web UI (login /
    -- signup / dashboard / consent). Distinct from OAuth access
    -- tokens which go to kcode CLI.
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at    TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    -- ─── OAuth: short-lived authorization codes ───────────────────
    -- Issued by /oauth/authorize after user consent; redeemed via
    -- /oauth/token within ~10 min. PKCE code_challenge is bound to
    -- this row so only the original client can exchange it.
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code             TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id        TEXT NOT NULL,
      redirect_uri     TEXT NOT NULL,
      code_challenge   TEXT NOT NULL,
      code_challenge_method TEXT NOT NULL DEFAULT 'S256',
      scope            TEXT NOT NULL DEFAULT '',
      expires_at       TEXT NOT NULL,
      used             INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ─── OAuth: access + refresh tokens ───────────────────────────
    -- Storing hashes so a DB leak doesn't give usable tokens. The
    -- raw tokens are only known to kcode CLI (stored in its keychain).
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id                TEXT PRIMARY KEY,
      user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      access_hash       TEXT UNIQUE NOT NULL,
      refresh_hash      TEXT UNIQUE,
      client_id         TEXT NOT NULL,
      scope             TEXT NOT NULL DEFAULT '',
      expires_at        TEXT NOT NULL,
      refresh_expires_at TEXT,
      revoked           INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tokens_access ON oauth_tokens(access_hash);
    CREATE INDEX IF NOT EXISTS idx_tokens_refresh ON oauth_tokens(refresh_hash);
    CREATE INDEX IF NOT EXISTS idx_tokens_user ON oauth_tokens(user_id);
  `);
}

// ─── User queries ─────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  password_hash: string;
  email_verified: number;
  created_at: string;
}

export function findUserByEmail(email: string): User | null {
  const db = getDb();
  return db.query("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()) as User | null;
}

export function findUserById(id: string): User | null {
  const db = getDb();
  return db.query("SELECT * FROM users WHERE id = ?").get(id) as User | null;
}

export function insertUser(email: string, passwordHash: string): User {
  const db = getDb();
  const id = crypto.randomUUID();
  db.query(
    "INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)",
  ).run(id, email.toLowerCase(), passwordHash);
  return findUserById(id)!;
}

// ─── Session queries ──────────────────────────────────────────

export function createSession(userId: string, ttlSec: number = 30 * 24 * 3600): string {
  const db = getDb();
  const sessionId = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
  db.query("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(
    sessionId,
    userId,
    expiresAt,
  );
  return sessionId;
}

export function findSessionUser(sessionId: string): User | null {
  const db = getDb();
  const row = db
    .query(
      `SELECT users.* FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.id = ? AND sessions.expires_at > datetime('now')`,
    )
    .get(sessionId) as User | null;
  return row;
}

export function deleteSession(sessionId: string): void {
  const db = getDb();
  db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

// ─── OAuth code queries ───────────────────────────────────────

export interface OAuthCode {
  code: string;
  user_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  expires_at: string;
  used: number;
}

export function insertOAuthCode(row: {
  code: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  ttlSec: number;
}): void {
  const db = getDb();
  const expiresAt = new Date(Date.now() + row.ttlSec * 1000).toISOString();
  db.query(
    `INSERT INTO oauth_codes
     (code, user_id, client_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.code,
    row.userId,
    row.clientId,
    row.redirectUri,
    row.codeChallenge,
    row.codeChallengeMethod,
    row.scope,
    expiresAt,
  );
}

export function consumeOAuthCode(code: string): OAuthCode | null {
  const db = getDb();
  const row = db
    .query(
      `SELECT * FROM oauth_codes
       WHERE code = ? AND used = 0 AND expires_at > datetime('now')`,
    )
    .get(code) as OAuthCode | null;
  if (!row) return null;
  db.query("UPDATE oauth_codes SET used = 1 WHERE code = ?").run(code);
  return row;
}

// ─── OAuth token queries ──────────────────────────────────────

export interface OAuthTokenRow {
  id: string;
  user_id: string;
  access_hash: string;
  refresh_hash: string | null;
  client_id: string;
  scope: string;
  expires_at: string;
  refresh_expires_at: string | null;
  revoked: number;
}

export function insertOAuthToken(row: {
  userId: string;
  accessHash: string;
  refreshHash: string | null;
  clientId: string;
  scope: string;
  expiresSec: number;
  refreshExpiresSec: number | null;
}): void {
  const db = getDb();
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + row.expiresSec * 1000).toISOString();
  const refreshExpiresAt = row.refreshExpiresSec
    ? new Date(Date.now() + row.refreshExpiresSec * 1000).toISOString()
    : null;
  db.query(
    `INSERT INTO oauth_tokens
     (id, user_id, access_hash, refresh_hash, client_id, scope, expires_at, refresh_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    row.userId,
    row.accessHash,
    row.refreshHash,
    row.clientId,
    row.scope,
    expiresAt,
    refreshExpiresAt,
  );
}

export function findTokenByAccessHash(accessHash: string): OAuthTokenRow | null {
  const db = getDb();
  return db
    .query(
      `SELECT * FROM oauth_tokens
       WHERE access_hash = ? AND revoked = 0 AND expires_at > datetime('now')`,
    )
    .get(accessHash) as OAuthTokenRow | null;
}

export function findTokenByRefreshHash(refreshHash: string): OAuthTokenRow | null {
  const db = getDb();
  return db
    .query(
      `SELECT * FROM oauth_tokens
       WHERE refresh_hash = ? AND revoked = 0
         AND (refresh_expires_at IS NULL OR refresh_expires_at > datetime('now'))`,
    )
    .get(refreshHash) as OAuthTokenRow | null;
}

export function revokeTokensByUser(userId: string): void {
  const db = getDb();
  db.query("UPDATE oauth_tokens SET revoked = 1 WHERE user_id = ?").run(userId);
}

export function revokeToken(accessHash: string): void {
  const db = getDb();
  db.query("UPDATE oauth_tokens SET revoked = 1 WHERE access_hash = ?").run(accessHash);
}

// ─── Helpers ──────────────────────────────────────────────────

function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
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
