// KCode - Session Transcript Persistence
// Saves conversation transcripts to ~/.kcode/transcripts/ in JSONL format

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { log } from "./logger";
import { kcodePath } from "./paths";
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "./types";

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

const TRANSCRIPTS_DIR = kcodePath("transcripts");
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
   * Filename: {timestamp}-{sessionName-or-first-words-of-prompt}.jsonl
   */
  startSession(prompt: string, sessionName?: string): void {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const slug = (sessionName || prompt)
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
    } catch (err) {
      log.debug("transcript", `Failed to append transcript entry: ${err}`);
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
      const startedAt = match ? match[1]!.replace(/-/g, (m, i) => (i > 9 ? ":" : m)) : filename;
      const prompt = match ? match[2]!.replace(/-/g, " ") : filename;

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
      } catch (err) {
        log.debug("transcript", `Skipping malformed transcript line: ${err}`);
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
      if (excess > 0) {
        for (let i = 0; i < excess; i++) {
          try {
            unlinkSync(join(TRANSCRIPTS_DIR, files[i]!));
          } catch (err) {
            log.debug("transcript", `Failed to delete old transcript ${files[i]}: ${err}`);
          }
        }
      }

      // Also delete sessions older than 30 days
      const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      for (const f of files) {
        const match = f.match(/^(\d{4}-\d{2}-\d{2})/);
        if (match) {
          const fileDate = new Date(match[1]!);
          if (fileDate < cutoffDate) {
            try {
              unlinkSync(join(TRANSCRIPTS_DIR, f));
            } catch (err) {
              log.debug("transcript", `Failed to delete expired transcript ${f}: ${err}`);
            }
          }
        }
      }
    } catch (err) {
      log.debug("transcript", `Failed to prune old sessions: ${err}`);
    }
  }

  /**
   * Whether a session is currently active.
   */
  get isActive(): boolean {
    return this.sessionFile !== null;
  }

  /**
   * Return the filename of the most recent session file, or null if none exist.
   */
  getLatestSession(): string | null {
    this.ensureDir();

    const files = readdirSync(TRANSCRIPTS_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();

    if (files.length === 0) return null;
    return files[files.length - 1] ?? null;
  }

  /**
   * Parse a JSONL session file and reconstruct Message[] for ConversationManager.
   * Maps transcript entry types back to internal Message format.
   */
  loadSessionMessages(filename: string): Message[] {
    const entries = this.loadSession(filename);
    const messages: Message[] = [];

    for (const entry of entries) {
      try {
        switch (entry.type) {
          case "user_message": {
            messages.push({ role: "user", content: entry.content });
            break;
          }

          case "assistant_text": {
            // Merge consecutive assistant_text entries into one message
            const lastMsg = messages[messages.length - 1];
            if (lastMsg && lastMsg.role === "assistant" && Array.isArray(lastMsg.content)) {
              lastMsg.content.push({ type: "text", text: entry.content });
            } else {
              messages.push({
                role: "assistant",
                content: [{ type: "text", text: entry.content }],
              });
            }
            break;
          }

          case "tool_use": {
            const parsed = JSON.parse(entry.content);
            const toolBlock: ToolUseBlock = {
              type: "tool_use",
              id: parsed.id ?? `call_restored_${Date.now()}`,
              name: parsed.name ?? "unknown",
              input: parsed.input ?? {},
            };
            // Merge into existing assistant message or create new one
            const lastAssistant = messages[messages.length - 1];
            if (
              lastAssistant &&
              lastAssistant.role === "assistant" &&
              Array.isArray(lastAssistant.content)
            ) {
              lastAssistant.content.push(toolBlock);
            } else {
              messages.push({
                role: "assistant",
                content: [toolBlock],
              });
            }
            break;
          }

          case "tool_result": {
            const resultBlock: ToolResultBlock = {
              type: "tool_result",
              tool_use_id: entry.content,
              content: entry.content,
            };
            // Try to parse structured content
            try {
              const parsed = JSON.parse(entry.content);
              if (parsed.tool_use_id) {
                resultBlock.tool_use_id = parsed.tool_use_id;
                resultBlock.content = parsed.content ?? entry.content;
                if (parsed.is_error !== undefined) {
                  resultBlock.is_error = parsed.is_error;
                }
              }
            } catch (err) {
              log.debug("transcript", `Failed to parse structured tool result content: ${err}`);
            }
            // Merge into existing user tool_result message or create new one
            const lastUser = messages[messages.length - 1];
            if (lastUser && lastUser.role === "user" && Array.isArray(lastUser.content)) {
              (lastUser.content as ContentBlock[]).push(resultBlock);
            } else {
              messages.push({
                role: "user",
                content: [resultBlock],
              });
            }
            break;
          }

          // Skip thinking and error entries — not needed for resume
          default:
            break;
        }
      } catch (err) {
        log.debug("transcript", `Failed to parse session message entry: ${err}`);
      }
    }

    return messages;
  }

  // ─── Phase 12: Enhanced resume ─────────────────────────────

  /**
   * Search sessions by keyword across prompts and content.
   * Returns matching sessions with context snippets.
   */
  searchSessions(query: string, maxResults = 10): Array<SessionMeta & { snippet: string }> {
    const sessions = this.listSessions();
    const queryLower = query.toLowerCase();
    const results: Array<SessionMeta & { snippet: string }> = [];

    for (const session of sessions) {
      if (results.length >= maxResults) break;

      // Check filename/prompt first (fast)
      if (session.prompt.toLowerCase().includes(queryLower)) {
        results.push({ ...session, snippet: session.prompt });
        continue;
      }

      // Search content (slower, only if prompt didn't match)
      try {
        const entries = this.loadSession(session.filename);
        for (const entry of entries) {
          if (entry.content.toLowerCase().includes(queryLower)) {
            // Extract snippet around match
            const idx = entry.content.toLowerCase().indexOf(queryLower);
            const start = Math.max(0, idx - 40);
            const end = Math.min(entry.content.length, idx + query.length + 40);
            const snippet =
              (start > 0 ? "..." : "") +
              entry.content.slice(start, end).replace(/\n/g, " ") +
              (end < entry.content.length ? "..." : "");
            results.push({ ...session, snippet });
            break;
          }
        }
      } catch (err) {
        log.debug("transcript", `Failed to search session ${session.filename}: ${err}`);
      }
    }

    return results;
  }

  /**
   * Get a summary of a session (first user message + message count + tool count).
   */
  getSessionSummary(
    filename: string,
  ): { prompt: string; messageCount: number; toolUseCount: number; duration: string } | null {
    const entries = this.loadSession(filename);
    if (entries.length === 0) return null;

    const firstUser = entries.find((e) => e.type === "user_message");
    const lastEntry = entries[entries.length - 1];
    const toolUseCount = entries.filter((e) => e.type === "tool_use").length;

    let duration = "unknown";
    try {
      const startTime = new Date(entries[0]!.timestamp).getTime();
      const endTime = new Date(lastEntry!.timestamp).getTime();
      const mins = Math.round((endTime - startTime) / 60_000);
      duration = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
    } catch (err) {
      log.debug("transcript", `Failed to calculate session duration: ${err}`);
    }

    return {
      prompt: firstUser?.content.slice(0, 100) ?? "(empty)",
      messageCount: entries.length,
      toolUseCount,
      duration,
    };
  }
}
