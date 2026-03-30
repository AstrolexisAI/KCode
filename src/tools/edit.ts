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

/**
 * Compute character-level similarity between two strings (0 to 1).
 * Uses a simple ratio of matching characters to total length.
 */
function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  // Cap comparison length to avoid perf issues on minified/long lines
  const capA = a.length > 500 ? a.slice(0, 500) : a;
  const capB = b.length > 500 ? b.slice(0, 500) : b;
  const maxLen = Math.max(capA.length, capB.length);
  if (maxLen === 0) return 1;
  const minLen = Math.min(capA.length, capB.length);
  let matches = 0;
  for (let i = 0; i < minLen; i++) {
    if (capA[i] === capB[i]) matches++;
  }
  return matches / maxLen;
}

/**
 * Find the closest matching substring in the file content when old_string is not found.
 * Compares line-by-line similarity for candidate blocks of the same line count.
 * Returns the best match and its similarity score, or null if nothing is close enough.
 */
function findClosestMatch(
  content: string,
  oldString: string,
  threshold = 0.6,
): { match: string; similarity: number; lineNumber: number } | null {
  const oldLines = oldString.split("\n");
  const oldLineCount = oldLines.length;
  const fileLines = content.split("\n");
  const searchLines = fileLines.slice(0, 2000);
  const candidateCount = searchLines.length - oldLineCount + 1;

  if (candidateCount <= 0) return null;

  let bestScore = 0;
  let bestIndex = 0;

  for (let i = 0; i < candidateCount; i++) {
    let totalSim = 0;
    for (let j = 0; j < oldLineCount; j++) {
      totalSim += lineSimilarity(oldLines[j]!, searchLines[i + j]!);
    }
    const avgSim = totalSim / oldLineCount;
    if (avgSim > bestScore) {
      bestScore = avgSim;
      bestIndex = i;
    }
  }

  if (bestScore < threshold) return null;

  const matchLines = searchLines.slice(bestIndex, bestIndex + oldLineCount);
  return {
    match: matchLines.join("\n"),
    similarity: Math.round(bestScore * 100),
    lineNumber: bestIndex + 1,
  };
}

export async function executeEdit(input: Record<string, unknown>): Promise<ToolResult> {
  const { file_path, old_string, new_string, replace_all } = input as unknown as FileEditInput;

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
      let errorMsg = `Error: old_string not found in ${file_path}`;
      const closest = findClosestMatch(content, old_string);
      if (closest) {
        errorMsg += `\n\nDid you mean this? (${closest.similarity}% similar, line ${closest.lineNumber}):\n\`\`\`\n${closest.match}\n\`\`\``;
      }
      return {
        tool_use_id: "",
        content: errorMsg,
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
      content: `Error editing "${file_path}": ${msg}`,
      is_error: true,
    };
  }
}
