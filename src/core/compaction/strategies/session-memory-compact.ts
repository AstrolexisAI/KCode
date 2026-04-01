// KCode - Session Memory Compact Strategy
// Generates a structured summary of a previous session for /resume continuations.
// Only activates when transcript exceeds the threshold (default 50 messages).

import { log } from "../../logger.js";
import type { Message, TextBlock } from "../../types.js";
import type {
  LlmSummarizer,
  SessionMemoryCompactConfig,
  SessionMemoryCompactResult,
} from "../types.js";

// ─── Session Memory Prompt ──────────────────────────────────────

const SESSION_MEMORY_SYSTEM_PROMPT =
  "You are a session summarizer for a coding assistant. " +
  "Generate a structured summary of the previous session for seamless continuation. " +
  "Be concise and factual.";

const SESSION_MEMORY_USER_PROMPT_TEMPLATE =
  "Summarize this previous coding session. Output a structured summary with these sections:\n\n" +
  "## What was done\nBrief narrative of the session.\n\n" +
  "## Files modified\nList of file paths that were created, edited, or deleted.\n\n" +
  "## Pending tasks\nWhat was left unfinished or planned for next.\n\n" +
  "## User preferences\nAny preferences the user expressed during the session.\n\n" +
  "Keep the total under 3000 tokens.\n\n---\n\n";

// ─── Session Memory Compact ─────────────────────────────────────

/**
 * Compact a previous session's transcript into a structured summary.
 * Returns null if the transcript is below the threshold (load full transcript instead).
 *
 * @param messages - The full transcript from the previous session
 * @param summarizer - Injected LLM call function
 * @param config - Session memory compact configuration
 */
export async function sessionMemoryCompact(
  messages: Message[],
  summarizer: LlmSummarizer,
  config?: Partial<SessionMemoryCompactConfig>,
): Promise<SessionMemoryCompactResult | null> {
  const threshold = config?.thresholdMessages ?? 50;

  if (messages.length <= threshold) {
    log.info(
      "compaction",
      `Session transcript (${messages.length} msgs) below threshold (${threshold}), skipping session-memory compact`,
    );
    return null;
  }

  // Build the transcript text
  const transcriptText = messagesToTranscript(messages);
  const prompt = SESSION_MEMORY_USER_PROMPT_TEMPLATE + transcriptText;

  const summaryText = await summarizer(prompt, SESSION_MEMORY_SYSTEM_PROMPT, 3000);

  if (!summaryText) {
    log.warn("compaction", "Session memory compact: LLM returned null");
    return null;
  }

  // Parse the structured sections from the summary
  const result = parseSessionSummary(summaryText, messages);

  log.info(
    "compaction",
    `Session memory compact: ${messages.length} msgs -> summary (${result.filesModified.length} files, ${result.pendingTasks.length} tasks)`,
  );

  return result;
}

/**
 * Build a system message from a session memory compact result,
 * suitable for injection at the start of a resumed conversation.
 */
export function buildSessionResumptionMessage(result: SessionMemoryCompactResult): Message {
  const parts = [`[Sesion anterior resumida]`, ``, result.summary];

  if (result.filesModified.length > 0) {
    parts.push("", "Archivos modificados:", ...result.filesModified.map((f) => `  - ${f}`));
  }

  if (result.pendingTasks.length > 0) {
    parts.push("", "Tareas pendientes:", ...result.pendingTasks.map((t) => `  - ${t}`));
  }

  if (result.userPreferences.length > 0) {
    parts.push("", "Preferencias del usuario:", ...result.userPreferences.map((p) => `  - ${p}`));
  }

  return {
    role: "user",
    content: [{ type: "text", text: parts.join("\n") } as TextBlock],
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function messagesToTranscript(messages: Message[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    if (typeof msg.content === "string") {
      lines.push(`${role}: ${msg.content.slice(0, 400)}`);
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "text") {
        lines.push(`${role}: ${block.text.slice(0, 400)}`);
      } else if (block.type === "tool_use") {
        lines.push(`${role} [${block.name}]: ${JSON.stringify(block.input).slice(0, 200)}`);
      } else if (block.type === "tool_result") {
        const content =
          typeof block.content === "string" ? block.content.slice(0, 200) : "[result]";
        lines.push(`${role} [result${block.is_error ? " ERROR" : ""}]: ${content}`);
      }
    }
  }
  // Cap total transcript to ~20K chars to avoid huge LLM calls
  const full = lines.join("\n");
  return full.length > 20_000 ? full.slice(0, 20_000) + "\n[transcript truncated]" : full;
}

/**
 * Parse the LLM summary output into structured sections.
 * Also scan original messages for file paths as a fallback.
 */
function parseSessionSummary(
  summaryText: string,
  originalMessages: Message[],
): SessionMemoryCompactResult {
  const filesModified = extractSection(summaryText, "Files modified", "files modified");
  const pendingTasks = extractSection(summaryText, "Pending tasks", "pending tasks");
  const userPreferences = extractSection(summaryText, "User preferences", "user preferences");

  // If LLM didn't extract files, scan messages for tool_use with file paths
  const finalFiles =
    filesModified.length > 0 ? filesModified : extractFilePathsFromMessages(originalMessages);

  return {
    summary: summaryText,
    filesModified: finalFiles,
    pendingTasks,
    userPreferences,
  };
}

function extractSection(text: string, ...headers: string[]): string[] {
  for (const header of headers) {
    const regex = new RegExp(`##?\\s*${header}[\\s\\S]*?(?=\\n##|$)`, "i");
    const match = text.match(regex);
    if (match) {
      const lines = match[0]
        .split("\n")
        .slice(1)
        .map((l) => l.replace(/^[\s-*]+/, "").trim())
        .filter((l) => l.length > 0);
      if (lines.length > 0) return lines;
    }
  }
  return [];
}

function extractFilePathsFromMessages(messages: Message[]): string[] {
  const paths = new Set<string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        const input = block.input as Record<string, unknown>;
        if (typeof input.file_path === "string") paths.add(input.file_path);
        if (typeof input.path === "string") paths.add(input.path as string);
      }
    }
  }
  return Array.from(paths).slice(0, 20); // Cap at 20 paths
}
