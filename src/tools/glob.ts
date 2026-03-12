// KCode - Glob Tool
// Fast file pattern matching

import { globSync } from "node:fs";
import type { ToolDefinition, ToolResult, GlobInput } from "../core/types";

export const globDefinition: ToolDefinition = {
  name: "Glob",
  description: "Find files matching a glob pattern. Returns file paths sorted by modification time.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: 'Glob pattern (e.g. "**/*.ts")' },
      path: { type: "string", description: "Directory to search in (defaults to cwd)" },
    },
    required: ["pattern"],
  },
};

export async function executeGlob(input: Record<string, unknown>): Promise<ToolResult> {
  const { pattern, path: searchPath } = input as GlobInput;
  const cwd = searchPath ?? process.cwd();

  try {
    const matches = globSync(pattern, { cwd, withFileTypes: false }) as string[];

    if (matches.length === 0) {
      return {
        tool_use_id: "",
        content: `No files found matching "${pattern}" in ${cwd}`,
      };
    }

    return {
      tool_use_id: "",
      content: `Found ${matches.length} file(s):\n${matches.join("\n")}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      tool_use_id: "",
      content: `Error: ${msg}`,
      is_error: true,
    };
  }
}
