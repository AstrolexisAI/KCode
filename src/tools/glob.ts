// KCode - Glob Tool
// Fast file pattern matching — always anchored to workspace directory

import { globSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { GlobInput, ToolDefinition, ToolResult } from "../core/types";
import { getToolWorkspace } from "./workspace";

// Directories to always exclude from glob results
const EXCLUDED_DIRS = [
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "__pycache__",
  ".pytest_cache",
  "vendor",
  "venv",
  ".venv",
  "coverage",
  ".nyc_output",
  ".cache",
  ".parcel-cache",
  ".turbo",
  "target",
];

const MAX_RESULTS = 1000;

export const globDefinition: ToolDefinition = {
  name: "Glob",
  description:
    "- Fast file pattern matching tool that works with any codebase size\n" +
    '- Supports glob patterns like "**/*.js" or "src/**/*.ts"\n' +
    "- Returns matching file paths sorted by modification time\n" +
    "- Use this tool when you need to find files by name patterns\n" +
    "- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use a broader approach with Grep instead",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The glob pattern to match files against" },
      path: {
        type: "string",
        description:
          'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
      },
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
      content:
        `Warning: Workspace is your home directory (${workspace}). ` +
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
    const matches = (
      globSync(pattern, {
        cwd,
        withFileTypes: false,
        exclude: (p) => {
          const name = typeof p === "string" ? p : ((p as { name?: string }).name ?? "");
          return EXCLUDED_DIRS.includes(name);
        },
      }) as string[]
    ).filter((m) => {
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
