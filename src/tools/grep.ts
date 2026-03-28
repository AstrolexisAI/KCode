// KCode - Grep Tool
// Search file contents using ripgrep

import { spawn } from "node:child_process";
import type { ToolDefinition, ToolResult, GrepInput } from "../core/types";

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
  if (opts.path) args.push(opts.path);

  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const proc = spawn("rg", args, { cwd: process.cwd(), timeout: 30_000 });

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

      resolve({
        tool_use_id: "",
        content: output,
      });
    });

    proc.on("error", (err) => {
      resolve({
        tool_use_id: "",
        content: `Error: ${err.message}. Is ripgrep (rg) installed?`,
        is_error: true,
      });
    });
  });
}
