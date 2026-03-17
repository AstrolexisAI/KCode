// KCode - Edit Tool
// Performs exact string replacements in files with visual diff output

import { readFileSync, writeFileSync } from "node:fs";
import type { ToolDefinition, ToolResult, FileEditInput } from "../core/types";

export const editDefinition: ToolDefinition = {
  name: "Edit",
  description: "Perform exact string replacement in a file. The old_string must be unique unless replace_all is true.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file" },
      old_string: { type: "string", description: "The exact text to find and replace" },
      new_string: { type: "string", description: "The replacement text" },
      replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
};

/**
 * Generate a compact visual diff showing what changed.
 * Shows removed lines (prefixed with -) and added lines (prefixed with +)
 * with surrounding context.
 */
function generateDiff(oldStr: string, newStr: string, filePath: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  const diffLines: string[] = [];

  // Find the first line where the actual change starts in the file
  // This is a simplified diff — just show old vs new
  if (oldLines.length <= 10 && newLines.length <= 10) {
    // Small edit: show full diff
    for (const line of oldLines) {
      diffLines.push(`  - ${line}`);
    }
    for (const line of newLines) {
      diffLines.push(`  + ${line}`);
    }
  } else {
    // Large edit: show summary
    const removedCount = oldLines.length;
    const addedCount = newLines.length;

    // Show first 3 and last 3 lines of each
    const showLines = (lines: string[], prefix: string) => {
      if (lines.length <= 6) {
        for (const line of lines) diffLines.push(`  ${prefix} ${line}`);
      } else {
        for (let i = 0; i < 3; i++) diffLines.push(`  ${prefix} ${lines[i]}`);
        diffLines.push(`  ${prefix} ... (${lines.length - 6} more lines)`);
        for (let i = lines.length - 3; i < lines.length; i++) diffLines.push(`  ${prefix} ${lines[i]}`);
      }
    };

    showLines(oldLines, "-");
    showLines(newLines, "+");
  }

  return diffLines.join("\n");
}

export async function executeEdit(input: Record<string, unknown>): Promise<ToolResult> {
  const { file_path, old_string, new_string, replace_all } = input as FileEditInput;

  try {
    const content = readFileSync(file_path, "utf-8");

    if (old_string === new_string) {
      return {
        tool_use_id: "",
        content: "Error: old_string and new_string are identical. STOP: Do NOT retry this Edit. If the file already contains the desired content, no edit is needed. Move on to the next task.",
        is_error: true,
      };
    }

    const occurrences = content.split(old_string).length - 1;

    if (occurrences === 0) {
      return {
        tool_use_id: "",
        content: `Error: old_string not found in ${file_path}`,
        is_error: true,
      };
    }

    if (occurrences > 1 && !replace_all) {
      return {
        tool_use_id: "",
        content: `Error: old_string found ${occurrences} times. Use replace_all=true to replace all, or provide more context to make it unique.`,
        is_error: true,
      };
    }

    const updated = replace_all ? content.replaceAll(old_string, new_string) : content.replace(old_string, new_string);

    writeFileSync(file_path, updated, "utf-8");

    // Find the line number where the change starts
    const beforeChange = content.indexOf(old_string);
    const lineNumber = content.slice(0, beforeChange).split("\n").length;

    const replacements = replace_all ? occurrences : 1;
    const diff = generateDiff(old_string, new_string, file_path);
    const linesChanged = new_string.split("\n").length - old_string.split("\n").length;
    const linesDelta = linesChanged > 0 ? `+${linesChanged}` : linesChanged === 0 ? "±0" : `${linesChanged}`;

    return {
      tool_use_id: "",
      content: `Edited ${file_path}:${lineNumber} (${replacements} replacement${replacements > 1 ? "s" : ""}, ${linesDelta} lines)\n${diff}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      tool_use_id: "",
      content: `Error editing file: ${msg}`,
      is_error: true,
    };
  }
}
