// KCode - GrepReplace Tool
// Regex find-and-replace across multiple files with preview

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "../core/types";

export const grepReplaceDefinition: ToolDefinition = {
  name: "GrepReplace",
  description:
    "Find and replace text across multiple files using regex or literal patterns. " +
    "Dry-run by default — shows what would change without modifying files. " +
    "Set dry_run=false to apply changes. Supports file extension filtering.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Search pattern (regex or literal string)",
      },
      replacement: {
        type: "string",
        description: "Replacement string (supports $1, $2 etc. for regex capture groups)",
      },
      path: {
        type: "string",
        description: "Directory or file to search in (default: current working directory)",
      },
      glob: {
        type: "string",
        description: "Extension filter, e.g. '.ts,.tsx,.js' (default: common source files)",
      },
      literal: {
        type: "boolean",
        description: "Treat pattern as literal string instead of regex (default: false)",
      },
      dry_run: {
        type: "boolean",
        description: "Preview changes without modifying files (default: true)",
      },
      case_insensitive: {
        type: "boolean",
        description: "Case-insensitive matching (default: false)",
      },
      max_files: {
        type: "number",
        description: "Maximum number of files to process (default: 100)",
      },
    },
    required: ["pattern", "replacement"],
  },
};

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".kt", ".swift",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".rb",
  ".vue", ".svelte", ".json", ".yaml", ".yml",
  ".toml", ".md", ".txt", ".html", ".css", ".scss",
]);

const IGNORE_DIRS = new Set([
  "node_modules", "dist", "build", ".git", "__pycache__",
  "venv", ".next", ".nuxt", "target", "vendor",
  ".kcode", ".vscode", ".idea", "coverage",
]);

const MAX_FILE_SIZE = 500_000; // 500KB

// ─── Implementation ──────────────────────────────────────────

interface FileMatch {
  file: string;
  relativePath: string;
  matches: Array<{ line: number; before: string; after: string }>;
  totalReplacements: number;
  /** Original file content captured during scan (TOCTOU fix) */
  originalContent: string;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectFiles(
  dir: string,
  allowedExts: Set<string>,
  maxFiles: number,
  results: string[],
  depth = 0,
): void {
  if (depth > 10 || results.length >= maxFiles) return;

  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxFiles) break;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && !IGNORE_DIRS.has(entry.name)) {
        collectFiles(fullPath, allowedExts, maxFiles, results, depth + 1);
      }
      continue;
    }

    const ext = extname(entry.name);
    if (!allowedExts.has(ext)) continue;

    try {
      const stat = statSync(fullPath);
      if (stat.size <= MAX_FILE_SIZE) {
        results.push(fullPath);
      }
    } catch { /* skip */ }
  }
}

export async function executeGrepReplace(input: Record<string, unknown>): Promise<ToolResult> {
  const cwd = process.cwd();
  const patternStr = String(input.pattern ?? "").trim();
  const replacement = String(input.replacement ?? "");
  const searchPath = input.path ? resolve(String(input.path)) : cwd;
  const literal = input.literal === true;
  const dryRun = input.dry_run !== false; // Default true
  const caseInsensitive = input.case_insensitive === true;
  const maxFiles = Math.max(1, Math.min(500, Number(input.max_files ?? 100)));

  if (!patternStr) {
    return { tool_use_id: "", content: "Error: pattern is required.", is_error: true };
  }

  // Constrain search path to within cwd
  const resolvedPath = resolve(searchPath);
  const resolvedCwd = resolve(cwd);
  if (!resolvedPath.startsWith(resolvedCwd)) {
    return { tool_use_id: "", content: `Error: path must be within the project directory (${resolvedCwd}).`, is_error: true };
  }

  // Build regex with ReDoS protection
  let regex: RegExp;
  try {
    const flags = "g" + (caseInsensitive ? "i" : "");
    const source = literal ? escapeRegex(patternStr) : patternStr;

    // Basic ReDoS detection: reject nested quantifiers like (a+)+, (a*)*
    if (!literal && /([+*])\)?[+*{]/.test(source)) {
      return { tool_use_id: "", content: "Error: Pattern contains nested quantifiers which may cause catastrophic backtracking. Simplify the regex or use literal=true.", is_error: true };
    }

    regex = new RegExp(source, flags);
  } catch (err) {
    return { tool_use_id: "", content: `Error: Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
  }

  // Parse extension filter
  let allowedExts = DEFAULT_EXTENSIONS;
  if (input.glob) {
    const exts = String(input.glob).split(",").map((e) => e.trim()).filter(Boolean);
    if (exts.length > 0) {
      allowedExts = new Set(exts.map((e) => (e.startsWith(".") ? e : `.${e}`)));
    }
  }

  // Collect files
  const files: string[] = [];
  collectFiles(resolvedPath, allowedExts, maxFiles, files);

  if (files.length === 0) {
    return { tool_use_id: "", content: "No matching files found." };
  }

  // Process files
  const fileMatches: FileMatch[] = [];
  let totalReplacements = 0;

  for (const file of files) {
    try {
      const content = readFileSync(file, "utf-8");
      if (!regex.test(content)) {
        regex.lastIndex = 0; // Reset after test
        continue;
      }
      regex.lastIndex = 0;

      const lines = content.split("\n");
      const matches: FileMatch["matches"] = [];
      let fileReplacements = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        regex.lastIndex = 0;
        if (regex.test(line)) {
          regex.lastIndex = 0;
          const after = line.replace(regex, replacement);
          const count = (line.match(regex) || []).length;
          regex.lastIndex = 0;
          fileReplacements += count;
          matches.push({
            line: i + 1,
            before: line.trim().slice(0, 120),
            after: after.trim().slice(0, 120),
          });
        }
      }

      if (matches.length > 0) {
        fileMatches.push({
          file,
          relativePath: relative(cwd, file),
          matches,
          totalReplacements: fileReplacements,
          originalContent: content,
        });
        totalReplacements += fileReplacements;
      }
    } catch { /* skip unreadable */ }
  }

  if (fileMatches.length === 0) {
    return { tool_use_id: "", content: `No matches found for pattern: ${patternStr}` };
  }

  // Build output
  const output: string[] = [
    dryRun ? `Dry run: ${totalReplacements} replacement(s) in ${fileMatches.length} file(s)` : `Applied ${totalReplacements} replacement(s) in ${fileMatches.length} file(s)`,
    `Pattern: ${patternStr}${literal ? " (literal)" : ""}${caseInsensitive ? " (case-insensitive)" : ""}`,
    `Replace: ${replacement}`,
    "",
  ];

  for (const fm of fileMatches.slice(0, 30)) {
    output.push(`${fm.relativePath} (${fm.totalReplacements} replacement${fm.totalReplacements === 1 ? "" : "s"}):`);
    for (const m of fm.matches.slice(0, 5)) {
      output.push(`  L${m.line}: ${m.before}`);
      output.push(`     → ${m.after}`);
    }
    if (fm.matches.length > 5) {
      output.push(`  ... +${fm.matches.length - 5} more lines`);
    }
    output.push("");
  }

  if (fileMatches.length > 30) {
    output.push(`... +${fileMatches.length - 30} more files`);
  }

  // Apply changes if not dry run — use stored content (TOCTOU safe)
  if (!dryRun) {
    let applied = 0;
    const errors: string[] = [];
    // Track successfully written files for rollback
    const written: Array<{ file: string; originalContent: string }> = [];

    for (const fm of fileMatches) {
      try {
        regex.lastIndex = 0;
        const updated = fm.originalContent.replace(regex, replacement);
        writeFileSync(fm.file, updated, "utf-8");
        written.push({ file: fm.file, originalContent: fm.originalContent });
        applied++;
      } catch (err) {
        // Rollback all previously written files
        for (const prev of written) {
          try {
            writeFileSync(prev.file, prev.originalContent, "utf-8");
          } catch { /* best-effort rollback */ }
        }
        errors.push(`${fm.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
        errors.push(`Rolled back ${written.length} previously modified file(s) due to write failure.`);
        // Override the summary line to reflect rollback
        output[0] = `Rollback complete — 0 files modified`;
        break; // Stop processing after rollback
      }
    }

    if (errors.length > 0) {
      output.push(`Errors (${errors.length}):`);
      for (const e of errors) output.push(`  ${e}`);
    }
  } else {
    output.push("Set dry_run=false to apply these changes.");
  }

  return { tool_use_id: "", content: output.join("\n") };
}
