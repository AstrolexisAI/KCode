// KCode - Logging System
// Lightweight file logger with daily rotation and buffered writes

import { readdirSync, unlinkSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { kcodePath } from "./paths";
import { appendFile } from "node:fs/promises";

// ─── Types ──────────────────────────────────────────────────────

type LogLevel = "debug" | "info" | "warn" | "error";
type LogCategory = "llm" | "tool" | "permission" | "mcp" | "config" | "session" | "general" | "db" | "narrative" | "indexer" | "intentions" | "learn" | "user-model" | "world-model" | "process" | (string & {});

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ─── Configuration ──────────────────────────────────────────────

const LOG_DIR = kcodePath("logs");
const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_THRESHOLD = 10;
const MAX_LOG_AGE_DAYS = 7;

function getConfiguredLevel(): LogLevel {
  const env = process.env.KCODE_LOG_LEVEL?.toLowerCase();
  if (env && env in LOG_LEVEL_PRIORITY) return env as LogLevel;
  return "info";
}

function isLoggingEnabled(): boolean {
  return process.env.KCODE_LOG !== "false";
}

// ─── Logger ─────────────────────────────────────────────────────

class Logger {
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private minLevel: LogLevel;
  private enabled: boolean;
  private initialized = false;
  private lastLogDate: string = "";

  constructor() {
    this.minLevel = getConfiguredLevel();
    this.enabled = isLoggingEnabled();
  }

  /** Initialize the logger: ensure log dir, clean old files, start flush timer. */
  init(): void {
    if (this.initialized || !this.enabled) return;
    this.initialized = true;

    try {
      mkdirSync(LOG_DIR, { recursive: true });
    } catch {
      // If we can't create the directory, disable logging silently
      this.enabled = false;
      return;
    }

    this.cleanOldLogs();
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    // Ensure the timer doesn't prevent process exit
    if (this.flushTimer && typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
      this.flushTimer.unref();
    }

    // Flush on exit
    process.on("beforeExit", () => this.flush());
    process.on("exit", () => this.flushSync());
  }

  debug(category: LogCategory, message: string, data?: unknown): void {
    this.write("debug", category, message, data);
  }

  info(category: LogCategory, message: string, data?: unknown): void {
    this.write("info", category, message, data);
  }

  warn(category: LogCategory, message: string, data?: unknown): void {
    this.write("warn", category, message, data);
  }

  error(category: LogCategory, message: string, data?: unknown): void {
    this.write("error", category, message, data);
  }

  // ─── Internal ───────────────────────────────────────────────

  private write(level: LogLevel, category: LogCategory, message: string, data?: unknown): void {
    if (!this.enabled) return;
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minLevel]) return;

    // Lazy init on first write
    if (!this.initialized) this.init();

    const timestamp = new Date().toISOString();
    const levelTag = level.toUpperCase();
    let line = `[${timestamp}] [${levelTag}] [${category}] ${message}`;

    if (data !== undefined) {
      try {
        if (data instanceof Error) {
          line += ` ${JSON.stringify({ error: data.message, stack: data.stack })}`;
        } else {
          line += ` ${JSON.stringify(data)}`;
        }
      } catch {
        // Non-serializable data, skip
      }
    }

    this.buffer.push(line);

    if (this.buffer.length >= FLUSH_THRESHOLD) {
      this.flush();
    }
  }

  private getLogFilePath(): string {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    if (date !== this.lastLogDate) {
      this.lastLogDate = date;
      this.cleanOldLogs();
    }
    return join(LOG_DIR, `kcode-${date}.log`);
  }

  /** Flush buffered log entries to file (fire-and-forget async append). */
  flush(): void {
    if (this.buffer.length === 0) return;
    const lines = this.buffer.splice(0);
    const content = lines.join("\n") + "\n";
    const path = this.getLogFilePath();

    try {
      appendFile(path, content).catch(() => {});
    } catch {
      // Never crash the app due to logging
    }
  }

  /** Synchronous flush for process exit. */
  private flushSync(): void {
    if (this.buffer.length === 0) return;
    const lines = this.buffer.splice(0);
    const content = lines.join("\n") + "\n";
    const path = this.getLogFilePath();

    try {
      appendFileSync(path, content);
    } catch {
      // Nothing we can do on exit
    }
  }

  /** Delete log files older than MAX_LOG_AGE_DAYS. */
  private cleanOldLogs(): void {
    try {
      const entries = readdirSync(LOG_DIR);
      const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;

      for (const entry of entries) {
        if (!entry.startsWith("kcode-") || !entry.endsWith(".log")) continue;
        // Extract date from filename: kcode-YYYY-MM-DD.log
        const dateStr = entry.slice(6, 16);
        const fileDate = new Date(dateStr).getTime();
        if (!isNaN(fileDate) && fileDate < cutoff) {
          try {
            unlinkSync(join(LOG_DIR, entry));
          } catch {
            // Skip files we can't delete
          }
        }
      }
    } catch {
      // Log directory might not exist yet
    }
  }

  /** Force shutdown: flush and stop timer. */
  shutdown(): void {
    this.flush();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────

export const log = new Logger();
