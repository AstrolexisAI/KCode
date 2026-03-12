// KCode - Conversation Export
// Export conversation transcripts to markdown or JSON format

import { writeFileSync } from "node:fs";
import type { TranscriptEntry } from "./transcript";

// ─── Types ──────────────────────────────────────────────────────

export type ExportFormat = "markdown" | "json";

// ─── Export Functions ───────────────────────────────────────────

/**
 * Export conversation entries to a formatted string.
 * @param messages Array of transcript entries to export
 * @param format Output format: "markdown" or "json"
 */
export function exportConversation(messages: TranscriptEntry[], format: ExportFormat): string {
  if (format === "json") {
    return JSON.stringify(messages, null, 2);
  }

  return exportAsMarkdown(messages);
}

/**
 * Save exported content to a file.
 * @param content The exported string content
 * @param filePath Absolute or relative path to write to
 */
export function saveExport(content: string, filePath: string): void {
  writeFileSync(filePath, content, "utf-8");
}

// ─── Markdown Rendering ────────────────────────────────────────

function exportAsMarkdown(messages: TranscriptEntry[]): string {
  const lines: string[] = [];

  lines.push("# KCode Conversation Export");
  lines.push("");

  for (const entry of messages) {
    const time = formatTimestamp(entry.timestamp);

    switch (entry.type) {
      case "user_message":
        lines.push(`> **user** (${time}):`);
        lines.push(`> ${escapeMarkdownQuote(entry.content)}`);
        lines.push("");
        break;

      case "assistant_text":
        lines.push(`**assistant** (${time}):`);
        lines.push(entry.content);
        lines.push("");
        break;

      case "tool_use":
        lines.push(`**tool use** (${time}):`);
        lines.push("```json");
        lines.push(formatToolContent(entry.content));
        lines.push("```");
        lines.push("");
        break;

      case "tool_result":
        lines.push(`**tool result** (${time}):`);
        lines.push("```");
        lines.push(truncateContent(entry.content, 2000));
        lines.push("```");
        lines.push("");
        break;

      case "thinking":
        lines.push(`*thinking* (${time}):`);
        lines.push(`*${entry.content}*`);
        lines.push("");
        break;

      case "error":
        lines.push(`**error** (${time}):`);
        lines.push(`> ${entry.content}`);
        lines.push("");
        break;

      default:
        lines.push(entry.content);
        lines.push("");
        break;
    }
  }

  return lines.join("\n");
}

// ─── Helpers ────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", { hour12: false });
  } catch {
    return iso;
  }
}

function escapeMarkdownQuote(text: string): string {
  return text.replace(/\n/g, "\n> ");
}

function formatToolContent(content: string): string {
  try {
    const parsed = JSON.parse(content);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return content;
  }
}

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + "\n... (truncated)";
}
