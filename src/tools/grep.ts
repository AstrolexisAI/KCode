// KCode - Grep Tool
// Search file contents using ripgrep

import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import type { GrepInput, ToolDefinition, ToolResult } from "../core/types";
import { getToolWorkspace } from "./workspace";

export const grepDefinition: ToolDefinition = {
  name: "Grep",
  description: "Search file contents using regex patterns (powered by ripgrep).",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "File or directory to search" },
      glob: { type: "string", description: 'Glob filter (e.g. "*.ts")' },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "Output mode (default: files_with_matches)",
      },
      "-i": { type: "boolean", description: "Case insensitive" },
      "-n": { type: "boolean", description: "Show line numbers" },
      "-A": { type: "number", description: "Lines after match" },
      "-B": { type: "number", description: "Lines before match" },
      "-C": { type: "number", description: "Context lines" },
      type: { type: "string", description: "File type filter (e.g. js, py, ts)" },
      head_limit: { type: "number", description: "Limit output entries" },
      multiline: { type: "boolean", description: "Enable multiline matching" },
    },
    required: ["pattern"],
  },
};

export async function executeGrep(input: Record<string, unknown>): Promise<ToolResult> {
  const opts = input as unknown as GrepInput;
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
