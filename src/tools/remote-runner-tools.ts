// KCode - BashOnRemote / ReadOnRemote tools
//
// Sibling tools to Bash and Read but operating on a registered remote
// over SSH. Separate tools (rather than a `--remote` flag on the
// existing tools) for two reasons:
//   1. Zero risk of regression on the local-only path (most usage).
//   2. The audit log marks them distinctly so reviewers can see at a
//      glance which turns reached out to a remote and which stayed
//      local.

import type { ToolDefinition, ToolResult } from "../core/types";
import {
  readFromRemote,
  resolveRemoteTarget,
  runOnRemote,
  writeToRemote,
} from "../remote/remote-runner";

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

function formatResult(
  stdout: string,
  stderr: string,
  exitCode: number,
  durationMs: number,
  timedOut: boolean,
): string {
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
  const formatted = formatResult(
    result.stdout,
    result.stderr,
    result.exitCode,
    result.durationMs,
    result.timedOut,
  );
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
    return {
      tool_use_id: "",
      content: "Error: path must not contain a single quote",
      is_error: true,
    };
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

// ─── WriteOnRemote ─────────────────────────────────────────────────

export const writeOnRemoteDefinition: ToolDefinition = {
  name: "WriteOnRemote",
  description:
    "Write content to a file on a previously authorized remote host. " +
    "Atomic: writes to a temp file in the same directory, then renames " +
    "over the target. Path must NOT contain a single quote (use " +
    "BashOnRemote with a heredoc for unusual paths). Existing file " +
    "permissions/ownership are NOT preserved by the rename — if you " +
    "need to keep them, read/edit/write yourself or use BashOnRemote.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description: "Friendly name of a registered remote",
      },
      path: {
        type: "string",
        description: "Absolute path to write on the remote",
      },
      content: {
        type: "string",
        description: "File contents to write (UTF-8)",
      },
    },
    required: ["name", "path", "content"],
  },
};

export async function executeWriteOnRemote(input: Record<string, unknown>): Promise<ToolResult> {
  const name = String(input.name ?? "");
  const path = String(input.path ?? "");
  const content = String(input.content ?? "");

  if (!NAME_RE.test(name)) {
    return { tool_use_id: "", content: `Error: name must match ${NAME_RE.source}`, is_error: true };
  }
  if (path.trim().length === 0) {
    return { tool_use_id: "", content: "Error: path must not be empty", is_error: true };
  }
  if (path.includes("'")) {
    return {
      tool_use_id: "",
      content: "Error: path must not contain a single quote",
      is_error: true,
    };
  }
  if (!resolveRemoteTarget(name)) {
    return { tool_use_id: "", content: `No remote named '${name}' is registered.`, is_error: true };
  }

  const result = await writeToRemote(name, path, content);
  if (result.exitCode !== 0) {
    return {
      tool_use_id: "",
      content: `Failed to write ${path} on ${name} (exit=${result.exitCode}):\n${result.stderr || "(no stderr)"}`,
      is_error: true,
    };
  }
  return {
    tool_use_id: "",
    content: `Wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${name}:${path} (${result.durationMs}ms)`,
  };
}

// ─── EditOnRemote ──────────────────────────────────────────────────

export const editOnRemoteDefinition: ToolDefinition = {
  name: "EditOnRemote",
  description:
    "Apply a single string replacement to a file on a registered remote. " +
    "Reads the file, replaces old_string with new_string (must occur " +
    "exactly once unless replace_all=true), and writes back atomically. " +
    "old_string must match the file content byte-for-byte including " +
    "whitespace. If the replacement is ambiguous (multiple matches with " +
    "replace_all=false), the tool errors and nothing is written.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Friendly name of a registered remote" },
      path: { type: "string", description: "Absolute path of the file to edit" },
      old_string: { type: "string", description: "Exact substring to replace" },
      new_string: { type: "string", description: "Replacement substring" },
      replace_all: {
        type: "boolean",
        description: "If true, replace every occurrence; default false",
      },
    },
    required: ["name", "path", "old_string", "new_string"],
  },
};

export async function executeEditOnRemote(input: Record<string, unknown>): Promise<ToolResult> {
  const name = String(input.name ?? "");
  const path = String(input.path ?? "");
  const oldStr = String(input.old_string ?? "");
  const newStr = String(input.new_string ?? "");
  const replaceAll = input.replace_all === true;

  if (!NAME_RE.test(name)) {
    return { tool_use_id: "", content: `Error: name must match ${NAME_RE.source}`, is_error: true };
  }
  if (path.trim().length === 0) {
    return { tool_use_id: "", content: "Error: path must not be empty", is_error: true };
  }
  if (path.includes("'")) {
    return {
      tool_use_id: "",
      content: "Error: path must not contain a single quote",
      is_error: true,
    };
  }
  if (oldStr.length === 0) {
    return { tool_use_id: "", content: "Error: old_string must not be empty", is_error: true };
  }
  if (oldStr === newStr) {
    return {
      tool_use_id: "",
      content: "Error: old_string and new_string are identical — no edit to apply",
      is_error: true,
    };
  }
  if (!resolveRemoteTarget(name)) {
    return { tool_use_id: "", content: `No remote named '${name}' is registered.`, is_error: true };
  }

  const readResult = await readFromRemote(name, path);
  if (readResult.exitCode !== 0) {
    return {
      tool_use_id: "",
      content: `Read failed before edit (exit=${readResult.exitCode}): ${readResult.stderr || "(no stderr)"}`,
      is_error: true,
    };
  }
  if (readResult.truncated) {
    return {
      tool_use_id: "",
      content: `File ${path} is larger than the read cap (256 KiB). Use BashOnRemote with sed or another stream tool for large files.`,
      is_error: true,
    };
  }

  const before = readResult.stdout;
  // Count occurrences without regex (so the user's content can't be
  // mis-interpreted as a pattern).
  let count = 0;
  let i = 0;
  while ((i = before.indexOf(oldStr, i)) !== -1) {
    count++;
    i += oldStr.length;
  }
  if (count === 0) {
    return {
      tool_use_id: "",
      content: `old_string not found in ${path}. Re-read the file and check whitespace/newlines.`,
      is_error: true,
    };
  }
  if (count > 1 && !replaceAll) {
    return {
      tool_use_id: "",
      content: `old_string matches ${count} times in ${path}. Either pass replace_all=true or extend old_string to be unique.`,
      is_error: true,
    };
  }

  const after = replaceAll ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);
  const writeResult = await writeToRemote(name, path, after);
  if (writeResult.exitCode !== 0) {
    return {
      tool_use_id: "",
      content: `Edit prepared, but write back failed (exit=${writeResult.exitCode}): ${writeResult.stderr || "(no stderr)"}`,
      is_error: true,
    };
  }
  return {
    tool_use_id: "",
    content: `Edited ${name}:${path} (${count} replacement${count === 1 ? "" : "s"} of ${oldStr.length}→${newStr.length} bytes; ${writeResult.durationMs}ms write)`,
  };
}

// ─── GlobOnRemote ──────────────────────────────────────────────────

const GLOB_DEFAULT_LIMIT = 200;
const GREP_DEFAULT_LIMIT = 200;
const EXCLUDE_DIRS = [".git", "node_modules", ".venv", "__pycache__", "dist", "build", ".next"];

function shellSingleQuote(s: string): string {
  // Reject single-quote in input — these tools take patterns/paths
  // from the model and we don't want to invent an escape scheme.
  // The model can fall back to BashOnRemote for exotic patterns.
  if (s.includes("'")) {
    throw new Error("input must not contain a single quote");
  }
  return `'${s}'`;
}

export const globOnRemoteDefinition: ToolDefinition = {
  name: "GlobOnRemote",
  description:
    "Find files on a previously authorized remote host that match a " +
    "name glob (e.g. '*.ts', '*.conf'). Equivalent to `find <path> " +
    "-type f -name <pattern>` over SSH. Returns up to 200 paths " +
    "sorted by modification time (newest first). Patterns must NOT " +
    "contain single quotes — for nested globs like '**/*.tsx' or " +
    "ripgrep-style queries, use BashOnRemote with `find` directly.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Friendly name of a registered remote" },
      pattern: {
        type: "string",
        description: "File name glob (POSIX `find -name`, e.g. '*.ts' or 'README*')",
      },
      path: {
        type: "string",
        description:
          "Directory on the remote to search under. Defaults to '.' (the SSH login directory, typically $HOME).",
      },
      limit: {
        type: "number",
        description: `Max results to return (default ${GLOB_DEFAULT_LIMIT}, max 1000)`,
      },
    },
    required: ["name", "pattern"],
  },
};

export async function executeGlobOnRemote(input: Record<string, unknown>): Promise<ToolResult> {
  const name = String(input.name ?? "");
  const pattern = String(input.pattern ?? "");
  const path = String(input.path ?? ".");
  const limit = clampInt(input.limit, 1, 1000, GLOB_DEFAULT_LIMIT);

  if (!NAME_RE.test(name)) {
    return { tool_use_id: "", content: `Error: name must match ${NAME_RE.source}`, is_error: true };
  }
  if (pattern.trim().length === 0) {
    return { tool_use_id: "", content: "Error: pattern must not be empty", is_error: true };
  }
  if (!resolveRemoteTarget(name)) {
    return { tool_use_id: "", content: `No remote named '${name}' is registered.`, is_error: true };
  }

  let qPattern: string;
  let qPath: string;
  try {
    qPattern = shellSingleQuote(pattern);
    qPath = shellSingleQuote(path);
  } catch (err) {
    return {
      tool_use_id: "",
      content: `Error: ${err instanceof Error ? err.message : err}`,
      is_error: true,
    };
  }

  const prune = EXCLUDE_DIRS.map((d) => `-name '${d}'`).join(" -o ");
  // Two-pass find: prune the noisy dirs first, then match files.
  // -printf isn't portable to BSD find (macOS), so we use stat for mtime
  // sort via a portable POSIX pipeline.
  const cmd =
    `find ${qPath} \\( -type d \\( ${prune} \\) -prune \\) -o ` +
    `\\( -type f -name ${qPattern} -print \\) 2>/dev/null | head -n ${limit}`;
  const result = await runOnRemote(name, cmd, { timeoutMs: 30_000 });

  if (result.exitCode !== 0 && result.stdout.length === 0) {
    return {
      tool_use_id: "",
      content: `find failed (exit=${result.exitCode}): ${result.stderr || "(no stderr)"}`,
      is_error: true,
    };
  }
  const lines = result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { tool_use_id: "", content: `No files matched ${pattern} under ${path} on ${name}.` };
  }
  const header = `# remote: ${name}  pattern: ${pattern}  under: ${path}  matches: ${lines.length}${result.truncated ? " (TRUNCATED)" : ""}\n`;
  return { tool_use_id: "", content: header + lines.join("\n") };
}

// ─── GrepOnRemote ──────────────────────────────────────────────────

export const grepOnRemoteDefinition: ToolDefinition = {
  name: "GrepOnRemote",
  description:
    "Search file contents on a previously authorized remote host using " +
    "POSIX `grep -rEn`. Returns up to 200 matching lines (file:line:" +
    "content). Excludes common ignored dirs (.git, node_modules, .venv, " +
    "__pycache__, dist, build, .next). Pattern is a POSIX extended " +
    "regex; use BashOnRemote if you need PCRE features. Pattern and " +
    "path must NOT contain single quotes.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Friendly name of a registered remote" },
      pattern: {
        type: "string",
        description: "POSIX extended regex (passed to `grep -E`)",
      },
      path: {
        type: "string",
        description: "Directory to search under (default '.')",
      },
      file_glob: {
        type: "string",
        description: "Optional file glob to limit which files are searched (`grep --include=`)",
      },
      limit: {
        type: "number",
        description: `Max matching lines to return (default ${GREP_DEFAULT_LIMIT}, max 1000)`,
      },
    },
    required: ["name", "pattern"],
  },
};

export async function executeGrepOnRemote(input: Record<string, unknown>): Promise<ToolResult> {
  const name = String(input.name ?? "");
  const pattern = String(input.pattern ?? "");
  const path = String(input.path ?? ".");
  const fileGlob = input.file_glob != null ? String(input.file_glob) : undefined;
  const limit = clampInt(input.limit, 1, 1000, GREP_DEFAULT_LIMIT);

  if (!NAME_RE.test(name)) {
    return { tool_use_id: "", content: `Error: name must match ${NAME_RE.source}`, is_error: true };
  }
  if (pattern.trim().length === 0) {
    return { tool_use_id: "", content: "Error: pattern must not be empty", is_error: true };
  }
  if (!resolveRemoteTarget(name)) {
    return { tool_use_id: "", content: `No remote named '${name}' is registered.`, is_error: true };
  }

  let qPattern: string;
  let qPath: string;
  let qInclude: string | undefined;
  try {
    qPattern = shellSingleQuote(pattern);
    qPath = shellSingleQuote(path);
    if (fileGlob !== undefined) qInclude = shellSingleQuote(fileGlob);
  } catch (err) {
    return {
      tool_use_id: "",
      content: `Error: ${err instanceof Error ? err.message : err}`,
      is_error: true,
    };
  }

  const excludes = EXCLUDE_DIRS.map((d) => `--exclude-dir=${d}`).join(" ");
  const includeFlag = qInclude !== undefined ? `--include=${qInclude}` : "";
  // -I = skip binary, -E = extended regex, -n = line numbers, -r = recursive.
  // Both GNU and BSD grep on macOS support these flags.
  const cmd = `grep -rEn -I ${excludes} ${includeFlag} ${qPattern} ${qPath} 2>/dev/null | head -n ${limit}`;
  const result = await runOnRemote(name, cmd, { timeoutMs: 30_000 });

  // grep exits 1 when no match — that's not an error for our purposes.
  if (result.exitCode > 1 && result.stdout.length === 0) {
    return {
      tool_use_id: "",
      content: `grep failed (exit=${result.exitCode}): ${result.stderr || "(no stderr)"}`,
      is_error: true,
    };
  }
  const lines = result.stdout
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { tool_use_id: "", content: `No matches for ${pattern} under ${path} on ${name}.` };
  }
  const header = `# remote: ${name}  pattern: ${pattern}  under: ${path}  matches: ${lines.length}${result.truncated ? " (TRUNCATED)" : ""}\n`;
  return { tool_use_id: "", content: header + lines.join("\n") };
}

function clampInt(raw: unknown, min: number, max: number, def: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return def;
  return Math.min(Math.max(min, Math.floor(raw)), max);
}
