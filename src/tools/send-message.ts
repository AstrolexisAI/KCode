// KCode - SendMessage Tool
// Lets the agent send a status message to the user without expecting a response
//
// Phase 13 (#111 v278): SendMessage became a bypass for the
// freeform-suppression / closeout-replace pipeline. Issue v277 repro:
// the model called SendMessage("Start: ... / Stop: ... / Health: ...")
// AFTER a SyntaxError + patch, without any rerun, and the operational
// instructions rendered as primary UI text. The grounded closeout
// never got a chance to replace it because SendMessage output goes
// through the tool-result path, not the assistant text path.
//
// Gate: when the current scope cannot claim ready (phase=failed/
// partial/blocked, or mayClaimReady=false, or patchAppliedAfterFailure
// without a successful rerun), SendMessage DROPS the operational
// guidance and returns a short banner pointing at the closeout
// instead.

import type { ToolDefinition, ToolResult } from "../core/types";

export const sendMessageDefinition: ToolDefinition = {
  name: "SendMessage",
  description:
    "Send a status message to the user without waiting for a response. " +
    "Use this for progress updates, warnings, or informational messages " +
    "when you don't need user input. For questions requiring a response, use AskUser instead.",
  input_schema: {
    type: "object" as const,
    properties: {
      message: {
        type: "string",
        description: "The message to display to the user",
      },
      level: {
        type: "string",
        enum: ["info", "warning", "error"],
        description: "Message severity level (default: info)",
      },
    },
    required: ["message"],
  },
};

/**
 * Return true when the message reads like operational guidance
 * ("start: cmd", "health: ...", "ready to run", "proyecto creado y
 * listo", "press Ctrl+C", "F1 for blocks"). Narrow enough that
 * plain status updates ("Analyzing files...", "Waiting for build")
 * still pass through.
 */
function looksLikeOperationalGuidance(text: string): boolean {
  const lo = text.toLowerCase();
  const patterns: RegExp[] = [
    /\bstart\s*[:=]/i,
    /\bstop\s*[:=]/i,
    /\bhealth\s*[:=]/i,
    /\brun\s*[:=]\s*[`\\/]?(?:cd\s+|bun\s+|npm\s+|python|node)/i,
    /\bready\s+to\s+run\b/i,
    /\bproyecto\s+creado\s+y?\s+listo\b/i,
    /\bcreated\s+and\s+ready\b/i,
    /\blist[ao]\s+para\s+(?:ejecutar|correr|usar)\b/i,
    /\bpresiona\s+(?:ctrl|f\d|esc)/i,
    /\bpress\s+(?:ctrl|f\d|esc|q\b)/i,
    /\bf1\b.*\bf2\b/i, // multiple keybinding mention
    /ps\s+aux\s+\|\s+grep/i, // fake health check
    /pkill\s+-f/i,
    /\bkill\s+\$?\d+/i, // "kill 3292891" suggestion
  ];
  if (patterns.some((p) => p.test(text))) return true;
  // Multi-line messages that list multiple of: url / port / command /
  // instructions — strong guidance signal.
  const hits =
    (/\bhttp:\/\/localhost/i.test(lo) ? 1 : 0) +
    (/\bbun\s+run\b|\bnpm\s+run\b|\bpython\s+\w+\.py\b/.test(lo) ? 1 : 0) +
    (/ctrl\+c|ctrl-c/i.test(lo) ? 1 : 0) +
    (/\bkill\s+(?:pid\s*)?\d+/i.test(lo) ? 1 : 0);
  return hits >= 2;
}

export async function executeSendMessage(input: Record<string, unknown>): Promise<ToolResult> {
  const message = String(input.message ?? "");
  const level = (input.level as string) ?? "info";

  if (!message.trim()) {
    return {
      tool_use_id: "",
      content: "Error: message is required",
      is_error: true,
    };
  }

  // Grounding gate: operational guidance is only safe when the task
  // is verified. When the scope says failed/partial/blocked or a
  // patch is pending rerun, the model should NOT be shipping
  // "Start / Stop / Health / run it like this" text.
  try {
    const { getTaskScopeManager } =
      require("../core/task-scope") as typeof import("../core/task-scope");
    const scope = getTaskScopeManager().current();
    if (scope && looksLikeOperationalGuidance(message)) {
      const blocked =
        scope.phase === "failed" ||
        scope.phase === "blocked" ||
        scope.phase === "partial" ||
        !scope.completion.mayClaimReady ||
        (scope.verification.patchAppliedAfterFailure && !scope.verification.rerunPassedAfterPatch);
      if (blocked) {
        // Reason precedence: most-actionable first. "Re-run first"
        // beats "task isn't ready" — the model can actually ACT on
        // the rerun instruction.
        const reason =
          scope.verification.patchAppliedAfterFailure && !scope.verification.rerunPassedAfterPatch
            ? "a patch was applied after a runtime failure and the validation has not been re-run"
            : scope.phase === "blocked"
              ? `the task is blocked (phase=blocked)`
              : scope.phase === "failed"
                ? `the task is in phase "failed"`
                : scope.phase === "partial"
                  ? `the task is in phase "partial"`
                  : "the task is not marked ready";
        return {
          tool_use_id: "",
          content:
            `BLOCKED — SendMessage refused operational guidance: ${reason}. ` +
            `Do NOT paste run instructions, keybindings, health checks, or "ready" ` +
            `language until the scope reflects a verified runtime. ` +
            `Run the validation command first; the closeout renderer will announce the ` +
            `real state.`,
          is_error: true,
        };
      }
    }
  } catch {
    /* scope unavailable — fall through to legacy path */
  }

  const prefixes: Record<string, string> = {
    info: "[INFO]",
    warning: "[WARNING]",
    error: "[ERROR]",
  };

  const prefix = prefixes[level] ?? prefixes.info;

  // The message is returned as tool output and will be displayed in the UI
  return {
    tool_use_id: "",
    content: `${prefix} ${message}`,
  };
}
