// KCode - Glob Tool
// Fast file pattern matching

import { globSync } from "node:fs";
import type { ToolDefinition, ToolResult, GlobInput } from "../core/types";

// Directories to always exclude from glob results
const EXCLUDED_DIRS = [
  "node_modules", ".git", ".svn", ".hg",
  "dist", "build", ".next", ".nuxt",
  "__pycache__", ".pytest_cache",
  "vendor", "venv", ".venv",
  "coverage", ".nyc_output",
  ".cache", ".parcel-cache", ".turbo",
  "target",
];

const MAX_RESULTS = 1000;

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
    const excludePatterns = EXCLUDED_DIRS.map((d) => `**/${d}/**`);
    const matches = (globSync(pattern, { cwd, withFileTypes: false, exclude: (p) => {
      const name = typeof p === "string" ? p : p.name ?? "";
      return EXCLUDED_DIRS.includes(name);
    }}) as string[]).filter((m) => {
      // Double-check: filter out any paths containing excluded dirs
      for (const dir of EXCLUDED_DIRS) {
        if (m.includes(`/${dir}/`) || m.startsWith(`${dir}/`)) return false;
      }
      return true;
    });

    if (matches.length === 0) {
      return {
        tool_use_id: "",
        content: `No files found matching "${pattern}" in ${cwd}`,
      };
    }

    const truncated = matches.length > MAX_RESULTS;
    const results = truncated ? matches.slice(0, MAX_RESULTS) : matches;

    return {
      tool_use_id: "",
      content: `Found ${matches.length} file(s)${truncated ? ` (showing first ${MAX_RESULTS})` : ""}:\n${results.join("\n")}`,
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
