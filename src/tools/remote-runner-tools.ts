// KCode - BashOnRemote / ReadOnRemote tools
//
// Sibling tools to Bash and Read but operating on a registered remote
// over SSH. Separate tools (rather than a `--remote` flag on the
// existing tools) for two reasons:
//   1. Zero risk of regression on the local-only path (most usage).
//   2. The audit log marks them distinctly so reviewers can see at a
//      glance which turns reached out to a remote and which stayed
//      local.

import { readFromRemote, resolveRemoteTarget, runOnRemote } from "../remote/remote-runner";
import type { ToolDefinition, ToolResult } from "../core/types";

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

function formatResult(stdout: string, stderr: string, exitCode: number, durationMs: number, timedOut: boolean): string {
  const parts: string[] = [];
  parts.push(`exit=${exitCode} duration=${durationMs}ms${timedOut ? " (TIMED OUT)" : ""}`);
  if (stdout.length > 0) {
    parts.push("--- stdout ---", stdout.replace(/\n$/, ""));
  } else {
    parts.push("(empty stdout)");
  }
  if (stderr.length > 0) {
    parts.push("--- stderr ---", stderr.replace(/\n$/, ""));
  }
  return parts.join("\n");
}

// ─── BashOnRemote ──────────────────────────────────────────────────

export const bashOnRemoteDefinition: ToolDefinition = {
  name: "BashOnRemote",
  description:
    "Run a shell command on a previously authorized remote host. " +
    "USE THIS instead of Bash when the user asks you to do something on " +
    "a specific machine they've authorized (laptop, server, LAN host). " +
    "List authorized remotes with the kcode CLI: `kcode remote list`. " +
    "If no remote is registered, ask the user to authorize one first " +
    "(use the RemoteAuthorize tool to bootstrap, or `kcode remote " +
    "authorize <name> <user@host>` from the CLI).\n" +
    "The command runs through the target's login shell. stdout/stderr " +
    "are capped at 256 KiB per stream; commands timeout at 60s. The " +
    "command string is passed to ssh as a single argument — you are " +
    "responsible for shell escaping the same way you would for the " +
    "local Bash tool.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description: "Friendly name of a registered remote (1-32 chars [A-Za-z0-9_-])",
      },
      command: {
        type: "string",
        description: "Shell command to execute on the remote",
      },
      timeout_ms: {
        type: "number",
        description: "Optional timeout in milliseconds (default 60000)",
      },
    },
    required: ["name", "command"],
  },
};

export async function executeBashOnRemote(input: Record<string, unknown>): Promise<ToolResult> {
  const name = String(input.name ?? "");
  const command = String(input.command ?? "");
  const timeoutRaw = input.timeout_ms;

  if (!NAME_RE.test(name)) {
    return { tool_use_id: "", content: `Error: name must match ${NAME_RE.source}`, is_error: true };
  }
  if (command.trim().length === 0) {
    return { tool_use_id: "", content: "Error: command must not be empty", is_error: true };
  }
  if (!resolveRemoteTarget(name)) {
    return {
      tool_use_id: "",
      content: `No remote named '${name}' is registered. List available remotes with 'kcode remote list', or authorize a new one with the RemoteAuthorize tool.`,
      is_error: true,
    };
  }

  let timeoutMs = 60_000;
  if (typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0) {
    timeoutMs = Math.min(Math.max(1000, timeoutRaw), 600_000);
  }

  const result = await runOnRemote(name, command, { timeoutMs });
  const formatted = formatResult(result.stdout, result.stderr, result.exitCode, result.durationMs, result.timedOut);
  return {
    tool_use_id: "",
    content: formatted,
    is_error: result.exitCode !== 0,
  };
}

// ─── ReadOnRemote ──────────────────────────────────────────────────

export const readOnRemoteDefinition: ToolDefinition = {
  name: "ReadOnRemote",
  description:
    "Read a file from a previously authorized remote host. Equivalent " +
    "to `cat <path>` over SSH, with a 256 KiB cap. Use this instead of " +
    "the local Read tool when the file lives on an authorized remote. " +
    "Path must NOT contain a single quote (use BashOnRemote for paths " +
    "with unusual characters).",
  input_schema: {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description: "Friendly name of a registered remote",
      },
      path: {
        type: "string",
        description: "Absolute or ~-expanded path to read on the remote",
      },
    },
    required: ["name", "path"],
  },
};

export async function executeReadOnRemote(input: Record<string, unknown>): Promise<ToolResult> {
  const name = String(input.name ?? "");
  const path = String(input.path ?? "");

  if (!NAME_RE.test(name)) {
    return { tool_use_id: "", content: `Error: name must match ${NAME_RE.source}`, is_error: true };
  }
  if (path.trim().length === 0) {
    return { tool_use_id: "", content: "Error: path must not be empty", is_error: true };
  }
  if (path.includes("'")) {
    return { tool_use_id: "", content: "Error: path must not contain a single quote", is_error: true };
  }
  if (!resolveRemoteTarget(name)) {
    return {
      tool_use_id: "",
      content: `No remote named '${name}' is registered.`,
      is_error: true,
    };
  }

  const result = await readFromRemote(name, path);
  if (result.exitCode !== 0) {
    return {
      tool_use_id: "",
      content: `Failed to read ${path} on ${name} (exit=${result.exitCode}):\n${result.stderr || "(no stderr)"}`,
      is_error: true,
    };
  }
  // Successful read — return raw content prefixed with a small header
  // so the model knows where it came from.
  const header = `# remote: ${name}\n# path:   ${path}\n# bytes:  ${Buffer.byteLength(result.stdout, "utf-8")}${result.truncated ? " (TRUNCATED)" : ""}\n`;
  return { tool_use_id: "", content: `${header}${result.stdout}` };
}
