// KCode - Session Transcript Persistence
// Saves conversation transcripts to ~/.kcode/transcripts/ in JSONL format

import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Types ───────────────────────────────────────────────────────

export type TranscriptEntryType =
  | "user_message"
  | "assistant_text"
  | "tool_use"
  | "tool_result"
  | "thinking"
  | "error";

export interface TranscriptEntry {
  timestamp: string;
  role: string;
  type: TranscriptEntryType;
  content: string;
}

interface SessionMeta {
  filename: string;
  startedAt: string;
  prompt: string;
}

// ─── Constants ───────────────────────────────────────────────────

const TRANSCRIPTS_DIR = join(homedir(), ".kcode", "transcripts");
const MAX_SESSIONS = 100;

// ─── TranscriptManager ──────────────────────────────────────────

export class TranscriptManager {
  private sessionFile: string | null = null;

  constructor() {
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!existsSync(TRANSCRIPTS_DIR)) {
      mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
    }
  }

  /**
   * Start a new transcript session.
   * Filename: {timestamp}-{first-words-of-prompt}.jsonl
   */
  startSession(prompt: string): void {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const slug = prompt
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 40)
      .replace(/-$/, "");
    const filename = `${timestamp}-${slug || "session"}.jsonl`;
    this.sessionFile = join(TRANSCRIPTS_DIR, filename);

    // Write initial user message
    this.appendEntry({
      timestamp: now.toISOString(),
      role: "user",
      type: "user_message",
      content: prompt,
    });

    // Prune old sessions if over limit
    this.pruneOldSessions();
  }

  /**
   * Append a transcript entry to the current session file.
   * Uses append mode for crash safety.
   */
  appendEntry(entry: TranscriptEntry): void {
    if (!this.sessionFile) return;

    try {
      appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // Silently ignore write failures to avoid disrupting the session
    }
  }

  /**
   * Convenience: append a typed entry with auto-timestamp.
   */
  append(role: string, type: TranscriptEntryType, content: string): void {
    this.appendEntry({
      timestamp: new Date().toISOString(),
      role,
      type,
      content,
    });
  }

  /**
   * End the current session (optional marker entry).
   */
  endSession(): void {
    if (!this.sessionFile) return;

    this.append("system", "assistant_text", "[session ended]");
    this.sessionFile = null;
  }

  /**
   * List all saved sessions, newest first.
   */
  listSessions(): SessionMeta[] {
    this.ensureDir();

    const files = readdirSync(TRANSCRIPTS_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();

    return files.map((filename) => {
      // Parse timestamp and prompt from filename
      // Format: 2026-03-12T10-30-00-some-prompt-slug.jsonl
      const match = filename.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(.+)\.jsonl$/);
      const startedAt = match ? match[1].replace(/-/g, (m, i) => (i > 9 ? ":" : m)) : filename;
      const prompt = match ? match[2].replace(/-/g, " ") : filename;

      return { filename, startedAt, prompt };
    });
  }

  /**
   * Load all entries from a session file.
   */
  loadSession(filename: string): TranscriptEntry[] {
    const filePath = join(TRANSCRIPTS_DIR, filename);
    if (!existsSync(filePath)) return [];

    const content = readFileSync(filePath, "utf-8");
    const entries: TranscriptEntry[] = [];

    for (const line of content.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        entries.push(JSON.parse(line) as TranscriptEntry);
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  }

  /**
   * Prune oldest sessions to keep directory under MAX_SESSIONS.
   */
  private pruneOldSessions(): void {
    try {
      const files = readdirSync(TRANSCRIPTS_DIR)
        .filter((f) => f.endsWith(".jsonl"))
        .sort(); // oldest first

      const excess = files.length - MAX_SESSIONS;
      if (excess <= 0) return;

      for (let i = 0; i < excess; i++) {
        try {
          unlinkSync(join(TRANSCRIPTS_DIR, files[i]));
        } catch {
          // Ignore individual deletion failures
        }
      }
    } catch {
      // Ignore pruning failures
    }
  }

  /**
   * Whether a session is currently active.
   */
  get isActive(): boolean {
    return this.sessionFile !== null;
  }
}
