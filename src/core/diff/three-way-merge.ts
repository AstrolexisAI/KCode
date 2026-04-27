// KCode - Three-Way Merge
// Merges concurrent edits (ours + theirs) against a common base using the diff engine.
// Auto-resolves non-overlapping changes; generates MergeConflict for overlaps.

import { DiffEngine } from "./engine.js";
import type { MergeConflict, MergeResult } from "./types.js";

/**
 * Represents a change region from one side of the merge.
 */
interface ChangeRegion {
  /** 0-based start line in the base */
  startBase: number;
  /** 0-based end line in the base (exclusive) */
  endBase: number;
  /** Replacement lines for this region */
  lines: string[];
  /** Origin: "ours" or "theirs" */
  side: "ours" | "theirs";
}

/**
 * Three-way merge engine for handling concurrent edits to the same file.
 */
export class ThreeWayMerge {
  private diffEngine: DiffEngine;

  constructor() {
    this.diffEngine = new DiffEngine();
  }

  /**
   * Perform a three-way merge of base, ours, and theirs.
   *
   * 1. Diff base vs ours to find our changes
   * 2. Diff base vs theirs to find their changes
   * 3. Check for overlapping regions
   * 4. Auto-merge non-overlapping, create conflicts for overlapping
   */
  merge(base: string, ours: string, theirs: string): MergeResult {
    const baseLines = splitLines(base);

    const ourDiff = this.diffEngine.diff(base, ours, "ours");
    const theirDiff = this.diffEngine.diff(base, theirs, "theirs");

    // Convert hunks to change regions (0-based, exclusive end)
    const ourRegions: ChangeRegion[] = ourDiff.hunks.map((h) => ({
      startBase: h.startLineOld - 1,
      endBase: h.startLineOld - 1 + h.linesRemoved.length,
      lines: h.linesAdded,
      side: "ours",
    }));

    const theirRegions: ChangeRegion[] = theirDiff.hunks.map((h) => ({
      startBase: h.startLineOld - 1,
      endBase: h.startLineOld - 1 + h.linesRemoved.length,
      lines: h.linesAdded,
      side: "theirs",
    }));

    // Sort all regions by startBase
    const allRegions = [...ourRegions, ...theirRegions].sort(
      (a, b) => a.startBase - b.startBase || (a.side === "ours" ? -1 : 1),
    );

    // Find overlapping pairs and group them
    const conflicts: MergeConflict[] = [];
    const autoResolvable: ChangeRegion[] = [];
    const conflictedRegionIds = new Set<number>();

    for (let i = 0; i < allRegions.length; i++) {
      if (conflictedRegionIds.has(i)) continue;

      // i and j are in-bounds via the loop conditions, so allRegions[i]
      // and allRegions[j] are always defined.
      const regionA = allRegions[i]!;
      let hasConflict = false;

      for (let j = i + 1; j < allRegions.length; j++) {
        if (conflictedRegionIds.has(j)) continue;

        const regionB = allRegions[j]!;

        // If regionB starts beyond regionA, no more overlaps possible
        if (regionB.startBase >= regionA.endBase && regionA.endBase > regionA.startBase) {
          break;
        }

        if (regionA.side === regionB.side) continue;

        if (
          rangesOverlap([regionA.startBase, regionA.endBase], [regionB.startBase, regionB.endBase])
        ) {
          // Check if the changes are identical - if so, auto-resolve
          if (arraysEqual(regionA.lines, regionB.lines)) {
            // Same change on both sides, treat as auto-resolvable
            conflictedRegionIds.add(j);
            continue;
          }

          hasConflict = true;
          conflictedRegionIds.add(i);
          conflictedRegionIds.add(j);

          const ourRegion = regionA.side === "ours" ? regionA : regionB;
          const theirRegion = regionA.side === "theirs" ? regionA : regionB;

          const conflictStart = Math.min(ourRegion.startBase, theirRegion.startBase);
          const conflictEnd = Math.max(ourRegion.endBase, theirRegion.endBase);

          conflicts.push({
            id: crypto.randomUUID(),
            startLine: conflictStart + 1, // 1-based
            endLine: Math.max(conflictStart + 1, conflictEnd), // 1-based
            ours: ourRegion.lines,
            theirs: theirRegion.lines,
            base: baseLines.slice(conflictStart, conflictEnd),
          });
        }
      }

      if (!hasConflict && !conflictedRegionIds.has(i)) {
        autoResolvable.push(regionA);
      }
    }

    // Build merged content
    const content = this.buildMergedContent(baseLines, autoResolvable, conflicts);

    return {
      content,
      conflicts,
      autoResolved: autoResolvable.length,
    };
  }

  /**
   * Resolve a specific conflict within a merge result.
   * Returns a new MergeResult with the conflict updated.
   */
  resolveConflict(
    result: MergeResult,
    conflictId: string,
    resolution: MergeConflict["resolution"],
    customContent?: string,
  ): MergeResult {
    const updatedConflicts = result.conflicts.map((c) => {
      if (c.id !== conflictId) return c;
      return {
        ...c,
        resolution,
        customContent: resolution === "custom" ? customContent : undefined,
      };
    });

    return {
      ...result,
      conflicts: updatedConflicts,
      content: result.content, // Content is regenerated by applyResolutions
    };
  }

  /**
   * Generate final merged content with all conflicts resolved.
   * Unresolved conflicts are left with conflict markers.
   */
  applyResolutions(result: MergeResult): string {
    let content = result.content;

    for (const conflict of result.conflicts) {
      const marker = buildConflictMarker(conflict);

      if (conflict.resolution) {
        let replacement: string;
        switch (conflict.resolution) {
          case "ours":
            replacement = conflict.ours.join("\n");
            break;
          case "theirs":
            replacement = conflict.theirs.join("\n");
            break;
          case "both":
            replacement = [...conflict.ours, ...conflict.theirs].join("\n");
            break;
          case "custom":
            replacement = conflict.customContent ?? "";
            break;
          default:
            replacement = marker;
        }
        content = content.replace(marker, replacement);
      }
    }

    return content;
  }

  /**
   * Build the merged content from base, auto-resolved regions, and conflicts.
   */
  private buildMergedContent(
    baseLines: string[],
    autoResolved: ChangeRegion[],
    conflicts: MergeConflict[],
  ): string {
    // Build a line-by-line plan
    type Segment =
      | { type: "base"; start: number; end: number }
      | { type: "replace"; lines: string[] }
      | { type: "conflict"; conflict: MergeConflict };

    const segments: Segment[] = [];

    // Collect all regions that modify the base, sorted by start position
    const ops: Array<{
      start: number;
      end: number;
      segment: Segment;
    }> = [];

    for (const region of autoResolved) {
      ops.push({
        start: region.startBase,
        end: region.endBase,
        segment: { type: "replace", lines: region.lines },
      });
    }

    for (const conflict of conflicts) {
      const start = conflict.startLine - 1; // to 0-based
      const end = Math.max(start, conflict.endLine);
      ops.push({
        start,
        end,
        segment: { type: "conflict", conflict },
      });
    }

    ops.sort((a, b) => a.start - b.start);

    // Walk through base lines, inserting segments
    let baseIdx = 0;
    for (const op of ops) {
      // Copy unchanged base lines before this operation
      if (baseIdx < op.start) {
        segments.push({ type: "base", start: baseIdx, end: op.start });
      }
      segments.push(op.segment);
      baseIdx = Math.max(baseIdx, op.end);
    }

    // Copy remaining base lines
    if (baseIdx < baseLines.length) {
      segments.push({ type: "base", start: baseIdx, end: baseLines.length });
    }

    // Render segments to string
    const outputLines: string[] = [];
    for (const seg of segments) {
      switch (seg.type) {
        case "base":
          for (let i = seg.start; i < seg.end; i++) {
            outputLines.push(baseLines[i]!);
          }
          break;
        case "replace":
          outputLines.push(...seg.lines);
          break;
        case "conflict":
          outputLines.push(...buildConflictMarker(seg.conflict).split("\n"));
          break;
      }
    }

    return outputLines.join("\n");
  }
}

/**
 * Check if two ranges [start, end) overlap.
 * Ranges are half-open intervals: [start, end)
 * Adjacent ranges (a.end === b.start) also count as overlapping for merge purposes.
 */
export function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  // Handle zero-length ranges (pure insertions at same point)
  if (a[0] === a[1] && b[0] === b[1]) {
    return a[0] === b[0];
  }
  if (a[0] === a[1]) {
    return a[0] >= b[0] && a[0] < b[1];
  }
  if (b[0] === b[1]) {
    return b[0] >= a[0] && b[0] < a[1];
  }
  return a[0] < b[1] && b[0] < a[1];
}

/**
 * Build conflict marker text for an unresolved conflict.
 */
function buildConflictMarker(conflict: MergeConflict): string {
  const lines: string[] = [];
  lines.push("<<<<<<< OURS");
  lines.push(...conflict.ours);
  lines.push("=======");
  lines.push(...conflict.theirs);
  lines.push(">>>>>>> THEIRS");
  return lines.join("\n");
}

/**
 * Split text into lines, handling trailing newline.
 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Check if two string arrays have identical content.
 */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ─── Singleton ──────────────────────────────────────────────────

let instance: ThreeWayMerge | null = null;

export function getThreeWayMerge(): ThreeWayMerge {
  if (!instance) instance = new ThreeWayMerge();
  return instance;
}
