// KCode - KillShell tool
//
// Terminates a background bash launched via the Bash tool with
// run_in_background: true. Useful for stopping long scans, killing
// dev servers the model spawned, or canceling parallel work that's
// no longer needed.

import { isShellAlive, killShell, getShell, purgeShell } from "../core/bg-shell-registry";
import type { ToolDefinition, ToolResult } from "../core/types";

export const killShellDefinition: ToolDefinition = {
  name: "KillShell",
  description:
    "Terminate a background shell launched with Bash run_in_background. " +
    "Sends SIGTERM by default; pass force=true to send SIGKILL. " +
    "Also accepts purge=true to delete the log file after termination.",
  input_schema: {
    type: "object",
    properties: {
      shellId: {
        type: "string",
        description: "The shellId returned by Bash run_in_background.",
      },
      force: {
        type: "boolean",
        description: "Use SIGKILL instead of SIGTERM. Default false.",
      },
      purge: {
        type: "boolean",
        description: "After killing, delete the log file + remove from registry. Default false.",
      },
    },
    required: ["shellId"],
  },
};

export async function executeKillShell(input: Record<string, unknown>): Promise<ToolResult> {
  const shellId = typeof input.shellId === "string" ? input.shellId : "";
  const force = input.force === true;
  const purge = input.purge === true;

  if (!shellId) {
    return {
      tool_use_id: "",
      content: "shellId is required.",
      is_error: true,
    };
  }

  const record = getShell(shellId);
  if (!record) {
    return {
      tool_use_id: "",
      content: `Unknown shellId: ${shellId}`,
      is_error: true,
    };
  }

  const wasAlive = isShellAlive(record);
  // Capture log path BEFORE killShell garbage-collects an already-dead
  // entry — otherwise purge=true can't find the file to delete.
  const logPathSnapshot = record.logPath;
  const result = killShell(shellId, force);

  if (!result.killed) {
    return {
      tool_use_id: "",
      content: `Failed to kill shell ${shellId}: ${result.reason}`,
      is_error: true,
    };
  }

  let msg: string;
  if (result.reason === "already-exited") {
    msg = `Shell ${shellId} had already exited; removed from registry.`;
  } else {
    const sig = force ? "SIGKILL" : "SIGTERM";
    msg = `Shell ${shellId} (pid ${record.pid}) sent ${sig}.`;
    if (wasAlive && !force) {
      msg += " (use force=true if it doesn't exit)";
    }
  }

  if (purge) {
    // Try the registry-based purge first (cleans up if entry still
    // present), then fall back to deleting the log directly via the
    // snapshot path (handles the already-exited GC case).
    purgeShell(shellId);
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      if (fs.existsSync(logPathSnapshot)) fs.unlinkSync(logPathSnapshot);
    } catch {
      /* ignore — log already gone */
    }
    msg += " Log file deleted and registry entry removed.";
  }

  return { tool_use_id: "", content: msg };
}
