// KCode - Plan Mode Tools
// EnterPlanMode restricts the LLM to read-only operations + planning
// ExitPlanMode returns to normal mode

import type { ToolDefinition, ToolResult } from "../core/types";

// ─── Plan Mode State ───────────────────────────────────────────

let _planModeActive = false;
let _planModeReason = "";

export function isPlanModeActive(): boolean {
  return _planModeActive;
}

export function getPlanModeReason(): string {
  return _planModeReason;
}

// ─── Read-only tool whitelist when in plan mode ────────────────

export const PLAN_MODE_ALLOWED_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "Plan",
  "TaskCreate",
  "TaskList",
  "TaskGet",
  "TaskUpdate",
  "Learn",
  // Agent intentionally excluded — subagents don't inherit plan mode,
  // so allowing Agent would let the LLM bypass read-only restrictions.
  "Skill",
  "ListMcpResources",
  "ReadMcpResource",
  "CronList",
  "DiffView",
  "Clipboard",
  "GitStatus",
  "GitLog",
  "Stash",
  "LSP",
  "ToolSearch",
  "AskUser",
  "ExitPlanMode",
]);

// ─── EnterPlanMode ─────────────────────────────────────────────

export const enterPlanModeDefinition: ToolDefinition = {
  name: "EnterPlanMode",
  description:
    "Enter plan mode. In plan mode, only read-only tools (Read, Glob, Grep, LS, WebFetch, WebSearch) " +
    "and planning tools (Plan, TaskCreate, TaskUpdate) are available. " +
    "Write operations (Bash, Write, Edit, MultiEdit) are blocked. " +
    "Use this to research and plan before making changes. Call ExitPlanMode to return to normal mode.",
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "Why you are entering plan mode (e.g., 'researching architecture before refactor')",
      },
    },
  },
};

export async function executeEnterPlanMode(input: Record<string, unknown>): Promise<ToolResult> {
  if (_planModeActive) {
    return {
      tool_use_id: "",
      content: "Already in plan mode. Use ExitPlanMode to return to normal mode.",
    };
  }

  _planModeActive = true;
  _planModeReason = String(input.reason ?? "planning").trim();

  const allowedList = Array.from(PLAN_MODE_ALLOWED_TOOLS).join(", ");

  return {
    tool_use_id: "",
    content: [
      `Plan mode activated: ${_planModeReason}`,
      "",
      "Restrictions:",
      "  - Write operations are BLOCKED (Bash, Write, Edit, MultiEdit, NotebookEdit)",
      "  - Only read-only and planning tools are available",
      "",
      `Allowed tools: ${allowedList}`,
      "",
      "Use ExitPlanMode when ready to implement.",
    ].join("\n"),
  };
}

// ─── ExitPlanMode ──────────────────────────────────────────────

export const exitPlanModeDefinition: ToolDefinition = {
  name: "ExitPlanMode",
  description:
    "Exit plan mode and return to normal mode where all tools are available. " +
    "Call this after you have finished planning and are ready to implement.",
  input_schema: {
    type: "object",
    properties: {},
  },
};

export async function executeExitPlanMode(_input: Record<string, unknown>): Promise<ToolResult> {
  if (!_planModeActive) {
    return {
      tool_use_id: "",
      content: "Not in plan mode. All tools are already available.",
    };
  }

  const reason = _planModeReason;
  _planModeActive = false;
  _planModeReason = "";

  return {
    tool_use_id: "",
    content: `Plan mode exited. All tools are now available.\nPlan mode was active for: ${reason}`,
  };
}
