// KCode - Bash Tool
// Executes shell commands with timeout and sandboxing

import { spawn } from "node:child_process";
import type { ToolDefinition, ToolResult, BashInput } from "../core/types";

const MAX_TIMEOUT = 600_000; // 10 minutes
const DEFAULT_TIMEOUT = 120_000; // 2 minutes

export const bashDefinition: ToolDefinition = {
  name: "Bash",
  description: "Execute a shell command and return its output.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute" },
      description: { type: "string", description: "Description of what the command does" },
      timeout: { type: "number", description: "Timeout in milliseconds (max 600000)" },
    },
    required: ["command"],
  },
};

export async function executeBash(input: Record<string, unknown>): Promise<ToolResult> {
  const { command, timeout } = input as BashInput;
  const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const proc = spawn("bash", ["-c", command], {
      cwd: process.cwd(),
      timeout: timeoutMs,
      env: { ...process.env },
    });

    proc.stdout.on("data", (data: Buffer) => chunks.push(data));
    proc.stderr.on("data", (data: Buffer) => errChunks.push(data));

    proc.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf-8");
      const stderr = Buffer.concat(errChunks).toString("utf-8");
      const output = stdout + (stderr ? `\n${stderr}` : "");

      resolve({
        tool_use_id: "",
        content: output || `(exit code ${code})`,
        is_error: code !== 0,
      });
    });

    proc.on("error", (err) => {
      resolve({
        tool_use_id: "",
        content: `Error: ${err.message}`,
        is_error: true,
      });
    });
  });
}
