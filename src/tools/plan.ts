// KCode - Plan Tool
// Structured planning system for multi-step tasks
// Plans are displayed visually in the TUI and persisted to SQLite

import { getDb } from "../core/db";
import { log } from "../core/logger";
import type { ToolDefinition, ToolResult } from "../core/types";

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
  /** If set, execution should stop after this step reaches 'done'. */
  stopAfterStepId?: string;
  /**
   * Working directory when the plan was created. Used by loadLatestPlan
   * to avoid restoring plans from unrelated sessions (e.g. a prior
   * bitcoin-tui-dashboard scaffold whose directory was subsequently
   * deleted). Issue #111 v296 repro.
   */
  workingDirectory?: string;
}

// ─── In-memory active plan ──────────────────────────────────────

let _activePlan: Plan | null = null;
let _planListeners: Array<(plan: Plan | null) => void> = [];

export function getActivePlan(): Plan | null {
  return _activePlan;
}

/** Clear the active plan (used in tests for isolation) */
export function clearActivePlan(): void {
  _activePlan = null;
}

/**
 * Clear the active plan AND remove persisted plans from the DB.
 * Used by session-tracker when the user explicitly starts a fresh
 * scaffold — any leftover plan from a prior attempt would confuse
 * the model (saw this verbatim in v296 repro).
 */
export function discardActivePlanAndPersisted(): void {
  _activePlan = null;
  try {
    const db = getDb();
    db.run(`DELETE FROM plans`);
  } catch {
    /* non-fatal */
  }
  // Notify listeners so the UI widget clears too.
  for (const listener of _planListeners) {
    try {
      listener(null);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Install a plan directly for tests. Exists so unit tests can stage a plan
 * without going through executePlan + provider wiring, and so they don't
 * need to mock.module("../tools/plan") — which in Bun 1.3.x leaves the
 * module permanently patched in the worker and breaks plan.test.ts later.
 */
export function setActivePlanForTesting(plan: Plan | null): void {
  _activePlan = plan;
}

/**
 * Check if the active plan has a step currently in_progress.
 * Returns the step if found, null otherwise.
 */
export function getActiveStep(): PlanStep | null {
  if (!_activePlan) return null;
  return _activePlan.steps.find((s) => s.status === "in_progress") ?? null;
}

/**
 * Check if there are multiple steps simultaneously in_progress (invalid state).
 * Returns the count of in_progress steps.
 */
export function countInProgressSteps(): number {
  if (!_activePlan) return 0;
  return _activePlan.steps.filter((s) => s.status === "in_progress").length;
}

/**
 * Check if the stop-after step has been completed.
 * Returns true if execution should stop now.
 */
export function shouldStopAfterCurrentStep(): boolean {
  if (!_activePlan?.stopAfterStepId) return false;
  const step = _activePlan.steps.find((s) => s.id === _activePlan!.stopAfterStepId);
  return step?.status === "done";
}

/**
 * Classify whether a tool call is coherent with the active plan step.
 * Uses simple keyword heuristics — not NLP.
 *
 * Returns: "ok" | "warn" | "block"
 * - "ok": tool call seems consistent with the active step
 * - "warn": tool call may be deviating (inject correction message)
 * - "block": tool call clearly contradicts the plan phase
 */
export function classifyToolCoherence(
  toolName: string,
  toolInput: Record<string, unknown>,
  activeStepTitle: string,
): "ok" | "warn" | "block" {
  const stepLower = activeStepTitle.toLowerCase();
  const filePath = String(toolInput.file_path ?? toolInput.path ?? "").toLowerCase();
  const command = String(toolInput.command ?? "").toLowerCase();

  // Setup/init phase: allow scaffold, config, install
  if (
    /\b(setup|init|initialize|install|config|structure|scaffold|dependencies)\b/.test(stepLower)
  ) {
    if (toolName === "Bash" && /\b(create|init|install|npm|bun|npx|mkdir|git init)\b/.test(command))
      return "ok";
    if (toolName === "Write" && /\.(json|config|ts|js|css|md)$/i.test(filePath)) return "ok";
    // Writing full page components during setup is a deviation
    if (
      toolName === "Write" &&
      /\/(pages?|app)\/.+\.(tsx|jsx)$/i.test(filePath) &&
      !/layout|root|config/i.test(filePath)
    )
      return "warn";
    return "ok";
  }

  // Build/create page phase: allow page/component writes
  if (
    /\b(build|create|implement|add|design)\s+.*(page|component|landing|home|hero|chart|footer|header|nav)\b/.test(
      stepLower,
    )
  ) {
    if (toolName === "Write" || toolName === "Edit") return "ok";
    if (toolName === "Bash" && /\b(npm|bun|npx)\b/.test(command)) return "ok";
    return "ok";
  }

  // Test/verify phase: allow read/bash, warn on writes
  if (/\b(test|verify|check|validate|review)\b/.test(stepLower)) {
    if (toolName === "Bash" || toolName === "Read" || toolName === "Glob" || toolName === "Grep")
      return "ok";
    if (toolName === "Write" || toolName === "Edit") return "warn";
    return "ok";
  }

  // Docs/readme phase: allow doc writes, warn on code writes
  if (/\b(doc|readme|documentation|changelog)\b/.test(stepLower)) {
    if (toolName === "Write" && /\.(md|txt|rst)$/i.test(filePath)) return "ok";
    if (toolName === "Write" && /\.(tsx?|jsx?|css|html)$/i.test(filePath)) return "warn";
    return "ok";
  }

  // Git/commit phase: block new feature creation
  if (/\b(git|commit|push|version|tag|release|polish|finalize)\b/.test(stepLower)) {
    if (toolName === "Bash" && /\bgit\b/.test(command)) return "ok";
    if (toolName === "Write" || toolName === "Edit") return "block";
    return "ok";
  }

  // Default: allow (can't classify all phases)
  return "ok";
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

/**
 * Overlay scope-derived completion onto the active plan. The model
 * frequently calls Plan tool once with mode=create and then never
 * calls update, so the UI widget shows 0/N while the scope's
 * verification state shows N-1/N. This helper matches each step's
 * title against the same keyword signals the closeout renderer uses
 * (create/install/write/verify) and flips pending steps to "done"
 * when their verification signal is present.
 *
 * Issue #111 v274 repro: "Plan progress: 4/4 step(s) completed"
 * in the grounded closeout alongside "0/4" in the UI widget.
 *
 * Pure data side-effect: mutates _activePlan in-place and fires
 * listeners so the UI re-renders. Returns the number of steps
 * whose status was flipped. Tests can force a scope manager
 * instance via the optional `scopeGetter` parameter.
 */
export function reconcilePlanFromScope(
  scopeGetter?: () => {
    projectRoot: { status: string };
    verification: {
      filesWritten: string[];
      filesEdited: string[];
      runtimeCommands: Array<{
        runtimeFailed: boolean;
        status?: string;
        exitCode: number | null;
      }>;
    };
  } | null,
): number {
  if (!_activePlan) return 0;

  let getScope = scopeGetter;
  if (!getScope) {
    try {
      const { getTaskScopeManager } =
        require("../core/task-scope") as typeof import("../core/task-scope");
      const mgr = getTaskScopeManager();
      getScope = () => mgr.current();
    } catch {
      return 0;
    }
  }

  const scope = getScope();
  if (!scope) return 0;

  const v = scope.verification;
  const last = v.runtimeCommands[v.runtimeCommands.length - 1];
  const depsFilesTouched = [...v.filesWritten, ...v.filesEdited].some((p) =>
    /(?:requirements\.txt|pyproject\.toml|package\.json|Cargo\.toml|go\.mod|Gemfile)$/i.test(p),
  );
  const anyFileWritten = v.filesWritten.length + v.filesEdited.length > 0;
  const anyRuntimeHappened = v.runtimeCommands.length > 0;
  const depsInstalled =
    ((v as { packageManagerOps?: string[] }).packageManagerOps ?? []).length > 0;
  const allPaths = [...v.filesWritten, ...v.filesEdited];
  const hasTransactionsFile = allPaths.some((p) =>
    /(?:transactions?|tx|mempool)[./\\]|(?:transactions?|tx|mempool)\.\w+$/i.test(p),
  );
  const hasRefreshCode = allPaths.some((p) =>
    /(?:index|main|app|dashboard|server)\.(?:ts|tsx|js|jsx|py|mjs)$/i.test(p),
  );
  const lastRuntimeVerified =
    !!last && !last.runtimeFailed && (last.status === undefined || last.status === "verified");

  let flipped = 0;
  for (const step of _activePlan.steps) {
    if (step.status !== "pending" && step.status !== "in_progress") continue;
    const t = step.title.toLowerCase();
    let derived: PlanStepStatus | null = null;

    if (/(create|cre[aá]r|init|setup|scaffold|project|directory|carpeta|proyecto)/i.test(t)) {
      if (scope.projectRoot.status === "verified" || scope.projectRoot.status === "created") {
        derived = "done";
      }
    } else if (/(install|instal[aá]r?|depend|requirement|dependenc|paquet|librer)/i.test(t)) {
      if (depsInstalled || depsFilesTouched || anyRuntimeHappened) {
        derived = "done";
      }
    } else if (/(transacc|transaction|mempool)/i.test(t)) {
      if (hasTransactionsFile) {
        derived = "done";
      }
    } else if (
      /(live|refresh|actualiz|vivo|tiempo.?real|real.?time|auto.?refresh|setInterval)/i.test(t)
    ) {
      if (hasRefreshCode) {
        derived = "done";
      }
    } else if (
      /(write|escribi|code|c[oó]digo|main|app|script|application|aplicaci|implement|implementar|rpc|client|cliente)/i.test(
        t,
      )
    ) {
      if (anyFileWritten) {
        derived = "done";
      }
    } else if (
      /(test|verify|verific|run|ejecut|check|revis|connect|conect|probar|prueba)/i.test(t)
    ) {
      if (lastRuntimeVerified) {
        derived = "done";
      } else if (last) {
        // Runtime ran but didn't verify — signal progress without
        // marking done. The UI will show [~] instead of [x].
        derived = "in_progress";
      }
    }

    if (derived && derived !== step.status) {
      step.status = derived;
      flipped++;
    }
  }

  if (flipped > 0) {
    _activePlan.updatedAt = Date.now();
    notifyListeners();
  }
  return flipped;
}

// ─── Persistence ────────────────────────────────────────────────

function savePlanToDb(plan: Plan): void {
  try {
    const db = getDb();
    // Ensure optional workingDirectory column exists (ALTER TABLE idempotent).
    try {
      db.run(`ALTER TABLE plans ADD COLUMN working_directory TEXT`);
    } catch {
      /* column already exists — SQLite raises if so */
    }
    const cwd = plan.workingDirectory ?? process.cwd();
    db.run(
      `INSERT OR REPLACE INTO plans (id, title, steps, created_at, updated_at, working_directory)
       VALUES (?, ?, ?, datetime(? / 1000, 'unixepoch'), datetime(? / 1000, 'unixepoch'), ?)`,
      [plan.id, plan.title, JSON.stringify(plan.steps), plan.createdAt, plan.updatedAt, cwd],
    );
  } catch (err) {
    log.error("plan", `Failed to save plan: ${err}`);
  }
}

export function loadLatestPlan(): Plan | null {
  try {
    const db = getDb();
    // Attempt to include working_directory if the column exists;
    // older DBs without the column fall back to the legacy query.
    let row: {
      id: string;
      title: string;
      steps: string;
      created_at: string;
      updated_at: string;
      working_directory?: string;
    } | null;
    try {
      row = db
        .query(
          `SELECT id, title, steps, created_at, updated_at, working_directory
             FROM plans
            ORDER BY updated_at DESC LIMIT 1`,
        )
        .get() as typeof row;
    } catch {
      row = db
        .query(
          `SELECT id, title, steps, created_at, updated_at FROM plans ORDER BY updated_at DESC LIMIT 1`,
        )
        .get() as typeof row;
    }

    if (!row) return null;

    const plan: Plan = {
      id: row.id,
      title: row.title,
      steps: JSON.parse(row.steps),
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
      workingDirectory: row.working_directory,
    };

    // Only restore plans from the last 24 hours.
    if (Date.now() - plan.updatedAt > 24 * 60 * 60 * 1000) return null;

    // Only restore if the plan was created in the CURRENT working
    // directory. A plan that referenced a project in a different cwd
    // (or whose cwd no longer exists) would inject confusing state
    // into the new session. Issue #111 v296 repro: a stale
    // bitcoin-tui-dashboard plan was restored after the project dir
    // was deleted; the model saw '7/9 done' and asked the user to
    // re-create the directory instead of doing it itself.
    if (plan.workingDirectory && plan.workingDirectory !== process.cwd()) {
      return null;
    }

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
        return {
          tool_use_id: "",
          content: "Error: 'title' is required for create mode",
          is_error: true,
        };
      }
      if (!steps || steps.length === 0) {
        return {
          tool_use_id: "",
          content: "Error: 'steps' array is required for create mode",
          is_error: true,
        };
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

      // Phase 6: mirror plan into TaskScope.progress so the closeout
      // renderer has the same source of truth and the plan survives
      // even if _activePlan gets reset (issue #107: plan showed 0/4
      // despite successful writes in the same turn).
      try {
        const { getTaskScopeManager } =
          require("../core/task-scope") as typeof import("../core/task-scope");
        const mgr = getTaskScopeManager();
        if (mgr.current()) {
          mgr.update({
            progress: {
              plannedSteps: plan.steps.map((s) => s.title),
              currentStep: plan.steps.find((s) => s.status === "in_progress")?.title,
            },
          });
        }
      } catch {
        /* scope unavailable — legacy path */
      }

      return {
        tool_use_id: "",
        content: `Plan created: "${title}" with ${plan.steps.length} steps\n${formatPlan(plan)}`,
      };
    }

    case "update": {
      if (!_activePlan) {
        return {
          tool_use_id: "",
          content: "Error: No active plan. Create one first with mode='create'.",
          is_error: true,
        };
      }
      if (!updates || updates.length === 0) {
        return {
          tool_use_id: "",
          content: "Error: 'updates' array is required for update mode",
          is_error: true,
        };
      }

      const updated: string[] = [];
      for (const u of updates) {
        const step = _activePlan.steps.find((s) => s.id === u.id);
        if (!step) {
          return {
            tool_use_id: "",
            content: `Error: Step "${u.id}" not found in plan`,
            is_error: true,
          };
        }
        step.status = u.status;
        if (u.title) step.title = u.title;
        updated.push(`${u.id}: ${u.status}`);
      }

      _activePlan.updatedAt = Date.now();
      savePlanToDb(_activePlan);
      notifyListeners();

      // Phase 6: keep scope.progress in sync on updates too.
      try {
        const { getTaskScopeManager } =
          require("../core/task-scope") as typeof import("../core/task-scope");
        const mgr = getTaskScopeManager();
        if (mgr.current()) {
          const completedSteps = _activePlan.steps
            .filter((s) => s.status === "done")
            .map((s) => s.title);
          const currentStep = _activePlan.steps.find((s) => s.status === "in_progress")?.title;
          mgr.update({
            progress: { completedSteps, currentStep },
          });
        }
      } catch {
        /* scope unavailable */
      }

      return {
        tool_use_id: "",
        content: `Updated ${updated.length} step(s): ${updated.join(", ")}\n${formatPlan(_activePlan)}`,
      };
    }

    case "add": {
      if (!_activePlan) {
        return {
          tool_use_id: "",
          content: "Error: No active plan. Create one first with mode='create'.",
          is_error: true,
        };
      }
      if (!steps || steps.length === 0) {
        return {
          tool_use_id: "",
          content: "Error: 'steps' array is required for add mode",
          is_error: true,
        };
      }

      for (const s of steps) {
        if (_activePlan.steps.some((existing) => existing.id === s.id)) {
          return {
            tool_use_id: "",
            content: `Error: Step "${s.id}" already exists`,
            is_error: true,
          };
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

  const lines: string[] = ["# Active Plan", "", `**${_activePlan.title}**`, ""];

  for (const step of _activePlan.steps) {
    lines.push(`${STATUS_ICONS[step.status]} ${step.id}. ${step.title}`);
  }

  const done = _activePlan.steps.filter((s) => s.status === "done").length;
  const total = _activePlan.steps.length;

  lines.push("");
  lines.push(`Progress: ${done}/${total} complete`);
  lines.push("");
  lines.push("MANDATORY plan hygiene (do NOT ignore — this is a hard rule):");
  lines.push("  1. As soon as you finish a step, mark it done with the Plan tool:");
  lines.push(`        Plan(mode="update", step_id="N", status="done")`);
  lines.push("  2. You MUST NOT declare the overall task complete (with text like");
  lines.push('     "Task completed", "Delivered", "Summary of changes", etc.) while');
  lines.push("     ANY step is still pending or in_progress. Before writing that");
  lines.push("     text, either mark the remaining steps done OR explain precisely");
  lines.push("     which steps are NOT done and why.");
  lines.push("  3. If you realized mid-task that a step is no longer needed, mark");
  lines.push(`        Plan(mode="update", step_id="N", status="skipped") `);
  lines.push("     with a reason — do not leave it pending.");
  lines.push("  4. If the plan is fully done, the Plan tool will automatically clear");
  lines.push('     it on your next Plan(mode="update") call — you do not need to');
  lines.push("     delete it manually.");

  return lines.join("\n");
}

/**
 * Post-turn reconciliation check (operator-mind phase 12).
 *
 * Called at end-of-turn to detect the "model declared task complete
 * but left plan steps unchecked" failure mode. Returns a system
 * reminder string to inject into the next turn, or null if the plan
 * state is coherent with the assistant text.
 *
 * Heuristic: if there is an active plan with ≥1 step NOT in status
 * "done"/"skipped", AND the assistant's last text message contains
 * one of the completion phrases below, the plan is abandoned.
 *
 * The reminder is injected AS the next user turn so the model is
 * forced to address it before doing anything else.
 */
const COMPLETION_PHRASES = [
  /\btask completed?\b/i,
  /\btask complete\b/i,
  /\btarea completad[ao]\b/i,
  /\btodo listo\b/i,
  /\bdelivered\b/i,
  /\bsuccessfully (?:created|delivered|implemented|customized|refactored|completed)\b/i,
  /\bsummary of changes\b/i,
  /\bwhat was (?:done|built|created|added)\b/i,
  /\bthe (?:project|file|page|site|site is|implementation is) (?:is )?(?:ready|done|complete|live)\b/i,
];

export function detectAbandonedPlan(assistantText: string): {
  abandoned: boolean;
  pendingSteps: PlanStep[];
  completionPhrase?: string;
} {
  if (!_activePlan) return { abandoned: false, pendingSteps: [] };
  const pending = _activePlan.steps.filter((s) => s.status !== "done" && s.status !== "skipped");
  if (pending.length === 0) return { abandoned: false, pendingSteps: [] };
  if (!assistantText) return { abandoned: false, pendingSteps: pending };

  let matchedPhrase: string | undefined;
  for (const re of COMPLETION_PHRASES) {
    const m = assistantText.match(re);
    if (m) {
      matchedPhrase = m[0];
      break;
    }
  }
  if (!matchedPhrase) return { abandoned: false, pendingSteps: pending };

  return { abandoned: true, pendingSteps: pending, completionPhrase: matchedPhrase };
}

/**
 * Build the reconciliation reminder that gets injected as the next
 * user message when detectAbandonedPlan returns abandoned=true.
 */
export function buildPlanReconciliationReminder(
  pendingSteps: PlanStep[],
  completionPhrase: string,
): string {
  const lines: string[] = [];
  lines.push(`[PLAN RECONCILIATION]`);
  lines.push(``);
  lines.push(`Your previous turn contained "${completionPhrase}" — that reads as a`);
  lines.push(`task-complete declaration. But the active plan still has ${pendingSteps.length}`);
  lines.push(`step(s) NOT marked done or skipped:`);
  lines.push(``);
  for (const step of pendingSteps) {
    lines.push(`  [${step.status}] ${step.id}. ${step.title}`);
  }
  lines.push(``);
  lines.push(`Before doing anything else, you MUST do ONE of:`);
  lines.push(
    `  a) Mark each finished step done with Plan(mode="update", step_id="N", status="done").`,
  );
  lines.push(`  b) Mark each no-longer-needed step skipped with the same Plan call.`);
  lines.push(`  c) Explain precisely which steps are actually NOT done yet and why.`);
  lines.push(``);
  lines.push(`This message is NOT a failure — KCode is asking you to reconcile the`);
  lines.push(`plan state with what you just claimed. Your next response must either`);
  lines.push(`call the Plan tool or clarify the pending steps in text.`);
  return lines.join("\n");
}
