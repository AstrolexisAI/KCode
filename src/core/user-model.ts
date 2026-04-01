// KCode - Layer 7: User Model
// Dynamic user profiling with exponential moving average trait tracking

import type { Database } from "bun:sqlite";
import { getDb } from "./db";
import { log } from "./logger";

export interface UserProfile {
  expertise: number;
  verbosity: number;
  patience: number;
  autonomy: number;
  language: string;
  interests: string[];
  lastSeen: string;
}

const EMA_ALPHA = 0.3;

export class UserModel {
  private _db?: Database;

  constructor(db?: Database) {
    this._db = db;
  }

  private getDatabase(): Database {
    return this._db ?? getDb();
  }

  updateTrait(trait: string, observedValue: number): void {
    try {
      const db = this.getDatabase();
      const existing = db
        .query("SELECT value, samples FROM user_model WHERE key = ?")
        .get(trait) as { value: number; samples: number } | null;
      if (existing) {
        const newValue = Math.max(
          0,
          Math.min(1, EMA_ALPHA * observedValue + (1 - EMA_ALPHA) * existing.value),
        );
        db.query(
          "UPDATE user_model SET value = ?, samples = samples + 1, updated_at = datetime('now') WHERE key = ?",
        ).run(newValue, trait);
      } else {
        db.query("INSERT INTO user_model (key, value) VALUES (?, ?)").run(
          trait,
          Math.max(0, Math.min(1, observedValue)),
        );
      }
    } catch (err) {
      log.error("user-model", `Failed to update trait ${trait}: ${err}`);
    }
  }

  updateFromMessage(message: string): void {
    const wordCount = message.split(/\s+/).length;
    const hasCode = /```|`[^`]+`/.test(message);
    const hasTechnicalTerms =
      /\b(api|function|class|interface|component|module|deploy|docker|git|branch|merge|refactor)\b/i.test(
        message,
      );
    const isImpatient = /just|quickly|fast|hurry|asap|simply/i.test(message);
    const isAutonomous = /decide|you choose|whatever you think|do what|up to you|autonomo/i.test(
      message,
    );
    const isSpanish = /\b(quiero|puedo|hacer|como|donde|para|por que|necesito|tengo)\b/i.test(
      message,
    );

    if (hasTechnicalTerms || hasCode) this.updateTrait("expertise", 0.8);
    if (wordCount > 50) this.updateTrait("verbosity", 0.7);
    else if (wordCount < 10) this.updateTrait("verbosity", 0.2);
    if (isImpatient) this.updateTrait("patience", 0.2);
    if (isAutonomous) this.updateTrait("autonomy", 0.9);
    if (isSpanish) this.setMeta("language", "es");

    const techKeywords = message.match(
      /\b(react|next|typescript|python|rust|go|swift|docker|kubernetes|postgres|sqlite|redis|api|graphql|rest|css|html|tailwind|svelte|vue|angular)\b/gi,
    );
    if (techKeywords) {
      for (const kw of techKeywords) this.trackInterest(kw.toLowerCase());
    }
    this.setMeta("last_seen", new Date().toISOString());
  }

  getProfile(): UserProfile {
    try {
      const db = this.getDatabase();
      const traits = db.query("SELECT key, value FROM user_model").all() as {
        key: string;
        value: number;
      }[];
      const interests = db
        .query("SELECT topic FROM user_interests ORDER BY frequency DESC LIMIT 10")
        .all() as { topic: string }[];
      const traitMap: Record<string, number> = {};
      for (const t of traits) traitMap[t.key] = t.value;
      return {
        expertise: traitMap["expertise"] ?? 0.5,
        verbosity: traitMap["verbosity"] ?? 0.5,
        patience: traitMap["patience"] ?? 0.5,
        autonomy: traitMap["autonomy"] ?? 0.5,
        language: this.getMeta("language") ?? "en",
        interests: interests.map((i) => i.topic),
        lastSeen: this.getMeta("last_seen") ?? "",
      };
    } catch (err) {
      log.error("user-model", `Failed to load profile: ${err}`);
      return {
        expertise: 0.5,
        verbosity: 0.5,
        patience: 0.5,
        autonomy: 0.5,
        language: "en",
        interests: [],
        lastSeen: "",
      };
    }
  }

  formatForPrompt(): string | null {
    const profile = this.getProfile();
    const lines: string[] = ["# User Model", ""];
    const traitLabels: [string, number, string, string][] = [
      ["Expertise", profile.expertise, "beginner", "expert"],
      ["Verbosity preference", profile.verbosity, "concise", "detailed"],
      ["Patience", profile.patience, "wants quick results", "patient with process"],
      ["Autonomy", profile.autonomy, "wants control over decisions", "prefers you to decide"],
    ];
    let hasSignificant = false;
    for (const [label, value, lowDesc, highDesc] of traitLabels) {
      if (Math.abs(value - 0.5) > 0.1) {
        const desc = value > 0.5 ? highDesc : lowDesc;
        lines.push(`- ${label}: ${desc} (${Math.round(value * 100)}%)`);
        hasSignificant = true;
      }
    }
    if (profile.language !== "en") {
      lines.push(`- Primary language: ${profile.language === "es" ? "Spanish" : profile.language}`);
      hasSignificant = true;
    }
    if (profile.interests.length > 0) {
      lines.push(`- Frequent topics: ${profile.interests.join(", ")}`);
      hasSignificant = true;
    }
    if (!hasSignificant) return null;
    lines.push("", "Adapt your responses based on this profile.");
    return lines.join("\n");
  }

  private trackInterest(topic: string): void {
    try {
      const db = this.getDatabase();
      const existing = db.query("SELECT frequency FROM user_interests WHERE topic = ?").get(topic);
      if (existing)
        db.query(
          "UPDATE user_interests SET frequency = frequency + 1, updated_at = datetime('now') WHERE topic = ?",
        ).run(topic);
      else db.query("INSERT INTO user_interests (topic) VALUES (?)").run(topic);
    } catch {
      /* ignore */
    }
  }

  private setMeta(key: string, value: string): void {
    try {
      this.getDatabase()
        .query("INSERT OR REPLACE INTO user_meta (key, value) VALUES (?, ?)")
        .run(key, value);
    } catch {
      /* ignore */
    }
  }

  private getMeta(key: string): string | null {
    try {
      const row = this.getDatabase()
        .query("SELECT value FROM user_meta WHERE key = ?")
        .get(key) as { value: string } | null;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }
}

let _userModel: UserModel | null = null;
export function getUserModel(): UserModel {
  if (!_userModel) _userModel = new UserModel();
  return _userModel;
}
