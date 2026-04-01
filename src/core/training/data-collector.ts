// KCode - Training Data Collector
// Collects accepted/rejected/edited interaction pairs for fine-tuning

import { mkdirSync, existsSync, renameSync, statSync, appendFileSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { kcodePath } from "../paths";
import { log } from "../logger";

// ─── Types ──────────────────────────────────────────────────────

export interface TrainingPair {
  prompt: string;
  response: string;
  accepted: boolean;
  editedResponse?: string;
  model: string;
  timestamp: number;
  sessionId: string;
}

export interface DataCollectorStats {
  total: number;
  accepted: number;
  rejected: number;
  edited: number;
  sizeBytes: number;
}

// ─── Constants ──────────────────────────────────────────────────

const TRAINING_DIR = "training-data";
const PAIRS_FILE = "pairs.jsonl";
const MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

// ─── Path Sanitization ─────────────────────────────────────────

/**
 * Sanitize text for training data: replace absolute paths and usernames
 * with placeholders to protect privacy.
 */
export function sanitizeForTraining(text: string): string {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const username = process.env.USER ?? process.env.USERNAME ?? "";

  let sanitized = text;

  // Replace home directory path with placeholder
  if (homeDir) {
    sanitized = sanitized.replaceAll(homeDir, "~");
  }

  // Replace username occurrences in paths (e.g., /home/username/ or /Users/username/)
  if (username && username.length > 2) {
    // Only replace in path-like contexts to avoid false positives
    const pathPattern = new RegExp(`(/(?:home|Users)/)${escapeRegex(username)}(/|\\b)`, "g");
    sanitized = sanitized.replace(pathPattern, "$1<USER>$2");
  }

  return sanitized;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── DataCollector Class ────────────────────────────────────────

export class DataCollector {
  private dataDir: string;
  private filePath: string;
  private sessionId: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? `session-${Date.now()}`;
    this.dataDir = kcodePath(TRAINING_DIR);
    this.filePath = join(this.dataDir, PAIRS_FILE);
    mkdirSync(this.dataDir, { recursive: true });
  }

  /** Record an accepted response (user didn't reject or edit). */
  recordAccepted(prompt: string, response: string, model: string): void {
    this.appendPair({
      prompt: sanitizeForTraining(prompt),
      response: sanitizeForTraining(response),
      accepted: true,
      model,
      timestamp: Date.now(),
      sessionId: this.sessionId,
    });
  }

  /** Record a rejected response. */
  recordRejected(prompt: string, response: string, model: string): void {
    this.appendPair({
      prompt: sanitizeForTraining(prompt),
      response: sanitizeForTraining(response),
      accepted: false,
      model,
      timestamp: Date.now(),
      sessionId: this.sessionId,
    });
  }

  /** Record a response that was edited by the user. */
  recordEdited(prompt: string, original: string, edited: string, model: string): void {
    this.appendPair({
      prompt: sanitizeForTraining(prompt),
      response: sanitizeForTraining(original),
      accepted: true,
      editedResponse: sanitizeForTraining(edited),
      model,
      timestamp: Date.now(),
      sessionId: this.sessionId,
    });
  }

  /** Get statistics about collected training data. */
  getStats(): DataCollectorStats {
    const stats: DataCollectorStats = { total: 0, accepted: 0, rejected: 0, edited: 0, sizeBytes: 0 };

    if (!existsSync(this.filePath)) return stats;

    try {
      stats.sizeBytes = statSync(this.filePath).size;
      const content = readFileSync(this.filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const pair = JSON.parse(line) as TrainingPair;
          stats.total++;
          if (pair.editedResponse) {
            stats.edited++;
          } else if (pair.accepted) {
            stats.accepted++;
          } else {
            stats.rejected++;
          }
        } catch {
          /* skip malformed lines */
        }
      }
    } catch (err) {
      log.error("training", `Failed to read stats: ${err}`);
    }

    return stats;
  }

  /**
   * Export training data as fine-tuning JSONL.
   * Format: {"messages": [{"role":"user","content":"..."}, {"role":"assistant","content":"..."}]}
   * Only exports accepted/edited pairs. Returns count of exported pairs.
   */
  async exportJSONL(outputPath: string): Promise<number> {
    if (!existsSync(this.filePath)) return 0;

    const content = readFileSync(this.filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    let count = 0;

    const outputDir = dirname(outputPath);
    mkdirSync(outputDir, { recursive: true });

    const outputLines: string[] = [];

    for (const line of lines) {
      try {
        const pair = JSON.parse(line) as TrainingPair;
        // Only export accepted or edited pairs
        if (!pair.accepted && !pair.editedResponse) continue;

        const response = pair.editedResponse ?? pair.response;
        const entry = {
          messages: [
            { role: "user", content: pair.prompt },
            { role: "assistant", content: response },
          ],
        };
        outputLines.push(JSON.stringify(entry));
        count++;
      } catch {
        /* skip malformed */
      }
    }

    writeFileSync(outputPath, outputLines.join("\n") + "\n", "utf-8");
    return count;
  }

  /** Clear all collected training data. */
  clear(): void {
    if (existsSync(this.filePath)) {
      unlinkSync(this.filePath);
    }
  }

  /** Read all pairs (for review). */
  readPairs(): TrainingPair[] {
    if (!existsSync(this.filePath)) return [];

    const content = readFileSync(this.filePath, "utf-8");
    const pairs: TrainingPair[] = [];
    for (const line of content.trim().split("\n").filter(Boolean)) {
      try {
        pairs.push(JSON.parse(line) as TrainingPair);
      } catch {
        /* skip */
      }
    }
    return pairs;
  }

  // ─── Private ────────────────────────────────────────────────

  private appendPair(pair: TrainingPair): void {
    this.rotateIfNeeded();
    try {
      appendFileSync(this.filePath, JSON.stringify(pair) + "\n", "utf-8");
    } catch (err) {
      log.error("training", `Failed to append training pair: ${err}`);
    }
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.filePath)) return;

    try {
      const size = statSync(this.filePath).size;
      if (size >= MAX_SIZE_BYTES) {
        const archivePath = join(this.dataDir, `pairs-${Date.now()}.jsonl.archive`);
        renameSync(this.filePath, archivePath);
        log.info("training", `Rotated training data to ${archivePath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
      }
    } catch (err) {
      log.error("training", `Failed to rotate training data: ${err}`);
    }
  }
}
