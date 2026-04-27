// KCode - Hunk Operations
// Immutable operations for accepting, rejecting, modifying, splitting, and merging diff hunks.

import type { DiffHunk } from "./types.js";

/**
 * Mark a single hunk as accepted.
 * Returns a new array with the updated hunk.
 */
export function acceptHunk(hunks: DiffHunk[], id: string): DiffHunk[] {
  return hunks.map((h) => (h.id === id ? { ...h, status: "accepted" as const } : h));
}

/**
 * Mark a single hunk as rejected.
 * Returns a new array with the updated hunk.
 */
export function rejectHunk(hunks: DiffHunk[], id: string): DiffHunk[] {
  return hunks.map((h) => (h.id === id ? { ...h, status: "rejected" as const } : h));
}

/**
 * Modify a hunk's added lines and mark it as modified.
 * The original removed lines remain unchanged; only the replacement (added) lines are updated.
 */
export function modifyHunk(hunks: DiffHunk[], id: string, newLines: string[]): DiffHunk[] {
  return hunks.map((h) =>
    h.id === id ? { ...h, linesAdded: [...newLines], status: "modified" as const } : h,
  );
}

/**
 * Mark all hunks as accepted.
 */
export function acceptAll(hunks: DiffHunk[]): DiffHunk[] {
  return hunks.map((h) => ({ ...h, status: "accepted" as const }));
}

/**
 * Mark all hunks as rejected.
 */
export function rejectAll(hunks: DiffHunk[]): DiffHunk[] {
  return hunks.map((h) => ({ ...h, status: "rejected" as const }));
}

/**
 * Compute aggregate stats for a set of hunks.
 */
export function getStats(hunks: DiffHunk[]): {
  accepted: number;
  rejected: number;
  pending: number;
  modified: number;
} {
  let accepted = 0;
  let rejected = 0;
  let pending = 0;
  let modified = 0;
  for (const h of hunks) {
    switch (h.status) {
      case "accepted":
        accepted++;
        break;
      case "rejected":
        rejected++;
        break;
      case "pending":
        pending++;
        break;
      case "modified":
        modified++;
        break;
    }
  }
  return { accepted, rejected, pending, modified };
}

/**
 * Split a hunk into two at the specified line offset within its added lines.
 * The `splitAtLine` is the 0-based index in `linesAdded` where the second hunk begins.
 * For deletion/modification hunks, the removed lines are split proportionally
 * based on the split position relative to the added lines count.
 *
 * Returns a new array with the original hunk replaced by two new hunks.
 */
export function splitHunk(hunks: DiffHunk[], id: string, splitAtLine: number): DiffHunk[] {
  const idx = hunks.findIndex((h) => h.id === id);
  if (idx === -1) return hunks;

  // findIndex returned a valid index above, so hunks[idx] is defined.
  const hunk = hunks[idx]!;

  // Validate split position
  const totalLines = Math.max(hunk.linesAdded.length, hunk.linesRemoved.length);
  if (splitAtLine <= 0 || splitAtLine >= totalLines) return hunks;

  // Split removed lines proportionally
  const removedSplit = Math.min(splitAtLine, hunk.linesRemoved.length);
  const addedSplit = Math.min(splitAtLine, hunk.linesAdded.length);

  const firstRemoved = hunk.linesRemoved.slice(0, removedSplit);
  const secondRemoved = hunk.linesRemoved.slice(removedSplit);
  const firstAdded = hunk.linesAdded.slice(0, addedSplit);
  const secondAdded = hunk.linesAdded.slice(addedSplit);

  const determineType = (removed: string[], added: string[]): DiffHunk["type"] => {
    if (removed.length > 0 && added.length > 0) return "modification";
    if (added.length > 0) return "addition";
    return "deletion";
  };

  const first: DiffHunk = {
    id: crypto.randomUUID(),
    startLineOld: hunk.startLineOld,
    endLineOld: hunk.startLineOld + Math.max(0, firstRemoved.length - 1),
    startLineNew: hunk.startLineNew,
    endLineNew: hunk.startLineNew + Math.max(0, firstAdded.length - 1),
    linesRemoved: firstRemoved,
    linesAdded: firstAdded,
    context: { before: [...hunk.context.before], after: [] },
    status: hunk.status,
    type: determineType(firstRemoved, firstAdded),
  };

  const second: DiffHunk = {
    id: crypto.randomUUID(),
    startLineOld: hunk.startLineOld + removedSplit,
    endLineOld: hunk.endLineOld,
    startLineNew: hunk.startLineNew + addedSplit,
    endLineNew: hunk.endLineNew,
    linesRemoved: secondRemoved,
    linesAdded: secondAdded,
    context: { before: [], after: [...hunk.context.after] },
    status: hunk.status,
    type: determineType(secondRemoved, secondAdded),
  };

  const result = [...hunks];
  result.splice(idx, 1, first, second);
  return result;
}

/**
 * Merge multiple adjacent hunks into a single hunk.
 * The hunks specified by `ids` must be adjacent (no other hunks between them).
 * They are combined in order of their appearance in the array.
 *
 * Returns a new array with the merged hunk replacing the originals.
 */
export function mergeHunks(hunks: DiffHunk[], ids: string[]): DiffHunk[] {
  if (ids.length < 2) return hunks;

  const idSet = new Set(ids);
  const indices = hunks
    .map((h, i) => (idSet.has(h.id) ? i : -1))
    .filter((i) => i !== -1)
    .sort((a, b) => a - b);

  if (indices.length < 2) return hunks;

  // Verify adjacency: indices must be consecutive
  for (let i = 1; i < indices.length; i++) {
    if (indices[i]! !== indices[i - 1]! + 1) {
      return hunks; // Not adjacent, no-op
    }
  }

  // indices was built from hunks.map((h, i) => …) above so every index
  // is in-bounds — hunks[i] is always defined.
  const toMerge = indices.map((i) => hunks[i]!);
  const allRemoved = toMerge.flatMap((h) => h.linesRemoved);
  const allAdded = toMerge.flatMap((h) => h.linesAdded);

  let type: DiffHunk["type"];
  if (allRemoved.length > 0 && allAdded.length > 0) type = "modification";
  else if (allAdded.length > 0) type = "addition";
  else type = "deletion";

  // toMerge is non-empty because indices.length >= 2 was guarded above.
  const first = toMerge[0]!;
  const last = toMerge[toMerge.length - 1]!;
  const merged: DiffHunk = {
    id: crypto.randomUUID(),
    startLineOld: first.startLineOld,
    endLineOld: last.endLineOld,
    startLineNew: first.startLineNew,
    endLineNew: last.endLineNew,
    linesRemoved: allRemoved,
    linesAdded: allAdded,
    context: {
      before: [...first.context.before],
      after: [...last.context.after],
    },
    status: "pending",
    type,
  };

  const result = [...hunks];
  result.splice(indices[0]!, indices.length, merged);
  return result;
}
