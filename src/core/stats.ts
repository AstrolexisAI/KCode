// KCode - Usage Statistics
// Aggregates usage data from log files and transcript files

import { join } from "node:path";
import { homedir } from "node:os";
import { readdirSync, readFileSync, statSync } from "node:fs";

// ─── Types ──────────────────────────────────────────────────────

export interface UsageStats {
  totalSessions: number;
  totalMessages: number;
  messagesByRole: Record<string, number>;
  totalToolUses: number;
  toolUsageByName: Record<string, number>;
  requestsByModel: Record<string, number>;
  avgResponseTimeMs: number;
  errorCount: number;
  errorsByCategory: Record<string, number>;
  periodDays: number;
}

// ─── Constants ──────────────────────────────────────────────────

const LOG_DIR = join(homedir(), ".kcode", "logs");
const TRANSCRIPTS_DIR = join(homedir(), ".kcode", "transcripts");

// ─── Log Parsing ────────────────────────────────────────────────

// Log line format: [2026-03-12T10:30:00.000Z] [INFO] [llm] Message {"data": ...}
const LOG_LINE_RE = /^\[([^\]]+)\]\s+\[(\w+)\]\s+\[(\w+)\]\s+(.*)$/;
const STREAM_TIME_RE = /Stream opened in (\d+(?:\.\d+)?)ms/;
const MODEL_RE = /model=([^\s,]+)/;
const TOOL_EXEC_RE = /Tool (?:execution|call|use).*?:\s*(\w+)/i;
const TOOL_NAME_RE = /\btool[_\s]*(?:name|use)?[=:]\s*"?(\w+)"?/i;

interface LogStats {
  requestsByModel: Record<string, number>;
  responseTimes: number[];
  errorCount: number;
  errorsByCategory: Record<string, number>;
  toolUsageByName: Record<string, number>;
}

function getLogFilesInRange(days: number): string[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  try {
    return readdirSync(LOG_DIR)
      .filter((f) => f.startsWith("kcode-") && f.endsWith(".log"))
      .filter((f) => {
        const dateStr = f.slice(6, 16); // kcode-YYYY-MM-DD.log
        const fileDate = new Date(dateStr).getTime();
        return !isNaN(fileDate) && fileDate >= cutoff;
      })
      .map((f) => join(LOG_DIR, f));
  } catch {
    return [];
  }
}

function parseLogFiles(files: string[]): LogStats {
  const stats: LogStats = {
    requestsByModel: {},
    responseTimes: [],
    errorCount: 0,
    errorsByCategory: {},
    toolUsageByName: {},
  };

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;

      const match = line.match(LOG_LINE_RE);
      if (!match) continue;

      const [, , level, category, message] = match;

      // Count errors
      if (level === "ERROR") {
        stats.errorCount++;
        stats.errorsByCategory[category] = (stats.errorsByCategory[category] || 0) + 1;
      }

      // Extract model from LLM requests
      if (category === "llm") {
        const modelMatch = message.match(MODEL_RE);
        if (modelMatch) {
          const model = modelMatch[1];
          stats.requestsByModel[model] = (stats.requestsByModel[model] || 0) + 1;
        }

        // Extract response times
        const timeMatch = message.match(STREAM_TIME_RE);
        if (timeMatch) {
          stats.responseTimes.push(parseFloat(timeMatch[1]));
        }
      }

      // Count tool executions from log entries
      if (category === "tool") {
        const toolMatch = message.match(TOOL_EXEC_RE) || message.match(TOOL_NAME_RE);
        if (toolMatch) {
          const toolName = toolMatch[1];
          stats.toolUsageByName[toolName] = (stats.toolUsageByName[toolName] || 0) + 1;
        }
      }
    }
  }

  return stats;
}

// ─── Transcript Parsing ─────────────────────────────────────────

interface TranscriptStats {
  totalSessions: number;
  totalMessages: number;
  messagesByRole: Record<string, number>;
  totalToolUses: number;
  toolUsageByName: Record<string, number>;
}

function getTranscriptFilesInRange(days: number): string[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  try {
    return readdirSync(TRANSCRIPTS_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .filter((f) => {
        // Filename format: 2026-03-12T10-30-00-slug.jsonl
        const dateStr = f.slice(0, 10); // YYYY-MM-DD
        const fileDate = new Date(dateStr).getTime();
        if (!isNaN(fileDate) && fileDate >= cutoff) return true;
        // Fallback: check file mtime
        try {
          const st = statSync(join(TRANSCRIPTS_DIR, f));
          return st.mtimeMs >= cutoff;
        } catch {
          return false;
        }
      })
      .map((f) => join(TRANSCRIPTS_DIR, f));
  } catch {
    return [];
  }
}

function parseTranscriptFiles(files: string[]): TranscriptStats {
  const stats: TranscriptStats = {
    totalSessions: files.length,
    totalMessages: 0,
    messagesByRole: {},
    totalToolUses: 0,
    toolUsageByName: {},
  };

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;

      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      // Count messages by role
      if (entry.role) {
        stats.totalMessages++;
        stats.messagesByRole[entry.role] = (stats.messagesByRole[entry.role] || 0) + 1;
      }

      // Count tool uses
      if (entry.type === "tool_use") {
        stats.totalToolUses++;
        // Try to extract tool name from the content
        const toolName = extractToolName(entry.content);
        if (toolName) {
          stats.toolUsageByName[toolName] = (stats.toolUsageByName[toolName] || 0) + 1;
        }
      }
    }
  }

  return stats;
}

function extractToolName(content: string): string | null {
  if (!content) return null;
  // Content may be the tool name directly, or JSON with a name field
  try {
    const parsed = JSON.parse(content);
    if (parsed.name) return parsed.name;
  } catch {
    // Not JSON — treat as plain tool name
  }
  // If it looks like a simple word, use it as-is
  const trimmed = content.trim();
  if (/^[A-Za-z_]\w*$/.test(trimmed)) return trimmed;
  return null;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Collect usage statistics from log and transcript files.
 * @param days Number of days to look back (default: 7)
 */
export async function collectStats(days: number = 7): Promise<UsageStats> {
  const logFiles = getLogFilesInRange(days);
  const transcriptFiles = getTranscriptFilesInRange(days);

  const logStats = parseLogFiles(logFiles);
  const transcriptStats = parseTranscriptFiles(transcriptFiles);

  // Merge tool usage from both sources
  const mergedToolUsage: Record<string, number> = { ...transcriptStats.toolUsageByName };
  for (const [tool, count] of Object.entries(logStats.toolUsageByName)) {
    // Only add from logs if not already counted from transcripts
    if (!(tool in mergedToolUsage)) {
      mergedToolUsage[tool] = count;
    }
  }

  const totalToolUses =
    transcriptStats.totalToolUses > 0
      ? transcriptStats.totalToolUses
      : Object.values(logStats.toolUsageByName).reduce((a, b) => a + b, 0);

  const avgResponseTimeMs =
    logStats.responseTimes.length > 0
      ? logStats.responseTimes.reduce((a, b) => a + b, 0) / logStats.responseTimes.length
      : 0;

  return {
    totalSessions: transcriptStats.totalSessions,
    totalMessages: transcriptStats.totalMessages,
    messagesByRole: transcriptStats.messagesByRole,
    totalToolUses,
    toolUsageByName: mergedToolUsage,
    requestsByModel: logStats.requestsByModel,
    avgResponseTimeMs,
    errorCount: logStats.errorCount,
    errorsByCategory: logStats.errorsByCategory,
    periodDays: days,
  };
}

// ─── Formatted Output ───────────────────────────────────────────

/**
 * Format usage stats as a human-readable string for terminal display.
 */
export function formatStats(stats: UsageStats): string {
  const lines: string[] = [];

  lines.push(`KCode Usage Stats (last ${stats.periodDays} day${stats.periodDays !== 1 ? "s" : ""})`);
  lines.push("");

  // Sessions & messages
  const roleParts = Object.entries(stats.messagesByRole)
    .map(([role, count]) => `${role}: ${count}`)
    .join(", ");
  const roleSuffix = roleParts ? ` (${roleParts})` : "";

  lines.push(`Sessions:        ${stats.totalSessions}`);
  lines.push(`Messages:        ${stats.totalMessages}${roleSuffix}`);
  lines.push(`Tool executions: ${stats.totalToolUses}`);

  // Top tools
  const sortedTools = Object.entries(stats.toolUsageByName).sort((a, b) => b[1] - a[1]);
  if (sortedTools.length > 0) {
    lines.push("");
    lines.push("Top tools:");
    const maxNameLen = Math.max(...sortedTools.map(([n]) => n.length));
    for (const [name, count] of sortedTools.slice(0, 10)) {
      lines.push(`  ${name.padEnd(maxNameLen + 2)}${count}`);
    }
  }

  // Models
  const modelEntries = Object.entries(stats.requestsByModel);
  if (modelEntries.length > 0) {
    lines.push("");
    lines.push("Models:");
    for (const [model, count] of modelEntries.sort((a, b) => b[1] - a[1])) {
      const avgSuffix =
        stats.avgResponseTimeMs > 0
          ? ` (avg ${(stats.avgResponseTimeMs / 1000).toFixed(1)}s)`
          : "";
      lines.push(`  ${model}  ${count} request${count !== 1 ? "s" : ""}${avgSuffix}`);
    }
  }

  // Errors
  lines.push("");
  lines.push(`Errors: ${stats.errorCount}`);

  if (stats.errorCount > 0 && Object.keys(stats.errorsByCategory).length > 0) {
    for (const [cat, count] of Object.entries(stats.errorsByCategory).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${cat}: ${count}`);
    }
  }

  return lines.join("\n");
}
