// KCode - BashOutput tool
//
// Reads the accumulated output of a background bash launched via the
// Bash tool with run_in_background: true. Returns the current state
// of the shell (running / exited) plus the log contents (full or
// tail-windowed).
//
// Without this, the model could spawn parallel work but had no way to
// inspect progress — it would have to remember the PID and shell out
// to `cat /tmp/...` (which used to be deleted after 3 seconds anyway).

import {
  getShell,
  isShellAlive,
  listShells,
  readShellOutput,
} from "../core/bg-shell-registry";
import type { ToolDefinition, ToolResult } from "../core/types";

export const bashOutputDefinition: ToolDefinition = {
  name: "BashOutput",
  description:
    "Read the current output of a background bash shell launched with run_in_background. " +
    "Returns whether the shell is still running and the accumulated stdout/stderr. " +
    "Use this to monitor parallel commands: spawn 3 scans in background, then poll each " +
    "via BashOutput as you make other decisions. Pass no shellId to list all known shells.",
  input_schema: {
    type: "object",
    properties: {
      shellId: {
        type: "string",
        description:
          "The shellId returned by Bash run_in_background (e.g. 'a3f9b21c'). " +
          "If omitted, returns a list of all registered shells.",
      },
      tailBytes: {
        type: "number",
        description:
          "If set, only return the last N bytes of the log (use for huge outputs). " +
          "Defaults to full content.",
      },
    },
  },
};

export async function executeBashOutput(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const shellId = typeof input.shellId === "string" ? input.shellId : undefined;
  const tailBytes = typeof input.tailBytes === "number" ? input.tailBytes : undefined;

  // No shellId → list all
  if (!shellId) {
    const shells = listShells();
    if (shells.length === 0) {
      return { tool_use_id: "", content: "No background shells registered." };
    }
    const lines = ["Registered background shells (newest first):"];
    for (const s of shells) {
      const alive = isShellAlive(s) ? "RUNNING" : "EXITED";
      const ageS = Math.round((Date.now() - s.startedAt) / 1000);
      lines.push(
        `  ${s.shellId}  pid=${s.pid}  ${alive}  age=${ageS}s  cmd=${s.command.slice(0, 80)}`,
      );
    }
    return { tool_use_id: "", content: lines.join("\n") };
  }

  const record = getShell(shellId);
  if (!record) {
    return {
      tool_use_id: "",
      content: `Unknown shellId: ${shellId}. Use BashOutput with no args to list known shells.`,
      is_error: true,
    };
  }

  const out = readShellOutput(shellId, tailBytes ? { tailBytes } : undefined);
  if (out === null) {
    return {
      tool_use_id: "",
      content: `Shell ${shellId} disappeared from registry`,
      is_error: true,
    };
  }

  const alive = isShellAlive(record);
  const status = alive ? "RUNNING" : "EXITED";
  const ageS = Math.round((Date.now() - record.startedAt) / 1000);
  const sizeKB = (out.size / 1024).toFixed(1);
  const truncMark = out.truncated ? ` (showing last ${tailBytes} bytes)` : "";

  const header =
    `[shellId: ${shellId}] [pid: ${record.pid}] [${status}] [age: ${ageS}s] ` +
    `[log: ${sizeKB}KB]${truncMark}\n`;

  return {
    tool_use_id: "",
    content: `${header}${out.content || "(no output yet)"}`,
  };
}
