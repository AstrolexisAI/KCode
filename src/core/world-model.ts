// KCode - Layer 6: World Model
// Heuristic prediction engine — predicts outcomes before actions and compares after
// Discrepancies become learnings that improve future predictions

import { getDb } from "./db";
import { log } from "./logger";

// ─── Types ───────────────────────────────────────────────────────

export interface Prediction {
  action: string;
  expected: string;
  confidence: number; // 0.0 to 1.0
}

export interface Discrepancy {
  action: string;
  expected: string;
  actual: string;
  created_at: string;
}

// ─── World Model ─────────────────────────────────────────────────

export class WorldModel {
  /**
   * Generate a prediction for a tool action before it executes.
   */
  predict(toolName: string, input: Record<string, unknown>): Prediction {
    const action = this.describeAction(toolName, input);
    const confidence = this.estimateConfidence(toolName, input);
    const expected = this.generateExpectation(toolName, input);
    return { action, expected, confidence };
  }

  /**
   * Compare a prediction with the actual result. Stores discrepancies.
   */
  compare(prediction: Prediction, actualResult: string, isError?: boolean): void {
    try {
      const db = getDb();
      const correct = !isError && this.resultMatchesExpectation(prediction.expected, actualResult);
      db.query(
        "INSERT INTO predictions (action, expected, actual, confidence, correct) VALUES (?, ?, ?, ?, ?)",
      ).run(
        prediction.action,
        prediction.expected,
        actualResult.slice(0, 500),
        prediction.confidence,
        correct ? 1 : 0,
      );
    } catch (err) {
      log.error("world-model", `Failed to record prediction: ${err}`);
    }
  }

  /**
   * Load recent discrepancies for system prompt injection.
   */
  loadRecentDiscrepancies(limit = 5): Discrepancy[] {
    try {
      const db = getDb();
      return db
        .query(
          `SELECT action, expected, actual, created_at FROM predictions
         WHERE correct = 0 AND actual IS NOT NULL
         ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit) as Discrepancy[];
    } catch (err) {
      log.error("world-model", `Failed to load discrepancies: ${err}`);
      return [];
    }
  }

  getAccuracy(toolName?: string): { total: number; correct: number; rate: number } {
    try {
      const db = getDb();
      const where = toolName ? "WHERE action LIKE ?" : "";
      const params = toolName ? [`${toolName}%`] : [];
      const row = db
        .query(
          `SELECT COUNT(*) as total, SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) as correct FROM predictions ${where}`,
        )
        .get(...params) as { total: number; correct: number };
      return {
        total: row.total,
        correct: row.correct ?? 0,
        rate: row.total > 0 ? (row.correct ?? 0) / row.total : 0,
      };
    } catch {
      return { total: 0, correct: 0, rate: 0 };
    }
  }

  private describeAction(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case "Bash":
        return `Bash: ${String(input.command ?? "").slice(0, 80)}`;
      case "Read":
        return `Read: ${input.file_path}`;
      case "Write":
        return `Write: ${input.file_path}`;
      case "Edit":
        return `Edit: ${input.file_path}`;
      case "Glob":
        return `Glob: ${input.pattern}`;
      case "Grep":
        return `Grep: ${input.pattern}`;
      default:
        return `${toolName}: ${JSON.stringify(input).slice(0, 80)}`;
    }
  }

  private estimateConfidence(toolName: string, _input: Record<string, unknown>): number {
    const baseConfidence: Record<string, number> = {
      Read: 0.9,
      Glob: 0.8,
      Grep: 0.7,
      Write: 0.85,
      Edit: 0.7,
      Bash: 0.6,
      WebFetch: 0.5,
      WebSearch: 0.5,
    };
    let confidence = baseConfidence[toolName] ?? 0.5;
    const accuracy = this.getAccuracy(toolName);
    if (accuracy.total >= 5) {
      confidence = confidence * 0.4 + accuracy.rate * 0.6;
    }
    return Math.round(confidence * 100) / 100;
  }

  private generateExpectation(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case "Read":
        return `File ${input.file_path} exists and is readable`;
      case "Write":
        return `File ${input.file_path} created/overwritten successfully`;
      case "Edit":
        return `Edit applied to ${input.file_path}`;
      case "Glob":
        return `Matching files found for pattern ${input.pattern}`;
      case "Grep":
        return `Pattern ${input.pattern} found in files`;
      case "Bash": {
        const cmd = String(input.command ?? "");
        if (cmd.includes("mkdir")) return "Directory created";
        if (cmd.includes("npm install") || cmd.includes("bun install"))
          return "Dependencies installed";
        if (cmd.includes("git ")) return "Git command succeeds";
        return "Command executes without error";
      }
      default:
        return "Operation completes successfully";
    }
  }

  private resultMatchesExpectation(_expected: string, actual: string): boolean {
    const lower = actual.toLowerCase();
    const errorIndicators = [
      "error:",
      "failed",
      "not found",
      "permission denied",
      "no such file",
      "enoent",
    ];
    return !errorIndicators.some((e) => lower.includes(e));
  }
}

let _worldModel: WorldModel | null = null;
export function getWorldModel(): WorldModel {
  if (!_worldModel) _worldModel = new WorldModel();
  return _worldModel;
}
