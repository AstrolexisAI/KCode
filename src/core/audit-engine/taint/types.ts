// KCode - Taint analysis types
//
// Lightweight intra-procedural variable-origin classifier for Java.
// Used by the audit engine to suppress regex-pattern candidates whose
// "tainted" variable can be proven constant or sanitized at the SAST
// pattern's match site, lifting precision without sacrificing recall.

export type VarOrigin = "tainted" | "constant" | "sanitized" | "unknown";

export interface ClassifyResult {
  origin: VarOrigin;
  reason: string;
  evidenceLine?: number;
}

export interface ClassifyContext {
  /** Cross-file constant lookup map for Phase 3. */
  filesInDir?: Map<string, string>;
  /** File content for in-classifier identifier resolution. */
  fileContent?: string;
  /** Line at which the current expression sits — used to scope
   *  variable walks (only assignments at or before this line). */
  currentLine?: number;
  /** Identifiers already resolved on this walk (cycle guard). */
  visited?: Set<string>;
  /** Recursion budget. */
  maxDepth?: number;
  /** Internal: current depth on this walk. */
  depth?: number;
}
