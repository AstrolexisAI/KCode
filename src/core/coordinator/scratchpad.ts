// KCode - Coordinator Scratchpad
// Shared filesystem-based workspace for coordinator and workers

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ScratchpadEntry, ScratchpadLogEntry } from "./types";

/**
 * Shared scratchpad for coordinator-worker communication.
 * Files live under ~/.kcode/scratchpad/{sessionId}/.
 *
 * Standard files:
 *   plan.md       - shared plan
 *   progress.md   - progress log
 *   worker-{id}.md - per-worker output
 *   notes.md      - general notes
 */
export class Scratchpad {
  private dir: string;
  private logPath: string;

  constructor(sessionId: string, baseDir?: string) {
    const base = baseDir ?? join(homedir(), ".kcode", "scratchpad");
    this.dir = join(base, sessionId);
    mkdirSync(this.dir, { recursive: true });
    this.logPath = join(this.dir, ".scratchpad.log");
  }

  /** Write a file to the scratchpad */
  write(file: string, content: string, author: string): void {
    this.validateFileName(file);
    const fullPath = join(this.dir, file);
    writeFileSync(fullPath, content, "utf-8");
    this.appendLog({ file, author, action: "write", timestamp: Date.now() });
  }

  /** Read a file from the scratchpad */
  read(file: string): string | null {
    this.validateFileName(file);
    const fullPath = join(this.dir, file);
    if (!existsSync(fullPath)) return null;
    return readFileSync(fullPath, "utf-8");
  }

  /** Append content to a file (useful for logs/progress) */
  append(file: string, content: string, author: string): void {
    this.validateFileName(file);
    const fullPath = join(this.dir, file);
    appendFileSync(fullPath, content, "utf-8");
    this.appendLog({ file, author, action: "write", timestamp: Date.now() });
  }

  /** Check if a file exists in the scratchpad */
  exists(file: string): boolean {
    this.validateFileName(file);
    return existsSync(join(this.dir, file));
  }

  /** List all files in the scratchpad (excluding hidden files) */
  list(): ScratchpadEntry[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => !f.startsWith("."))
      .map((file) => {
        const fullPath = join(this.dir, file);
        return {
          file,
          content: readFileSync(fullPath, "utf-8"),
          author: this.getAuthor(file),
          timestamp: statSync(fullPath).mtimeMs,
        };
      });
  }

  /** Clean up scratchpad (remove entire directory) */
  cleanup(): void {
    if (existsSync(this.dir)) {
      rmSync(this.dir, { recursive: true, force: true });
    }
  }

  /** Get the scratchpad directory path */
  getPath(): string {
    return this.dir;
  }

  /** Get the author of the last write to a file from log */
  private getAuthor(file: string): string {
    if (!existsSync(this.logPath)) return "unknown";
    try {
      const logContent = readFileSync(this.logPath, "utf-8");
      const lines = logContent.trim().split("\n").filter(Boolean);
      // Find last write entry for this file
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]!) as ScratchpadLogEntry;
          if (entry.file === file && entry.action === "write") {
            return entry.author;
          }
        } catch {
          /* cleanup — ignore failures */
        }
      }
    } catch {
      // Log file unreadable
    }
    return "unknown";
  }

  /** Append to the scratchpad log */
  private appendLog(entry: ScratchpadLogEntry): void {
    try {
      appendFileSync(this.logPath, JSON.stringify(entry) + "\n");
    } catch {
      // Best effort logging
    }
  }

  /** Validate file name to prevent path traversal */
  private validateFileName(file: string): void {
    // Block absolute Windows paths (check before backslash to give specific error)
    if (/^[a-zA-Z]:/.test(file)) {
      throw new Error("Invalid scratchpad file name: absolute paths not allowed");
    }
    if (file.includes("..") || file.startsWith("/") || file.includes("\\")) {
      throw new Error("Invalid scratchpad file name: path traversal not allowed");
    }
    // Block empty names
    if (!file || file.trim().length === 0) {
      throw new Error("Invalid scratchpad file name: empty name not allowed");
    }
  }
}
