// KCode - Rename Refactoring Tool
// Finds all references of a symbol and renames them atomically across files

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { ToolDefinition, ToolResult } from "../core/types";

export const renameDefinition: ToolDefinition = {
  name: "Rename",
  description:
    "Rename a symbol (function, variable, class, type, etc.) across all files in the project. " +
    "Searches for exact references and renames them atomically. " +
    "Returns a summary of all files changed.",
  input_schema: {
    type: "object",
    properties: {
      symbol: {
        type: "string",
        description: "The current name of the symbol to rename (exact match)",
      },
      new_name: {
        type: "string",
        description: "The new name for the symbol",
      },
      scope: {
        type: "string",
        description: "Directory to scope the rename to (default: current working directory)",
      },
      dry_run: {
        type: "boolean",
        description: "If true, show what would be renamed without making changes (default: false)",
      },
      file_pattern: {
        type: "string",
        description: "Glob-like extension filter, e.g. '.ts,.tsx' (default: all source files)",
      },
    },
    required: ["symbol", "new_name"],
  },
};

// ─── Supported Extensions ─────────────────────────────────────

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".kt", ".swift",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".rb",
  ".vue", ".svelte", ".json",
]);

const IGNORE_DIRS = new Set([
  "node_modules", "dist", "build", ".git", "__pycache__",
  "venv", ".next", ".nuxt", "target", "vendor",
  ".kcode", ".vscode", ".idea", "coverage", "data",
]);

const MAX_FILE_SIZE = 500_000; // 500KB
const MAX_FILES = 10_000;

// ─── Implementation ──────────────────────────────────────────

interface RenameMatch {
  file: string;
  relativePath: string;
  count: number;
  lines: number[]; // 1-based line numbers where matches occur
  /** Original file content captured during scan (TOCTOU fix) */
  originalContent: string;
}

function walkAndCollect(
  dir: string,
  cwd: string,
  allowedExts: Set<string>,
  results: RenameMatch[],
  symbol: string,
  depth = 0,
): void {
  if (depth > 10 || results.length >= MAX_FILES) return;

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_FILES) break;

    const fullPath = resolve(dir, entry.name);

    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && !IGNORE_DIRS.has(entry.name)) {
        walkAndCollect(fullPath, cwd, allowedExts, results, symbol, depth + 1);
      }
      continue;
    }

    const ext = fullPath.substring(fullPath.lastIndexOf("."));
    if (!allowedExts.has(ext)) continue;

    try {
      const stat = statSync(fullPath);
      if (stat.size > MAX_FILE_SIZE) continue;

      const content = readFileSync(fullPath, "utf-8");
      if (!content.includes(symbol)) continue;

      // Find all occurrences with word boundary matching
      const regex = new RegExp(`\\b${escapeRegex(symbol)}\\b`, "g");
      const lines = content.split("\n");
      const matchLines: number[] = [];
      let count = 0;

      for (let i = 0; i < lines.length; i++) {
        const lineMatches = lines[i].match(regex);
        if (lineMatches) {
          count += lineMatches.length;
          matchLines.push(i + 1);
        }
      }

      if (count > 0) {
        results.push({
          file: fullPath,
          relativePath: relative(cwd, fullPath),
          count,
          lines: matchLines,
          originalContent: content,
        });
      }
    } catch {
      // Skip unreadable files
    }
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function executeRename(input: Record<string, unknown>): Promise<ToolResult> {
  const cwd = process.cwd();
  const symbol = String(input.symbol ?? "").trim();
  const newName = String(input.new_name ?? "").trim();
  const scope = input.scope ? resolve(String(input.scope)) : cwd;
  const dryRun = input.dry_run === true;

  // Validation
  if (!symbol) {
    return { tool_use_id: "", content: "Error: symbol is required.", is_error: true };
  }
  if (!newName) {
    return { tool_use_id: "", content: "Error: new_name is required.", is_error: true };
  }
  if (symbol === newName) {
    return { tool_use_id: "", content: "Error: symbol and new_name are the same.", is_error: true };
  }

  // Validate identifier characters (basic — covers most languages)
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(newName)) {
    return { tool_use_id: "", content: "Error: new_name must be a valid identifier (alphanumeric, _, $).", is_error: true };
  }
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(symbol)) {
    return { tool_use_id: "", content: "Error: symbol must be a valid identifier.", is_error: true };
  }

  if (!existsSync(scope)) {
    return { tool_use_id: "", content: `Error: scope directory not found: ${scope}`, is_error: true };
  }

  // Prevent renaming outside the project directory
  const resolvedScope = resolve(scope);
  const resolvedCwd = resolve(cwd);
  if (!resolvedScope.startsWith(resolvedCwd)) {
    return { tool_use_id: "", content: `Error: scope must be within the project directory (${resolvedCwd}).`, is_error: true };
  }

  // Parse file pattern filter
  let allowedExts = SOURCE_EXTENSIONS;
  if (input.file_pattern) {
    const pattern = String(input.file_pattern).trim();
    const exts = pattern.split(",").map((e) => e.trim()).filter(Boolean);
    if (exts.length > 0) {
      allowedExts = new Set(exts.map((e) => (e.startsWith(".") ? e : `.${e}`)));
    }
  }

  // Find all references
  const matches: RenameMatch[] = [];
  walkAndCollect(scope, cwd, allowedExts, matches, symbol);

  if (matches.length === 0) {
    return { tool_use_id: "", content: `No references to "${symbol}" found.` };
  }

  const totalCount = matches.reduce((sum, m) => sum + m.count, 0);

  if (dryRun) {
    const lines: string[] = [
      `Dry run: would rename "${symbol}" → "${newName}"`,
      `Found ${totalCount} reference(s) in ${matches.length} file(s):`,
      "",
    ];

    for (const m of matches) {
      const lineNums = m.lines.length <= 5
        ? m.lines.join(", ")
        : `${m.lines.slice(0, 5).join(", ")}... (+${m.lines.length - 5} more)`;
      lines.push(`  ${m.relativePath}: ${m.count} match(es) on lines ${lineNums}`);
    }

    return { tool_use_id: "", content: lines.join("\n") };
  }

  // Apply rename — use stored content (TOCTOU safe)
  const regex = new RegExp(`\\b${escapeRegex(symbol)}\\b`, "g");
  let filesModified = 0;
  const errors: string[] = [];
  // Track successfully written files for rollback
  const written: Array<{ file: string; originalContent: string }> = [];

  for (const m of matches) {
    try {
      const updated = m.originalContent.replace(regex, newName);
      writeFileSync(m.file, updated, "utf-8");
      written.push({ file: m.file, originalContent: m.originalContent });
      filesModified++;
    } catch (err) {
      // Rollback all previously written files
      for (const prev of written) {
        try {
          writeFileSync(prev.file, prev.originalContent, "utf-8");
        } catch { /* best-effort rollback */ }
      }
      errors.push(`${m.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
      errors.push(`Rolled back ${written.length} previously modified file(s) due to write failure.`);
      filesModified = 0; // Reflect rollback in output
      break; // Stop processing after rollback
    }
  }

  const lines: string[] = [
    `Renamed "${symbol}" → "${newName}"`,
    `Modified ${filesModified} file(s), ${totalCount} reference(s)`,
    "",
  ];

  for (const m of matches) {
    const lineNums = m.lines.length <= 5
      ? m.lines.join(", ")
      : `${m.lines.slice(0, 5).join(", ")}... (+${m.lines.length - 5} more)`;
    lines.push(`  ${m.relativePath}: ${m.count} match(es) on lines ${lineNums}`);
  }

  if (errors.length > 0) {
    lines.push("", `Errors (${errors.length}):`);
    for (const e of errors) {
      lines.push(`  ${e}`);
    }
  }

  return { tool_use_id: "", content: lines.join("\n") };
}
