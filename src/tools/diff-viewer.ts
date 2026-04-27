// KCode - Diff Viewer Tool
// Compare two files or show git diff for a file with colored unified output

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatDiffPreview, generateDiff } from "../core/diff";
import type { ToolDefinition, ToolResult } from "../core/types";

export const diffViewerDefinition: ToolDefinition = {
  name: "DiffView",
  description:
    "Show a visual diff between two files, or show the git diff for a file. " +
    "Use mode='files' to compare two files, or mode='git' to show uncommitted changes for a file.",
  input_schema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["files", "git"],
        description:
          "Diff mode: 'files' to compare two files, 'git' to show git diff for a file (default: git)",
      },
      file_a: {
        type: "string",
        description:
          "First file path (for mode='files') or the file to show git diff for (for mode='git')",
      },
      file_b: {
        type: "string",
        description: "Second file path (only for mode='files')",
      },
      context_lines: {
        type: "number",
        description: "Number of context lines around changes (default: 3)",
      },
      staged: {
        type: "boolean",
        description: "For mode='git': show staged changes instead of unstaged (default: false)",
      },
    },
    required: ["file_a"],
  },
};

export async function executeDiffViewer(input: Record<string, unknown>): Promise<ToolResult> {
  const mode = String(input.mode ?? "git").trim();
  const fileA = String(input.file_a ?? "").trim();
  const contextLines = Math.max(0, Math.min(20, Number(input.context_lines ?? 3)));

  if (!fileA) {
    return { tool_use_id: "", content: "Error: file_a is required.", is_error: true };
  }

  if (mode === "files") {
    return diffFiles(fileA, String(input.file_b ?? "").trim(), contextLines);
  }

  return diffGit(fileA, input.staged === true, contextLines);
}

function diffFiles(fileA: string, fileB: string, _contextLines: number): ToolResult {
  if (!fileB) {
    return {
      tool_use_id: "",
      content: "Error: file_b is required for mode='files'.",
      is_error: true,
    };
  }

  const resolvedA = resolve(fileA);
  const resolvedB = resolve(fileB);

  if (!existsSync(resolvedA)) {
    return { tool_use_id: "", content: `Error: File not found: ${resolvedA}`, is_error: true };
  }
  if (!existsSync(resolvedB)) {
    return { tool_use_id: "", content: `Error: File not found: ${resolvedB}`, is_error: true };
  }

  try {
    const contentA = readFileSync(resolvedA, "utf-8");
    const contentB = readFileSync(resolvedB, "utf-8");

    if (contentA === contentB) {
      return { tool_use_id: "", content: "Files are identical." };
    }

    const diffLines = generateDiff(contentA, contentB, `${fileA} → ${fileB}`);
    const formatted = formatDiffPreview(diffLines, 200);

    const statsA = contentA.split("\n").length;
    const statsB = contentB.split("\n").length;
    const added = diffLines.filter((l) => l.type === "add").length;
    const removed = diffLines.filter((l) => l.type === "remove").length;

    return {
      tool_use_id: "",
      content: [
        `Diff: ${fileA} (${statsA} lines) → ${fileB} (${statsB} lines)`,
        `Changes: +${added} -${removed}`,
        "",
        formatted,
      ].join("\n"),
    };
  } catch (err) {
    return {
      tool_use_id: "",
      content: `Error reading files: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
    };
  }
}

function diffGit(file: string, staged: boolean, contextLines: number): ToolResult {
  const resolvedFile = resolve(file);

  // Reject shell metacharacters in file path
  if (/[;|&`$(){}[\]<>!\n\r]/.test(resolvedFile)) {
    return {
      tool_use_id: "",
      content: "Error: file path contains invalid characters.",
      is_error: true,
    };
  }

  const flag = staged ? "--cached" : "";

  try {
    const cmd = `git diff ${flag} -U${contextLines} -- "${resolvedFile}"`;
    const output = execSync(cmd, {
      cwd: process.cwd(),
      stdio: "pipe",
      timeout: 10000,
    }).toString();

    if (!output.trim()) {
      return {
        tool_use_id: "",
        content: staged
          ? `No staged changes for ${file}.`
          : `No unstaged changes for ${file}. Try staged=true for staged changes.`,
      };
    }

    // Count additions and deletions
    const lines = output.split("\n");
    const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;

    return {
      tool_use_id: "",
      content: [
        `Git diff${staged ? " (staged)" : ""}: ${file}`,
        `Changes: +${added} -${removed}`,
        "",
        output,
      ].join("\n"),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not a git repository")) {
      return { tool_use_id: "", content: "Error: Not in a git repository.", is_error: true };
    }
    // git diff returns exit code 1 when there are differences — handle gracefully
    if (msg.includes("Command failed") && msg.includes("git diff")) {
      try {
        // Sanitize inputs to prevent shell injection
        const safeFile = resolvedFile.replace(/["`$\\]/g, "");
        const safeCtx = String(Math.min(Math.max(parseInt(String(contextLines)) || 3, 0), 100));
        const result = execSync(`git diff ${flag} -U${safeCtx} -- "${safeFile}" 2>&1 || true`, {
          cwd: process.cwd(),
          stdio: "pipe",
          timeout: 10000,
        }).toString();
        return { tool_use_id: "", content: result || `No changes for ${file}.` };
      } catch {
        return { tool_use_id: "", content: `No changes for ${file}.` };
      }
    }
    return {
      tool_use_id: "",
      content: `Error running git diff: ${msg}`,
      is_error: true,
    };
  }
}
