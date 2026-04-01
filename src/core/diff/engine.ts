// KCode - Diff Engine
// Myers diff algorithm implementation for computing line-level diffs.
// Produces structured DiffHunk arrays with context lines.

import type { DiffHunk, DiffResult } from "./types.js";

/** Number of context lines to include before/after each hunk */
const CONTEXT_LINES = 3;

/**
 * Edit operation type in the shortest edit script.
 */
const enum EditOp {
  Equal,
  Insert,
  Delete,
}

interface EditEntry {
  op: EditOp;
  oldIndex: number; // line index in original (-1 for inserts)
  newIndex: number; // line index in modified (-1 for deletes)
}

/**
 * Core diff engine using the Myers diff algorithm.
 * Produces structured hunks with context from two text inputs.
 */
export class DiffEngine {
  /**
   * Compute a structured diff between original and modified text.
   * @param original - The original file content
   * @param modified - The modified file content
   * @param filePath - Optional file path for the result metadata
   * @returns DiffResult with hunks and statistics
   */
  diff(original: string, modified: string, filePath = ""): DiffResult {
    const oldLines = splitLines(original);
    const newLines = splitLines(modified);

    const editScript = this.myersDiff(oldLines, newLines);
    const hunks = this.buildHunks(editScript, oldLines, newLines);

    let additions = 0;
    let deletions = 0;
    let modifications = 0;
    for (const h of hunks) {
      if (h.type === "addition") additions++;
      else if (h.type === "deletion") deletions++;
      else modifications++;
    }

    return { filePath, hunks, stats: { additions, deletions, modifications } };
  }

  /**
   * Apply only accepted/modified hunks to the original text and return the result.
   * Hunks with status 'rejected' or 'pending' are left as-is from the original.
   */
  applyHunks(original: string, hunks: DiffHunk[]): string {
    const oldLines = splitLines(original);
    const result: string[] = [];
    let oldIdx = 0;

    // Sort hunks by startLineOld ascending
    const sorted = [...hunks].sort((a, b) => a.startLineOld - b.startLineOld);

    for (const hunk of sorted) {
      if (hunk.status !== "accepted" && hunk.status !== "modified") {
        continue;
      }

      // Copy unchanged lines before this hunk
      const hunkStart = hunk.startLineOld - 1; // convert to 0-based
      while (oldIdx < hunkStart && oldIdx < oldLines.length) {
        result.push(oldLines[oldIdx]);
        oldIdx++;
      }

      // Apply the hunk: skip removed lines, add new lines
      if (hunk.status === "modified") {
        result.push(...hunk.linesAdded);
      } else {
        result.push(...hunk.linesAdded);
      }

      // Advance past the original lines covered by this hunk.
      // Use the hunk's line range (endLineOld - startLineOld + 1) rather than
      // linesRemoved.length, because merged hunks may span equal lines in between.
      const spannedLines = hunk.endLineOld - hunk.startLineOld + 1;
      if (hunk.linesRemoved.length > 0 || hunk.type === "modification") {
        oldIdx = hunk.startLineOld - 1 + spannedLines;
      } else {
        // Pure addition: don't skip any original lines
        // oldIdx stays the same
      }
    }

    // Copy remaining original lines
    while (oldIdx < oldLines.length) {
      result.push(oldLines[oldIdx]);
      oldIdx++;
    }

    return result.join("\n");
  }

  /**
   * Myers diff algorithm.
   * Returns an ordered list of edit operations (equal, insert, delete).
   */
  private myersDiff(oldLines: string[], newLines: string[]): EditEntry[] {
    const N = oldLines.length;
    const M = newLines.length;

    if (N === 0 && M === 0) return [];
    if (N === 0) {
      return newLines.map((_, i) => ({
        op: EditOp.Insert,
        oldIndex: -1,
        newIndex: i,
      }));
    }
    if (M === 0) {
      return oldLines.map((_, i) => ({
        op: EditOp.Delete,
        oldIndex: i,
        newIndex: -1,
      }));
    }

    const MAX = N + M;
    const size = 2 * MAX + 1;

    // V array maps diagonal k -> furthest reaching x on that diagonal
    // We store trace history for backtracking
    const trace: Int32Array[] = [];

    const V = new Int32Array(size);
    V.fill(-1);
    const offset = MAX;
    V[offset + 1] = 0;

    let found = false;
    outer: for (let d = 0; d <= MAX; d++) {
      const snapshot = new Int32Array(V);
      trace.push(snapshot);

      for (let k = -d; k <= d; k += 2) {
        let x: number;
        if (k === -d || (k !== d && V[offset + k - 1] < V[offset + k + 1])) {
          x = V[offset + k + 1]; // move down
        } else {
          x = V[offset + k - 1] + 1; // move right
        }

        let y = x - k;

        // Follow diagonal (equal lines)
        while (x < N && y < M && oldLines[x] === newLines[y]) {
          x++;
          y++;
        }

        V[offset + k] = x;

        if (x >= N && y >= M) {
          found = true;
          break outer;
        }
      }
    }

    if (!found) {
      // Should not happen with correct algorithm, but fall back
      return [
        ...oldLines.map((_, i) => ({
          op: EditOp.Delete as const,
          oldIndex: i,
          newIndex: -1,
        })),
        ...newLines.map((_, i) => ({
          op: EditOp.Insert as const,
          oldIndex: -1,
          newIndex: i,
        })),
      ];
    }

    // Backtrack to find the actual edit script
    return this.backtrack(trace, offset, N, M, oldLines, newLines);
  }

  /**
   * Backtrack through the Myers trace to produce an ordered edit script.
   */
  private backtrack(
    trace: Int32Array[],
    offset: number,
    N: number,
    M: number,
    oldLines: string[],
    newLines: string[],
  ): EditEntry[] {
    const edits: EditEntry[] = [];
    let x = N;
    let y = M;

    for (let d = trace.length - 1; d >= 0; d--) {
      const V = trace[d];
      const k = x - y;

      let prevK: number;
      if (k === -d || (k !== d && V[offset + k - 1] < V[offset + k + 1])) {
        prevK = k + 1;
      } else {
        prevK = k - 1;
      }

      const prevX = V[offset + prevK];
      const prevY = prevX - prevK;

      // Diagonal moves (equal lines)
      while (x > prevX && y > prevY) {
        x--;
        y--;
        edits.push({ op: EditOp.Equal, oldIndex: x, newIndex: y });
      }

      if (d > 0) {
        if (x === prevX) {
          // Moved down → insertion
          y--;
          edits.push({ op: EditOp.Insert, oldIndex: -1, newIndex: y });
        } else {
          // Moved right → deletion
          x--;
          edits.push({ op: EditOp.Delete, oldIndex: x, newIndex: -1 });
        }
      }
    }

    edits.reverse();
    return edits;
  }

  /**
   * Group edit operations into DiffHunks with context lines.
   */
  private buildHunks(
    editScript: EditEntry[],
    oldLines: string[],
    newLines: string[],
  ): DiffHunk[] {
    // Find runs of changes (non-Equal entries)
    const changeRanges: Array<{ start: number; end: number }> = [];
    let inChange = false;
    let rangeStart = 0;

    for (let i = 0; i < editScript.length; i++) {
      if (editScript[i].op !== EditOp.Equal) {
        if (!inChange) {
          rangeStart = i;
          inChange = true;
        }
      } else {
        if (inChange) {
          changeRanges.push({ start: rangeStart, end: i - 1 });
          inChange = false;
        }
      }
    }
    if (inChange) {
      changeRanges.push({ start: rangeStart, end: editScript.length - 1 });
    }

    if (changeRanges.length === 0) return [];

    // Merge change ranges that have overlapping context
    const mergedRanges: Array<{ start: number; end: number }> = [changeRanges[0]];
    for (let i = 1; i < changeRanges.length; i++) {
      const prev = mergedRanges[mergedRanges.length - 1];
      const curr = changeRanges[i];

      // Count equal entries between prev.end and curr.start
      let equalCount = 0;
      for (let j = prev.end + 1; j < curr.start; j++) {
        if (editScript[j].op === EditOp.Equal) equalCount++;
      }

      if (equalCount <= CONTEXT_LINES * 2) {
        // Merge: context lines would overlap
        prev.end = curr.end;
      } else {
        mergedRanges.push({ ...curr });
      }
    }

    // Build hunks from merged ranges
    const hunks: DiffHunk[] = [];
    for (const range of mergedRanges) {
      const removed: string[] = [];
      const added: string[] = [];
      let minOldIdx = Infinity;
      let maxOldIdx = -1;
      let minNewIdx = Infinity;
      let maxNewIdx = -1;

      for (let i = range.start; i <= range.end; i++) {
        const entry = editScript[i];
        if (entry.op === EditOp.Delete) {
          removed.push(oldLines[entry.oldIndex]);
          minOldIdx = Math.min(minOldIdx, entry.oldIndex);
          maxOldIdx = Math.max(maxOldIdx, entry.oldIndex);
        } else if (entry.op === EditOp.Insert) {
          added.push(newLines[entry.newIndex]);
          minNewIdx = Math.min(minNewIdx, entry.newIndex);
          maxNewIdx = Math.max(maxNewIdx, entry.newIndex);
        } else if (entry.op === EditOp.Equal) {
          // Equal lines inside a merged range act as intra-hunk context
          // Include them in both sides
          removed.push(oldLines[entry.oldIndex]);
          added.push(newLines[entry.newIndex]);
          minOldIdx = Math.min(minOldIdx, entry.oldIndex);
          maxOldIdx = Math.max(maxOldIdx, entry.oldIndex);
          minNewIdx = Math.min(minNewIdx, entry.newIndex);
          maxNewIdx = Math.max(maxNewIdx, entry.newIndex);
        }
      }

      // For pure additions, anchor to surrounding old lines
      if (minOldIdx === Infinity) {
        // Find nearest old index from surrounding edits
        for (let i = range.start - 1; i >= 0; i--) {
          if (editScript[i].oldIndex >= 0) {
            minOldIdx = editScript[i].oldIndex + 1;
            maxOldIdx = minOldIdx - 1; // empty range
            break;
          }
        }
        if (minOldIdx === Infinity) {
          minOldIdx = 0;
          maxOldIdx = -1;
        }
      }
      if (minNewIdx === Infinity) {
        for (let i = range.start - 1; i >= 0; i--) {
          if (editScript[i].newIndex >= 0) {
            minNewIdx = editScript[i].newIndex + 1;
            maxNewIdx = minNewIdx - 1;
            break;
          }
        }
        if (minNewIdx === Infinity) {
          minNewIdx = 0;
          maxNewIdx = -1;
        }
      }

      // Compute context
      const contextBefore: string[] = [];
      const contextAfter: string[] = [];
      for (let i = Math.max(0, minOldIdx - CONTEXT_LINES); i < minOldIdx; i++) {
        contextBefore.push(oldLines[i]);
      }
      for (
        let i = maxOldIdx + 1;
        i < Math.min(oldLines.length, maxOldIdx + 1 + CONTEXT_LINES);
        i++
      ) {
        contextAfter.push(oldLines[i]);
      }

      // Determine type
      // Filter out intra-hunk equal lines to determine true removals/additions
      const pureRemoved: string[] = [];
      const pureAdded: string[] = [];
      for (let i = range.start; i <= range.end; i++) {
        const entry = editScript[i];
        if (entry.op === EditOp.Delete) pureRemoved.push(oldLines[entry.oldIndex]);
        else if (entry.op === EditOp.Insert) pureAdded.push(newLines[entry.newIndex]);
      }

      let type: DiffHunk["type"];
      if (pureRemoved.length > 0 && pureAdded.length > 0) type = "modification";
      else if (pureAdded.length > 0) type = "addition";
      else type = "deletion";

      hunks.push({
        id: crypto.randomUUID(),
        startLineOld: minOldIdx + 1, // convert to 1-based
        endLineOld: Math.max(minOldIdx + 1, maxOldIdx + 1),
        startLineNew: minNewIdx + 1,
        endLineNew: Math.max(minNewIdx + 1, maxNewIdx + 1),
        linesRemoved: pureRemoved,
        linesAdded: pureAdded,
        context: { before: contextBefore, after: contextAfter },
        status: "pending",
        type,
      });
    }

    return hunks;
  }
}

/**
 * Split text into lines. Handles trailing newline gracefully.
 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // Remove trailing empty element from final newline
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

// ─── Singleton ──────────────────────────────────────────────────

let instance: DiffEngine | null = null;

export function getDiffEngine(): DiffEngine {
  if (!instance) instance = new DiffEngine();
  return instance;
}
