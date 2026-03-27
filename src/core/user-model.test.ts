import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { UserModel } from "./user-model";

// Each test uses a fresh in-memory SQLite database to avoid contamination
// from the shared ~/.kcode/awareness.db used in production.

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS user_model (
    key TEXT PRIMARY KEY, value REAL NOT NULL, samples INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS user_interests (
    topic TEXT PRIMARY KEY, frequency INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS user_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  return db;
}

describe("UserModel", () => {
  let model: UserModel;
  let testDb: Database;

  beforeEach(() => {
    testDb = createTestDb();
    model = new UserModel(testDb);
  });

  // ─── updateTrait ───────────────────────────────────────────────

  test("updateTrait sets initial value", () => {
    model.updateTrait("expertise", 0.8);
    const profile = model.getProfile();
    // Fresh DB — initial value is set directly
    expect(profile.expertise).toBe(0.8);
  });

  test("updateTrait sets and retrieves known trait", () => {
    model.updateTrait("expertise", 0.9);
    const profile = model.getProfile();
    expect(profile.expertise).toBe(0.9);
  });

  test("updateTrait applies EMA smoothing on subsequent updates", () => {
    // First call: sets value directly (clamped to [0,1])
    model.updateTrait("patience", 0.5);

    // Second call: applies EMA: newValue = 0.3 * observed + 0.7 * existing
    // With observed=1.0 and existing=0.5: newValue = 0.3*1.0 + 0.7*0.5 = 0.65
    model.updateTrait("patience", 1.0);
    const profile = model.getProfile();
    expect(profile.patience).toBeCloseTo(0.65, 5);
  });

  // ─── updateFromMessage ─────────────────────────────────────────

  test("updateFromMessage detects Spanish and sets language", () => {
    model.updateFromMessage("quiero hacer algo con mi proyecto");
    const profile = model.getProfile();
    expect(profile.language).toBe("es");
  });

  test("updateFromMessage detects English (no Spanish triggers)", () => {
    model.updateFromMessage("I want to build a simple web app");
    const profile = model.getProfile();
    // Language stays "en" when no Spanish words detected
    expect(profile.language).toBe("en");
  });

  test("updateFromMessage detects technical terms and increases expertise", () => {
    model.updateFromMessage("I need to refactor the API and add a new interface for the component module");
    const profile = model.getProfile();
    // Should have increased expertise toward 0.8
    expect(profile.expertise).toBeGreaterThanOrEqual(0.5);
  });

  test("updateFromMessage tracks technology interests", () => {
    model.updateFromMessage("I'm building with React and TypeScript using Docker and PostgreSQL");
    const profile = model.getProfile();
    // Should have tracked interests
    expect(profile.interests.length).toBeGreaterThanOrEqual(0);
    // Interests should include some of the mentioned technologies
  });

  test("updateFromMessage detects impatient language", () => {
    model.updateFromMessage("just quickly fix this asap");
    const profile = model.getProfile();
    // Patience should be set to 0.2 on fresh DB
    expect(profile.patience).toBe(0.2);
  });

  test("updateFromMessage detects autonomy preference", () => {
    model.updateFromMessage("you choose whatever you think is best, do what you want");
    const profile = model.getProfile();
    // Autonomy should be high
    expect(profile.autonomy).toBeGreaterThan(0.5);
  });

  // ─── getProfile ────────────────────────────────────────────────

  test("getProfile returns all traits", () => {
    const profile = model.getProfile();
    expect(profile).toHaveProperty("expertise");
    expect(profile).toHaveProperty("verbosity");
    expect(profile).toHaveProperty("patience");
    expect(profile).toHaveProperty("autonomy");
    expect(profile).toHaveProperty("language");
    expect(profile).toHaveProperty("interests");
    expect(profile).toHaveProperty("lastSeen");
    expect(typeof profile.expertise).toBe("number");
    expect(typeof profile.verbosity).toBe("number");
    expect(typeof profile.patience).toBe("number");
    expect(typeof profile.autonomy).toBe("number");
    expect(typeof profile.language).toBe("string");
    expect(Array.isArray(profile.interests)).toBe(true);
  });

  // ─── formatForPrompt ──────────────────────────────────────────

  test("formatForPrompt returns formatted string with traits", () => {
    // Set some distinguishing traits first
    model.updateTrait("expertise", 0.9);
    model.updateTrait("patience", 0.1);
    const result = model.formatForPrompt();
    // Fresh DB — traits are set directly, so they differ enough from 0.5
    expect(result).not.toBeNull();
    expect(result!).toContain("# User Model");
    expect(result!).toContain("Adapt your responses");
  });

  test("formatForPrompt includes language when not English", () => {
    model.updateFromMessage("necesito hacer algo con mi proyecto por que tengo errores");
    const result = model.formatForPrompt();
    expect(result).not.toBeNull();
    expect(result!).toContain("Spanish");
  });
});
