// KCode - Glob Tool
// Fast file pattern matching — always anchored to workspace directory

import { globSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { ToolDefinition, ToolResult, GlobInput } from "../core/types";
import { getToolWorkspace } from "./workspace";

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
  description: "Find files matching a glob pattern. Returns file paths sorted by modification time. Searches within the project workspace by default.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.tsx")' },
      path: { type: "string", description: "Directory to search in (defaults to project workspace). Must be within the workspace." },
    },
    required: ["pattern"],
  },
};

export async function executeGlob(input: Record<string, unknown>): Promise<ToolResult> {
  const { pattern, path: searchPath } = input as unknown as GlobInput;
  const workspace = getToolWorkspace();

  // Warn if workspace is HOME — too broad for code search
  const home = process.env.HOME ?? "";
  if (home && resolve(workspace) === resolve(home) && !searchPath) {
    return {
      tool_use_id: "",
      content: `Warning: Workspace is your home directory (${workspace}). ` +
        `Glob patterns like "${pattern}" will search your entire home. ` +
        `Specify a path parameter (e.g. path: "src/") or run KCode from a project directory.`,
      is_error: true,
    };
  }

  // Resolve the search directory — anchor to workspace
  let cwd: string;
  if (searchPath) {
    const resolved = resolve(workspace, searchPath);
    // Validate: must be within workspace (no escaping to parent dirs)
    const rel = relative(workspace, resolved);
    if (rel.startsWith("..") || resolve(resolved) === resolve("/")) {
      return {
        tool_use_id: "",
        content: `Error: Path "${searchPath}" is outside the project workspace (${workspace}). Use a path within the project.`,
        is_error: true,
      };
    }
    cwd = resolved;
  } else {
    cwd = workspace;
  }

  try {
    const matches = (globSync(pattern, { cwd, withFileTypes: false, exclude: (p) => {
      const name = typeof p === "string" ? p : (p as { name?: string }).name ?? "";
      return EXCLUDED_DIRS.includes(name);
    }}) as string[]).filter((m) => {
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
