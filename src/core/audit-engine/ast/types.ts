// KCode - AST-based pattern types (v2.10.336)
//
// Tree-sitter integration sits alongside the regex pattern library.
// Same Candidate output shape, different upstream: regex matches
// raw text, AST matches concrete syntax tree nodes after parsing.
//
// Why AST when regex already works? Three classes of bugs that
// regex genuinely can't catch:
//
//   1. Taint flow — `pickle.loads(x)` is dangerous only when x is
//      reachable from a function parameter / request argument. Regex
//      sees the call site; AST traces the assignment chain.
//
//   2. Mitigation absence in the SAME function — "loop indexing
//      m_count without an FW_ASSERT(idx < m_max) ABOVE in the
//      configure() of the same class". Regex needs negative-lookahead
//      gymnastics that don't compose; AST queries the class body.
//
//   3. Type-system invariants — a C++ `reinterpret_cast<T*>(buf)` is
//      safer than the regex thinks if `buf` was earlier static_cast'd
//      from a checked-size source. AST sees the cast chain.
//
// Phase 2 deliverable. Initial drop ships the contract + lazy
// runner; grammars and concrete patterns land incrementally.

import type { BugPattern, Candidate, Language, Severity } from "../types";

export interface AstPattern {
  /** Stable unique ID. Same convention as regex BugPattern. */
  id: string;
  title: string;
  severity: Severity;
  languages: Language[];
  /**
   * Tree-sitter S-expression query. Captures are named with `@name`
   * and consumed by the match function. Example for Python eval()
   * with a function-parameter argument:
   *
   *     (call
   *       function: (identifier) @fn (#eq? @fn "eval")
   *       arguments: (argument_list (identifier) @arg))
   */
  query: string;
  /**
   * Post-process captured nodes into a Candidate or null (false
   * match). Receives the captures map plus the source text + a
   * minimal AST-node interface so taint-style follow-up traversals
   * are possible.
   */
  match(
    captures: Record<string, AstCapture[]>,
    source: string,
    file: string,
  ): Candidate | null;
  explanation: string;
  verify_prompt: string;
  cwe?: string;
  fix_template?: string;
  /**
   * Vendible pack the pattern belongs to. Same taxonomy as
   * BugPattern.pack — see types.ts for the stable name list.
   * v2.10.370 (F9 of audit product plan).
   */
  pack?: import("../types").PatternPack;
}

/** Subset of tree-sitter Node we depend on — keeps the contract tiny. */
export interface AstCapture {
  /** Capture name without the leading `@`. */
  name: string;
  /** The matched node. */
  node: AstNode;
}

export interface AstNode {
  /** 0-based byte offset of the start of the node in source. */
  startIndex: number;
  endIndex: number;
  /** 0-based row + column for both endpoints. */
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  /** Tree-sitter node type, e.g. "call", "identifier". */
  type: string;
  /** Number of named children (excludes anonymous/punctuation). */
  namedChildCount: number;
  /** Index a named child or return null. */
  namedChild(i: number): AstNode | null;
  /** Walk up to the parent or null at root. */
  parent: AstNode | null;
  /** Source text of this node — used by match() for taint inspection. */
  text: string;
}

/** Telemetry from one AST pattern application. */
export interface AstScanStats {
  pattern_id: string;
  /** Total query matches before match() filtering. */
  raw_matches: number;
  /** Candidates emitted (after match() returned non-null). */
  candidates: number;
  /** Whether the grammar was loaded successfully on this run. */
  grammar_loaded: boolean;
  /** Surfaced reason if grammar_loaded === false. */
  load_error?: string;
  /**
   * tree-sitter language key the runner attempted (e.g. "python").
   * Lets aggregators report grammar status per language instead of
   * per pattern. Optional for backwards compat. v2.10.339.
   */
  language?: string;
}

/**
 * Runtime hook: callers wire this into scanProject so AST candidates
 * end up in the same pool as regex candidates. Mirrors the regex
 * surface (BugPattern → Candidate[]).
 */
export type AstRunner = (
  patterns: AstPattern[],
  file: string,
  content: string,
) => Promise<{ candidates: Candidate[]; stats: AstScanStats[] }>;

// Keep an unused reference so the import doesn't trip lint. Real
// callers pull BugPattern from "../types".
export type _BugPatternRef = BugPattern;
