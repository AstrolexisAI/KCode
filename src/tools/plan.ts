// KCode - Plan Tool
// Structured planning system for multi-step tasks, inspired by Claude Code's TodoWrite
// Plans are displayed visually in the TUI and persisted to SQLite

import type { ToolDefinition, ToolResult } from "../core/types";
import { getDb } from "../core/db";
import { log } from "../core/logger";

// ─── Types ──────────────────────────────────────────────────────

export type PlanStepStatus = "pending" | "in_progress" | "done" | "skipped";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
}

export interface Plan {
  id: string;
  title: string;
  steps: PlanStep[];
  createdAt: number;
  updatedAt: number;
}

// ─── In-memory active plan ──────────────────────────────────────

let _activePlan: Plan | null = null;
let _planListeners: Array<(plan: Plan | null) => void> = [];

export function getActivePlan(): Plan | null {
  return _activePlan;
}

export function onPlanChange(listener: (plan: Plan | null) => void): () => void {
  _planListeners.push(listener);
  return () => {
    _planListeners = _planListeners.filter((l) => l !== listener);
  };
}

function notifyListeners(): void {
  for (const listener of _planListeners) {
    try {
      listener(_activePlan);
    } catch {
      // ignore listener errors
    }
  }
}

// ─── Persistence ────────────────────────────────────────────────

function savePlanToDb(plan: Plan): void {
  try {
    const db = getDb();
    db.run(
      `INSERT OR REPLACE INTO plans (id, title, steps, created_at, updated_at)
       VALUES (?, ?, ?, datetime(? / 1000, 'unixepoch'), datetime(? / 1000, 'unixepoch'))`,
      [plan.id, plan.title, JSON.stringify(plan.steps), plan.createdAt, plan.updatedAt],
    );
  } catch (err) {
    log.error("plan", `Failed to save plan: ${err}`);
  }
}

export function loadLatestPlan(): Plan | null {
  try {
    const db = getDb();
    const row = db.query(
      `SELECT id, title, steps, created_at, updated_at FROM plans ORDER BY updated_at DESC LIMIT 1`,
    ).get() as { id: string; title: string; steps: string; created_at: string; updated_at: string } | null;

    if (!row) return null;

    const plan: Plan = {
      id: row.id,
      title: row.title,
      steps: JSON.parse(row.steps),
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    };

    // Only restore plans from the last 24 hours
    if (Date.now() - plan.updatedAt > 24 * 60 * 60 * 1000) return null;

    _activePlan = plan;
    return plan;
  } catch {
    return null;
  }
}

// ─── Plan Tool Definition ───────────────────────────────────────

export const planDefinition: ToolDefinition = {
  name: "Plan",
  description: `Create or update a structured plan for multi-step tasks. Use this when a task requires 3+ steps to complete.

Modes:
- "create": Create a new plan with a title and ordered steps. Replaces any existing plan.
- "update": Update the status of one or more steps (pending, in_progress, done, skipped).
- "add": Add new steps to the existing plan.
- "clear": Remove the active plan.

The plan is displayed visually to the user as a checklist with progress indicators.`,
  input_schema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["create", "update", "add", "clear"],
        description: "Operation mode",
      },
      title: {
        type: "string",
        description: "Plan title (required for 'create' mode)",
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Step ID (e.g. '1', '2a')" },
            title: { type: "string", description: "Step description" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "done", "skipped"],
              description: "Step status (default: pending for new steps)",
            },
          },
          required: ["id", "title"],
        },
        description: "Steps to create or add (for 'create' and 'add' modes)",
      },
      updates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Step ID to update" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "done", "skipped"],
              description: "New status",
            },
            title: { type: "string", description: "Updated title (optional)" },
          },
          required: ["id", "status"],
        },
        description: "Status updates (for 'update' mode)",
      },
    },
    required: ["mode"],
  },
};

// ─── Execution ──────────────────────────────────────────────────

interface PlanInput {
  mode: "create" | "update" | "add" | "clear";
  title?: string;
  steps?: Array<{ id: string; title: string; status?: PlanStepStatus }>;
  updates?: Array<{ id: string; status: PlanStepStatus; title?: string }>;
}

export async function executePlan(input: Record<string, unknown>): Promise<ToolResult> {
  const { mode, title, steps, updates } = input as unknown as PlanInput;

  switch (mode) {
    case "create": {
      if (!title) {
        return { tool_use_id: "", content: "Error: 'title' is required for create mode", is_error: true };
      }
      if (!steps || steps.length === 0) {
        return { tool_use_id: "", content: "Error: 'steps' array is required for create mode", is_error: true };
      }

      const plan: Plan = {
        id: `plan-${Date.now()}`,
        title,
        steps: steps.map((s) => ({
          id: s.id,
          title: s.title,
          status: s.status ?? "pending",
        })),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      _activePlan = plan;
      savePlanToDb(plan);
      notifyListeners();

      return {
        tool_use_id: "",
        content: `Plan created: "${title}" with ${plan.steps.length} steps\n${formatPlan(plan)}`,
      };
    }

    case "update": {
      if (!_activePlan) {
        return { tool_use_id: "", content: "Error: No active plan. Create one first with mode='create'.", is_error: true };
      }
      if (!updates || updates.length === 0) {
        return { tool_use_id: "", content: "Error: 'updates' array is required for update mode", is_error: true };
      }

      const updated: string[] = [];
      for (const u of updates) {
        const step = _activePlan.steps.find((s) => s.id === u.id);
        if (!step) {
          return { tool_use_id: "", content: `Error: Step "${u.id}" not found in plan`, is_error: true };
        }
        step.status = u.status;
        if (u.title) step.title = u.title;
        updated.push(`${u.id}: ${u.status}`);
      }

      _activePlan.updatedAt = Date.now();
      savePlanToDb(_activePlan);
      notifyListeners();

      return {
        tool_use_id: "",
        content: `Updated ${updated.length} step(s): ${updated.join(", ")}\n${formatPlan(_activePlan)}`,
      };
    }

    case "add": {
      if (!_activePlan) {
        return { tool_use_id: "", content: "Error: No active plan. Create one first with mode='create'.", is_error: true };
      }
      if (!steps || steps.length === 0) {
        return { tool_use_id: "", content: "Error: 'steps' array is required for add mode", is_error: true };
      }

      for (const s of steps) {
        if (_activePlan.steps.some((existing) => existing.id === s.id)) {
          return { tool_use_id: "", content: `Error: Step "${s.id}" already exists`, is_error: true };
        }
        _activePlan.steps.push({
          id: s.id,
          title: s.title,
          status: s.status ?? "pending",
        });
      }

      _activePlan.updatedAt = Date.now();
      savePlanToDb(_activePlan);
      notifyListeners();

      return {
        tool_use_id: "",
        content: `Added ${steps.length} step(s). Plan now has ${_activePlan.steps.length} steps.\n${formatPlan(_activePlan)}`,
      };
    }

    case "clear": {
      _activePlan = null;
      notifyListeners();
      return { tool_use_id: "", content: "Plan cleared." };
    }

    default:
      return { tool_use_id: "", content: `Error: Unknown mode "${mode}"`, is_error: true };
  }
}

// ─── Formatting ─────────────────────────────────────────────────

const STATUS_ICONS: Record<PlanStepStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  done: "[x]",
  skipped: "[-]",
};

export function formatPlan(plan: Plan): string {
  const lines: string[] = [];
  const done = plan.steps.filter((s) => s.status === "done").length;
  const total = plan.steps.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  lines.push(`${plan.title} (${done}/${total} - ${pct}%)`);
  for (const step of plan.steps) {
    lines.push(`  ${STATUS_ICONS[step.status]} ${step.id}. ${step.title}`);
  }
  return lines.join("\n");
}

/**
 * Format the active plan for injection into the system prompt.
 * Returns null if no plan is active.
 */
export function formatPlanForPrompt(): string | null {
  if (!_activePlan) return null;

  const lines: string[] = [
    "# Active Plan",
    "",
    `**${_activePlan.title}**`,
    "",
  ];

  for (const step of _activePlan.steps) {
    lines.push(`${STATUS_ICONS[step.status]} ${step.id}. ${step.title}`);
  }

  const done = _activePlan.steps.filter((s) => s.status === "done").length;
  const total = _activePlan.steps.length;

  lines.push("");
  lines.push(`Progress: ${done}/${total} complete`);
  lines.push("");
  lines.push("Update step statuses as you complete them using the Plan tool with mode='update'.");

  return lines.join("\n");
}
