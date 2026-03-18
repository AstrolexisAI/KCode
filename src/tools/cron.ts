// KCode - Cron Tools
// Create, list, and delete scheduled tasks (cron jobs)
// Uses system crontab for persistence

import { execSync } from "node:child_process";
import type { ToolDefinition, ToolResult } from "../core/types";

// ─── CronList ──────────────────────────────────────────────────

export const cronListDefinition: ToolDefinition = {
  name: "CronList",
  description: "List all cron jobs for the current user. Shows scheduled tasks with their schedule, command, and ID.",
  input_schema: {
    type: "object",
    properties: {},
  },
};

export async function executeCronList(_input: Record<string, unknown>): Promise<ToolResult> {
  try {
    let crontab = "";
    try {
      crontab = execSync("crontab -l 2>/dev/null", { timeout: 5000 }).toString();
    } catch {
      return { tool_use_id: "", content: "No crontab for current user (empty)." };
    }

    if (!crontab.trim()) {
      return { tool_use_id: "", content: "No cron jobs configured." };
    }

    const lines = crontab.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    const jobs: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Parse: min hour dom mon dow command
      const match = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
      if (match) {
        const kcodeId = extractKcodeId(line);
        const id = kcodeId ?? `cron-${i}`;
        jobs.push(`[${id}] ${match[1]}  ${match[2]}`);
      }
    }

    if (jobs.length === 0) {
      return { tool_use_id: "", content: "No active cron jobs found." };
    }

    return {
      tool_use_id: "",
      content: `Cron jobs (${jobs.length}):\n\n${jobs.join("\n")}`,
    };
  } catch (err) {
    return {
      tool_use_id: "",
      content: `Error listing cron jobs: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
    };
  }
}

// ─── CronCreate ────────────────────────────────────────────────

export const cronCreateDefinition: ToolDefinition = {
  name: "CronCreate",
  description:
    "Create a new cron job. Specify a schedule (cron expression) and command. " +
    "Example schedules: '*/5 * * * *' (every 5 min), '0 9 * * 1-5' (9am weekdays), '0 0 * * *' (midnight daily).",
  input_schema: {
    type: "object",
    properties: {
      schedule: {
        type: "string",
        description: "Cron schedule expression (e.g., '*/5 * * * *' for every 5 minutes)",
      },
      command: {
        type: "string",
        description: "The command to execute on schedule",
      },
      id: {
        type: "string",
        description: "Optional unique ID for this job (for later deletion). Auto-generated if not provided.",
      },
    },
    required: ["schedule", "command"],
  },
};

export async function executeCronCreate(input: Record<string, unknown>): Promise<ToolResult> {
  const schedule = String(input.schedule ?? "").trim();
  const command = String(input.command ?? "").trim();
  const rawId = String(input.id ?? "").trim() || `kcode-${Date.now().toString(36)}`;
  // Sanitize id: alphanumeric, hyphens, underscores only
  const id = rawId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);

  if (!schedule) {
    return { tool_use_id: "", content: "Error: schedule is required.", is_error: true };
  }
  if (!command) {
    return { tool_use_id: "", content: "Error: command is required.", is_error: true };
  }

  // Reject newlines in schedule or command (would corrupt crontab)
  if (/[\n\r]/.test(schedule) || /[\n\r]/.test(command)) {
    return { tool_use_id: "", content: "Error: schedule and command must not contain newlines.", is_error: true };
  }

  // Validate cron schedule format (5 fields)
  const fields = schedule.split(/\s+/);
  if (fields.length !== 5) {
    return {
      tool_use_id: "",
      content: `Error: Invalid cron schedule "${schedule}". Must have exactly 5 fields: minute hour day month weekday.`,
      is_error: true,
    };
  }

  // Validate each field
  const fieldPatterns = /^(\*|(\d+(-\d+)?(\/\d+)?)(,(\d+(-\d+)?(\/\d+)?))*)$/;
  for (const field of fields) {
    if (field !== "*" && !fieldPatterns.test(field) && !/^\*\/\d+$/.test(field)) {
      return {
        tool_use_id: "",
        content: `Error: Invalid cron field "${field}" in schedule "${schedule}".`,
        is_error: true,
      };
    }
  }

  // Sanitize command — reject shell metacharacters that could be dangerous
  if (/[`$;|><()]/.test(command) || /&&/.test(command) || /\|\|/.test(command)) {
    return {
      tool_use_id: "",
      content: "Error: Command contains potentially dangerous characters (`, $, ;, |, &&, ||, >, <, (, )). Use a script file instead.",
      is_error: true,
    };
  }

  try {
    // Get existing crontab
    let existing = "";
    try {
      existing = execSync("crontab -l 2>/dev/null", { timeout: 5000 }).toString();
    } catch {
      // No existing crontab
    }

    // Check for duplicate ID
    if (existing.includes(`#kcode:${id}`)) {
      return {
        tool_use_id: "",
        content: `Error: A cron job with ID "${id}" already exists. Delete it first or use a different ID.`,
        is_error: true,
      };
    }

    // Append new job with KCode ID tag
    const newLine = `${schedule} ${command} #kcode:${id}`;
    const newCrontab = existing.trimEnd() + "\n" + newLine + "\n";

    // Write new crontab via stdin
    execSync("crontab -", {
      input: newCrontab,
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return {
      tool_use_id: "",
      content: `Cron job created:\n  ID: ${id}\n  Schedule: ${schedule}\n  Command: ${command}`,
    };
  } catch (err) {
    return {
      tool_use_id: "",
      content: `Error creating cron job: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
    };
  }
}

// ─── CronDelete ────────────────────────────────────────────────

export const cronDeleteDefinition: ToolDefinition = {
  name: "CronDelete",
  description: "Delete a cron job by its ID (the #kcode:ID tag) or by line number.",
  input_schema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The ID of the cron job to delete (from the #kcode:ID tag)",
      },
    },
    required: ["id"],
  },
};

export async function executeCronDelete(input: Record<string, unknown>): Promise<ToolResult> {
  const id = String(input.id ?? "").trim();

  if (!id) {
    return { tool_use_id: "", content: "Error: id is required.", is_error: true };
  }

  try {
    let crontab = "";
    try {
      crontab = execSync("crontab -l 2>/dev/null", { timeout: 5000 }).toString();
    } catch {
      return { tool_use_id: "", content: "Error: No crontab exists.", is_error: true };
    }

    const lines = crontab.split("\n");
    // Match exact ID (followed by end-of-line or whitespace, not a substring)
    const idPattern = new RegExp(`#kcode:${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`);
    const filtered = lines.filter((line) => !idPattern.test(line));

    if (filtered.length === lines.length) {
      return {
        tool_use_id: "",
        content: `Error: No cron job found with ID "${id}".`,
        is_error: true,
      };
    }

    const newCrontab = filtered.join("\n") + "\n";
    execSync("crontab -", {
      input: newCrontab,
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return {
      tool_use_id: "",
      content: `Cron job "${id}" deleted.`,
    };
  } catch (err) {
    return {
      tool_use_id: "",
      content: `Error deleting cron job: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
    };
  }
}

// ─── Helpers ───────────────────────────────────────────────────

function extractKcodeId(line: string): string | null {
  const match = line.match(/#kcode:(\S+)/);
  return match ? match[1] : null;
}
