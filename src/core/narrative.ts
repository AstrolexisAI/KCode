// KCode - Layer 10: Inner Narrative
// Session summaries stored as first-person narrative in SQLite

import type { Database } from "bun:sqlite";
import { getDb } from "./db";
import { log } from "./logger";

export interface NarrativeEntry {
  summary: string;
  project: string;
  tools_used: string;
  actions_taken: number;
  created_at: string;
}

export interface SessionData {
  project: string;
  messagesCount: number;
  toolsUsed: string[];
  actionsCount: number;
  topicsDiscussed: string[];
  errorsEncountered: number;
  filesModified: string[];
}

export class NarrativeManager {
  private _db?: Database;

  constructor(db?: Database) {
    this._db = db;
  }

  private getDatabase(): Database {
    return this._db ?? getDb();
  }

  updateNarrative(data: SessionData): void {
    try {
      const summary = this.generateNarrative(data);
      const db = this.getDatabase();
      db.query(
        "INSERT INTO narrative (summary, project, tools_used, actions_taken) VALUES (?, ?, ?, ?)",
      ).run(summary, data.project, data.toolsUsed.join(", "), data.actionsCount);
      // Prune: keep last 50 or last 30 days
      db.exec(
        `DELETE FROM narrative WHERE id NOT IN (SELECT id FROM narrative ORDER BY created_at DESC LIMIT 50) OR created_at < datetime('now', '-30 days')`,
      );
      log.info("narrative", `Session narrative saved: ${summary.slice(0, 80)}...`);
    } catch (err) {
      log.error("narrative", `Failed to save narrative: ${err}`);
    }
  }

  loadNarrative(limit = 3): string | null {
    try {
      const db = this.getDatabase();
      const entries = db
        .query(
          "SELECT summary, project, created_at FROM narrative ORDER BY created_at DESC LIMIT ?",
        )
        .all(limit) as NarrativeEntry[];
      if (entries.length === 0) return null;
      const lines = ["# Recent Sessions", "", "Summaries of recent sessions for continuity:", ""];
      for (const entry of entries.reverse()) {
        const date = entry.created_at.split(" ")[0] ?? entry.created_at;
        const project = entry.project ? ` (${entry.project})` : "";
        lines.push(`**${date}${project}**: ${entry.summary}`, "");
      }
      return lines.join("\n");
    } catch (err) {
      log.error("narrative", `Failed to load narrative: ${err}`);
      return null;
    }
  }

  getAllNarratives(limit = 20): NarrativeEntry[] {
    try {
      return this.getDatabase()
        .query(
          "SELECT summary, project, tools_used, actions_taken, created_at FROM narrative ORDER BY created_at DESC LIMIT ?",
        )
        .all(limit) as NarrativeEntry[];
    } catch {
      return [];
    }
  }

  private generateNarrative(data: SessionData): string {
    const parts: string[] = [];
    if (data.filesModified.length > 0) {
      parts.push(
        `I worked on ${data.filesModified.length} file${data.filesModified.length > 1 ? "s" : ""}`,
      );
    } else if (data.actionsCount > 0) {
      parts.push(`I performed ${data.actionsCount} action${data.actionsCount > 1 ? "s" : ""}`);
    } else {
      parts.push("I had a conversation");
    }
    if (data.project) {
      parts.push(`in the ${data.project.split("/").pop() ?? data.project} project`);
    }
    if (data.topicsDiscussed.length > 0) {
      parts.push(`covering ${data.topicsDiscussed.slice(0, 3).join(", ")}`);
    }
    const uniqueTools = [...new Set(data.toolsUsed)];
    if (uniqueTools.length > 0) parts.push(`using ${uniqueTools.slice(0, 4).join(", ")}`);
    if (data.errorsEncountered > 0)
      parts.push(
        `(encountered ${data.errorsEncountered} error${data.errorsEncountered > 1 ? "s" : ""})`,
      );
    if (data.filesModified.length > 0 && data.filesModified.length <= 5) {
      parts.push(`— modified: ${data.filesModified.map((f) => f.split("/").pop()).join(", ")}`);
    } else if (data.filesModified.length > 5) {
      parts.push(
        `— modified: ${data.filesModified
          .slice(0, 3)
          .map((f) => f.split("/").pop())
          .join(", ")} and ${data.filesModified.length - 3} more`,
      );
    }
    return parts.join(" ") + ".";
  }
}

let _narrative: NarrativeManager | null = null;
export function getNarrativeManager(): NarrativeManager {
  if (!_narrative) _narrative = new NarrativeManager();
  return _narrative;
}
