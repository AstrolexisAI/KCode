// KCode - LS Tool
// Fast directory listing without spawning a shell process

import { lstatSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "../core/types";

// Directories to skip in recursive mode
const EXCLUDED_DIRS = new Set([
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
]);

const MAX_ENTRIES = 2000;

export const lsDefinition: ToolDefinition = {
  name: "LS",
  description:
    "List directory contents. Faster and safer than using Bash for directory listing. " +
    "Supports recursive listing and glob-style pattern filtering.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Directory to list (defaults to cwd)",
      },
      recursive: {
        type: "boolean",
        description: "Recursively list subdirectories (default: false)",
      },
      pattern: {
        type: "string",
        description: "Filter entries by pattern (simple glob: *.ts, *.py, etc.)",
      },
    },
    required: [],
  },
};

function globToRegex(pattern: string): RegExp {
  // Convert simple glob pattern to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function listDir(
  dirPath: string,
  recursive: boolean,
  filter: RegExp | null,
  results: string[],
  prefix: string,
  depth: number,
): void {
  if (results.length >= MAX_ENTRIES) return;
  if (depth > 20) return; // Safety limit

  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return; // Skip unreadable directories
  }

  entries.sort();

  for (const entry of entries) {
    if (results.length >= MAX_ENTRIES) return;

    const fullPath = join(dirPath, entry);
    const relativePath = prefix ? `${prefix}/${entry}` : entry;

    let isDir = false;
    let isSymlink = false;
    try {
      const lstats = lstatSync(fullPath);
      isSymlink = lstats.isSymbolicLink();
      if (isSymlink) {
        // Resolve symlink target to check if it's a directory, but don't recurse into it
        try {
          isDir = statSync(fullPath).isDirectory();
        } catch {
          isDir = false;
        }
      } else {
        isDir = lstats.isDirectory();
      }
    } catch {
      continue; // Skip inaccessible entries
    }

    if (isDir && !isSymlink && EXCLUDED_DIRS.has(entry)) continue;

    // Show symlinks to directories with @ suffix, don't recurse into them
    const displayName =
      isSymlink && isDir
        ? `${relativePath}@`
        : isDir
          ? `${relativePath}/`
          : isSymlink
            ? `${relativePath}@`
            : relativePath;

    if (filter) {
      // For directories, always include if recursive (so we can recurse into them)
      // For files, only include if they match the filter
      if (!isDir && filter.test(entry)) {
        results.push(displayName);
      } else if (isDir && !filter.test(entry)) {
        // Don't show directory itself, but still recurse
      } else if (isDir) {
        results.push(displayName);
      }
    } else {
      results.push(displayName);
    }

    if (recursive && isDir && !isSymlink) {
      listDir(fullPath, recursive, filter, results, relativePath, depth + 1);
    }
  }
}

export async function executeLs(input: Record<string, unknown>): Promise<ToolResult> {
  const cwd = process.cwd();
  const dirPath = resolve(String(input.path ?? cwd));
  const recursive = Boolean(input.recursive ?? false);
  const pattern = input.pattern as string | undefined;

  // Path traversal guard: only allow listing within the project or home directory
  if (!dirPath.startsWith(cwd) && !dirPath.startsWith(homedir())) {
    return {
      tool_use_id: "",
      content: `Error: Cannot list directories outside the project or home directory`,
      is_error: true,
    };
  }

  try {
    // Verify directory exists
    const stat = statSync(dirPath);
    if (!stat.isDirectory()) {
      return {
        tool_use_id: "",
        content: `Error: ${dirPath} is not a directory`,
        is_error: true,
      };
    }

    const filter = pattern ? globToRegex(pattern) : null;
    const results: string[] = [];

    listDir(dirPath, recursive, filter, results, "", 0);

    if (results.length === 0) {
      const msg = pattern
        ? `No entries matching "${pattern}" in ${dirPath}`
        : `Directory is empty: ${dirPath}`;
      return { tool_use_id: "", content: msg };
    }

    const truncated = results.length >= MAX_ENTRIES;
    const header = `${dirPath}/ (${results.length}${truncated ? "+" : ""} entries${pattern ? `, filter: ${pattern}` : ""}):\n`;

    return {
      tool_use_id: "",
      content: header + results.join("\n"),
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
