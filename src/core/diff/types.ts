// KCode - Visual Diff/Merge Type Definitions
// Core interfaces for the diff engine, hunk operations, and three-way merge system.

/**
 * Represents a single hunk of changes between two versions of a file.
 * Each hunk contains removed/added lines plus surrounding context.
 */
export interface DiffHunk {
  /** Unique identifier for this hunk */
  id: string;
  /** Start line in the original file (1-based) */
  startLineOld: number;
  /** End line in the original file (1-based, inclusive) */
  endLineOld: number;
  /** Start line in the modified file (1-based) */
  startLineNew: number;
  /** End line in the modified file (1-based, inclusive) */
  endLineNew: number;
  /** Lines removed from the original */
  linesRemoved: string[];
  /** Lines added in the modified version */
  linesAdded: string[];
  /** Context lines surrounding the change */
  context: { before: string[]; after: string[] };
  /** Review status of this hunk */
  status: "pending" | "accepted" | "rejected" | "modified";
  /** Type of change: addition-only, deletion-only, or modification (both) */
  type: "addition" | "deletion" | "modification";
}

/**
 * Result of diffing two versions of a file.
 */
export interface DiffResult {
  /** Path of the file being diffed */
  filePath: string;
  /** Array of change hunks */
  hunks: DiffHunk[];
  /** Aggregate statistics */
  stats: { additions: number; deletions: number; modifications: number };
}

/**
 * Represents a merge conflict between two sets of changes applied to a common base.
 */
export interface MergeConflict {
  /** Unique identifier for this conflict */
  id: string;
  /** Start line in the base file (1-based) */
  startLine: number;
  /** End line in the base file (1-based, inclusive) */
  endLine: number;
  /** Lines from our version */
  ours: string[];
  /** Lines from their version */
  theirs: string[];
  /** Lines from the base version */
  base: string[];
  /** How the conflict was resolved */
  resolution?: "ours" | "theirs" | "both" | "custom";
  /** Custom resolution content (when resolution === 'custom') */
  customContent?: string;
}

/**
 * Result of a three-way merge operation.
 */
export interface MergeResult {
  /** The merged content (may contain conflict markers if unresolved) */
  content: string;
  /** Array of conflicts found during merge */
  conflicts: MergeConflict[];
  /** Number of non-overlapping changes that were automatically merged */
  autoResolved: number;
}
