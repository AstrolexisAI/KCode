// KCode - Grep Tool
// Search file contents using ripgrep

import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import type { GrepInput, ToolDefinition, ToolResult } from "../core/types";
import { getToolWorkspace } from "./workspace";

export const grepDefinition: ToolDefinition = {
  name: "Grep",
  description:
    "A powerful search tool built on ripgrep\n\n" +
    "  Usage:\n" +
    "  - ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command. The Grep tool has been optimized for correct permissions and access.\n" +
    '  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")\n' +
    '  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")\n' +
    '  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts\n' +
    "  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use `interface\\{\\}` to find `interface{}` in Go code)\n" +
    "  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like `struct \\{[\\s\\S]*?field`, use `multiline: true`",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regular expression pattern to search for in file contents" },
      path: {
        type: "string",
        description: "File or directory to search in (rg PATH). Defaults to current working directory.",
      },
      glob: {
        type: "string",
        description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
      },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description:
          'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
      },
      "-i": { type: "boolean", description: "Case insensitive search (rg -i)" },
      "-n": {
        type: "boolean",
        description:
          'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
      },
      "-A": {
        type: "number",
        description:
          'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
      },
      "-B": {
        type: "number",
        description:
          'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
      },
      "-C": {
        type: "number",
        description:
          'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
      },
      type: {
        type: "string",
        description:
          "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.",
      },
      head_limit: {
        type: "number",
        description:
          'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries).',
      },
      multiline: {
        type: "boolean",
        description:
          "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
      },
    },
    required: ["pattern"],
  },
};

/**
 * Extract hit file paths from ripgrep output. rg prints in several formats:
 *   - files_with_matches: one path per line
 *   - content (with -n): "path:line:content" or "path:content"
 *   - count: "path:N"
 * Returns absolute paths, de-duplicated.
 */
function extractHitFiles(
  output: string,
  mode: string,
  inputPath: string | undefined,
  cwd: string,
): string[] {
  if (!output || output === "No matches found.") return [];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let path: string | null = null;
    if (mode === "files_with_matches") {
      path = line.trim();
    } else {
      // "path:line:..." or "path:count"
      const m = line.match(/^([^:]+):/);
      if (m) path = m[1]!;
    }
    if (!path) continue;
    // rg prints paths relative to cwd — join with searchCwd
    const abs = resolve(cwd, path);
    if (!seen.has(abs)) {
      seen.add(abs);
      files.push(abs);
    }
  }
  return files;
}

export async function executeGrep(input: Record<string, unknown>): Promise<ToolResult> {
  const opts = input as unknown as GrepInput;

  // Record grep usage for audit reconnaissance enforcement
  try {
    const { recordGrep } = await import("../core/session-tracker.js");
    recordGrep();
  } catch {
    /* tracker optional */
  }

  const args: string[] = [];

  // Output mode
  const mode = opts.output_mode ?? "files_with_matches";
  if (mode === "files_with_matches") args.push("-l");
  else if (mode === "count") args.push("-c");

  // Flags
  if (opts["-i"]) args.push("-i");
  if (opts["-n"] !== false && mode === "content") args.push("-n");
  if (opts["-A"]) args.push("-A", String(opts["-A"]));
  if (opts["-B"]) args.push("-B", String(opts["-B"]));
  if (opts["-C"] || opts.context) args.push("-C", String(opts["-C"] ?? opts.context));
  if (opts.multiline) args.push("-U", "--multiline-dotall");
  if (opts.glob) args.push("--glob", opts.glob);
  if (opts.type) args.push("--type", opts.type);

  args.push("--", opts.pattern);

  // Anchor to workspace — validate path doesn't escape
  const workspace = getToolWorkspace();
  const home = process.env.HOME ?? "";
  if (home && resolve(workspace) === resolve(home) && !opts.path) {
    return Promise.resolve({
      tool_use_id: "",
      content:
        `Warning: Workspace is your home directory (${workspace}). ` +
        `Grep will search your entire home. ` +
        `Specify a path parameter or run KCode from a project directory.`,
      is_error: true,
    } as ToolResult);
  }

  const searchCwd = workspace;
  if (opts.path) {
    const resolved = resolve(workspace, opts.path);
    const rel = relative(workspace, resolved);
    if (rel.startsWith("..")) {
      return Promise.resolve({
        tool_use_id: "",
        content: `Error: Path "${opts.path}" is outside the project workspace (${workspace}). Use a path within the project.`,
        is_error: true,
      } as ToolResult);
    }
    args.push(resolved);
  }

  return new Promise((resolveResult) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const proc = spawn("rg", args, { cwd: searchCwd, timeout: 30_000 });

    proc.stdout.on("data", (data: Buffer) => stdoutChunks.push(data));
    proc.stderr.on("data", (data: Buffer) => stderrChunks.push(data));

    proc.on("close", () => {
      let output = Buffer.concat(stdoutChunks).toString("utf-8").trim();

      // Apply offset and head_limit
      if (opts.offset || (opts.head_limit && opts.head_limit > 0)) {
        const lines = output.split("\n");
        const start = opts.offset ?? 0;
        const end = opts.head_limit ? start + opts.head_limit : undefined;
        output = lines.slice(start, end).join("\n");
      }

      // Use stderr only when stdout is empty (no results)
      if (!output) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
        output = stderr || "No matches found.";
      }

      // Extract hit file paths from rg output and record them in the
      // session tracker if the pattern is audit-relevant.
      try {
        const hitFiles = extractHitFiles(output, mode, opts.path, searchCwd);
        if (hitFiles.length > 0) {
          import("../core/session-tracker.js").then((m) => {
            m.recordGrepHits(opts.pattern, hitFiles);
          });
        }
      } catch {
        /* best-effort */
      }

      resolveResult({
        tool_use_id: "",
        content: output,
      });
    });

    proc.on("error", (err) => {
      resolveResult({
        tool_use_id: "",
        content: `Error: ${err.message}. Is ripgrep (rg) installed?`,
        is_error: true,
      });
    });
  });
}
