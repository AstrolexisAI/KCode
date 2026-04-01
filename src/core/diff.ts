// KCode - Diff Preview Generator
// Simple line-by-line unified diff using longest common subsequence

// ─── Types ──────────────────────────────────────────────────────

export interface DiffLine {
  type: "context" | "add" | "remove" | "header";
  text: string;
}

// ─── LCS-based Diff ────────────────────────────────────────────

/**
 * Compute the longest common subsequence table for two arrays of lines.
 * Returns a 2D array where lcs[i][j] = length of LCS of oldLines[0..i-1] and newLines[0..j-1].
 */
function computeLcsTable(oldLines: string[], newLines: string[]): number[][] {
  const m = oldLines.length;
  const n = newLines.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    const row = table[i]!;
    const prevRow = table[i - 1]!;
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        row[j] = prevRow[j - 1]! + 1;
      } else {
        row[j] = Math.max(prevRow[j]!, row[j - 1]!);
      }
    }
  }

  return table;
}

/**
 * Backtrack through the LCS table to produce diff operations.
 */
function backtrackDiff(oldLines: string[], newLines: string[], table: number[][]): DiffLine[] {
  const result: DiffLine[] = [];
  let i = oldLines.length;
  let j = newLines.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: "context", text: ` ${oldLines[i - 1]}` });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || table[i]![j - 1]! >= table[i - 1]![j]!)) {
      result.push({ type: "add", text: `+${newLines[j - 1]}` });
      j--;
    } else if (i > 0) {
      result.push({ type: "remove", text: `-${oldLines[i - 1]}` });
      i--;
    }
  }

  return result.reverse();
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Generate a unified diff between old and new text content.
 *
 * @param oldText - The original file content
 * @param newText - The new/modified file content
 * @param filename - Optional filename to include in the diff header
 * @returns Array of DiffLine objects representing the diff
 */
export function generateDiff(oldText: string, newText: string, filename?: string): DiffLine[] {
  if (oldText === newText) {
    return [];
  }

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  const lines: DiffLine[] = [];

  // Add header
  const label = filename ?? "file";
  lines.push({ type: "header", text: `--- a/${label}` });
  lines.push({ type: "header", text: `+++ b/${label}` });

  const table = computeLcsTable(oldLines, newLines);
  const diffLines = backtrackDiff(oldLines, newLines, table);

  lines.push(...diffLines);

  return lines;
}

/**
 * Format diff lines into a human-readable string suitable for display.
 * Only includes lines that changed and a limited amount of context.
 *
 * @param diffLines - The diff lines from generateDiff
 * @param maxLines - Maximum number of lines to include (default 30)
 * @returns Formatted diff string
 */
export function formatDiffPreview(diffLines: DiffLine[], maxLines = 30): string {
  if (diffLines.length === 0) {
    return "(no changes)";
  }

  // Filter to show only changed lines with up to 2 lines of surrounding context
  const changedIndices = new Set<number>();
  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i]!;
    if (line.type === "add" || line.type === "remove" || line.type === "header") {
      changedIndices.add(i);
      // Add context lines around changes
      for (let c = Math.max(0, i - 2); c <= Math.min(diffLines.length - 1, i + 2); c++) {
        changedIndices.add(c);
      }
    }
  }

  const sortedIndices = Array.from(changedIndices).sort((a, b) => a - b);
  const output: string[] = [];
  let lastIndex = -1;

  for (const idx of sortedIndices) {
    if (output.length >= maxLines) {
      const remaining = sortedIndices.length - sortedIndices.indexOf(idx);
      output.push(`... (${remaining} more lines)`);
      break;
    }

    // Add separator for non-contiguous sections
    if (lastIndex !== -1 && idx > lastIndex + 1) {
      output.push("...");
    }

    output.push(diffLines[idx]!.text);
    lastIndex = idx;
  }

  return output.join("\n");
}
