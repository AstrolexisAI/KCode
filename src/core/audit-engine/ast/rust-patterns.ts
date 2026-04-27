// KCode - AST patterns for Rust (v2.10.348)
//
// Two patterns covering the dominant Rust sinks where caller-
// controlled input is the ballgame:
//
//   rust-ast-001  std::process::Command::new(p) of a parameter
//                 (CWE-78 command injection)
//   rust-ast-002  std::fs file/path operations of a parameter
//                 (CWE-22 path traversal)
//
// Note: Rust's type system + ownership prevents many classes of bugs
// that the C/C++ patterns target (no buffer overflow primitive,
// strict lifetime checking). The remaining sinks are at the std-
// library boundary — process spawning, fs access, deserialization
// (serde_yaml::from_str etc.) — and unsafe blocks.
//
// Node-type shapes (verified empirically against tree-sitter-rust@0.24):
//   functions          function_item with `parameters` of `parameter`
//                      nodes (each: identifier + type)
//   closures           closure_expression with `closure_parameters`
//                      containing identifier or parameter nodes
//   call expressions   call_expression with function: scoped_identifier
//                      OR field_expression (for method calls)
//   scoped paths       scoped_identifier — left-recursive chain of
//                      scoped_identifier and identifier; the LAST
//                      identifier is the function/method name

import type { Candidate } from "../types";
import type { AstNode, AstPattern } from "./types";

const RUST_FUNCTION_NODE_TYPES = new Set(["function_item", "closure_expression"]);

function findEnclosingFunction(node: AstNode): AstNode | null {
  let cur: AstNode | null = node.parent;
  while (cur !== null) {
    if (RUST_FUNCTION_NODE_TYPES.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Extract parameter names from a Rust function-shaped node.
 *
 * function_item children: identifier (name), parameters, return type, block.
 *   parameters contains parameter nodes; each parameter has an
 *   identifier (the name) plus type info.
 *
 * closure_expression: closure_parameters contains identifier nodes
 * directly (untyped: `|x|`) or parameter nodes (typed: `|x: &str|`).
 *
 * Patterns we DON'T currently handle: tuple-pattern parameters
 * `fn f((a, b): (i32, i32))`, struct-pattern parameters
 * `fn f(Point{x, y}: Point)`. These are rare in production code;
 * documented as a future enhancement.
 */
function parameterNames(func: AstNode): Set<string> {
  const names = new Set<string>();

  // Find the parameters / closure_parameters child.
  let paramContainer: AstNode | null = null;
  for (let i = 0; i < func.namedChildCount; i++) {
    const child = func.namedChild(i);
    if (!child) continue;
    if (child.type === "parameters" || child.type === "closure_parameters") {
      paramContainer = child;
      break;
    }
  }
  if (!paramContainer) return names;

  for (let i = 0; i < paramContainer.namedChildCount; i++) {
    const param = paramContainer.namedChild(i);
    if (!param) continue;
    if (param.type === "identifier") {
      // Untyped closure param: `|x|`
      names.add(param.text);
      continue;
    }
    if (param.type === "parameter" || param.type === "self_parameter") {
      // The first identifier descendant is the parameter name; type
      // info follows. Bounded recursion at depth 4.
      const name = findFirstIdentifier(param, 4);
      if (name) names.add(name);
    }
  }
  return names;
}

function findFirstIdentifier(node: AstNode, maxDepth: number): string | null {
  if (maxDepth < 0) return null;
  if (node.type === "identifier") return node.text;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === "identifier") return c.text;
    // Recurse into pattern wrappers like reference_pattern, mut_pattern.
    if (
      c.type === "reference_pattern" ||
      c.type === "mut_pattern" ||
      c.type === "tuple_pattern" ||
      c.type === "ref_pattern"
    ) {
      const inner = findFirstIdentifier(c, maxDepth - 1);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * Walk a Rust scoped_identifier (or plain identifier) and return the
 * trailing segments as an array. For `std::process::Command::new`
 * returns ["std", "process", "Command", "new"]. For a bare
 * identifier returns [text].
 */
function scopedIdentifierSegments(node: AstNode, depth = 0): string[] {
  if (depth > 6) return [];
  if (node.type === "identifier") return [node.text];
  if (node.type !== "scoped_identifier") return [];
  const segs: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === "scoped_identifier") {
      segs.push(...scopedIdentifierSegments(c, depth + 1));
    } else if (c.type === "identifier") {
      segs.push(c.text);
    }
  }
  return segs;
}

const RUST_FS_TERMINAL_METHODS = new Set([
  "open",
  "create",
  "create_new",
  "read",
  "read_to_string",
  "read_dir",
  "write",
  "remove_file",
  "remove_dir",
  "remove_dir_all",
  "rename",
  "metadata",
  "canonicalize",
  "set_permissions",
  "copy",
  "hard_link",
  "symlink_metadata",
]);

export const RUST_AST_PATTERNS: AstPattern[] = [
  {
    id: "rust-ast-001-command-new-of-parameter",
    title: "std::process::Command::new(p) of a parameter (CWE-78 command injection)",
    severity: "critical",
    languages: ["rust"],
    /**
     * Match `<path>::new(<bare-ident>)` calls. The match() callback
     * narrows by checking the scoped_identifier's final two segments
     * are `Command::new`, regardless of whether the user wrote it
     * fully-qualified (`std::process::Command::new`) or imported
     * (`Command::new` after `use std::process::Command`).
     */
    query: `
      (call_expression
        function: (scoped_identifier) @scope
        arguments: (arguments . (identifier) @arg))
    `,
    match(captures, _source, file): Candidate | null {
      const scope = captures.scope?.[0];
      const arg = captures.arg?.[0];
      if (!scope || !arg) return null;
      const segs = scopedIdentifierSegments(scope.node);
      if (segs.length < 2) return null;
      const last = segs[segs.length - 1];
      const second = segs[segs.length - 2];
      if (last !== "new" || second !== "Command") return null;
      const enclosing = findEnclosingFunction(arg.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "rust-ast-001-command-new-of-parameter",
        severity: "critical",
        file,
        line,
        matched_text: `Command::new(${arg.node.text})`,
        context: `Command::new(${arg.node.text})  // arg is a parameter — caller-controlled binary path`,
      };
    },
    explanation:
      "std::process::Command::new() invoked with a binary path AST-traced to a function parameter. Command::new doesn't go through a shell, but a caller-controlled binary path lets an attacker pick which executable runs. Subsequent .arg() / .args() calls are typically fine — the danger is the binary at the head of the chain.",
    verify_prompt:
      "Is the function exposed to caller-controlled input?\n" +
      "1. HTTP/RPC handler, CLI parsing argv, message consumer — CONFIRMED.\n" +
      "2. The argument is allowlisted against a fixed set of binaries before this call — FALSE_POSITIVE.\n" +
      "3. Internal-only callers always pass a hardcoded binary — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED.",
    cwe: "CWE-78",
    fix_template:
      'Hardcode the binary as Command::new("/usr/bin/known"). Pass user input only as later .arg() calls. Use a Hash/Vec allowlist if dynamic dispatch is required.',
  },

  {
    id: "rust-ast-002-fs-path-of-parameter",
    title: "std::fs / File path operations of a parameter (CWE-22 path traversal)",
    severity: "high",
    languages: ["rust"],
    /**
     * Match scoped calls whose tail-segment is one of the dangerous
     * fs methods. For File::open / File::create the second-from-last
     * segment must be `File`. For std::fs::read_to_string / write /
     * etc., the second-from-last segment must be `fs`. Both shapes
     * captured by the same query; match() distinguishes.
     */
    query: `
      (call_expression
        function: (scoped_identifier) @scope
        arguments: (arguments . (identifier) @arg))
    `,
    match(captures, _source, file): Candidate | null {
      const scope = captures.scope?.[0];
      const arg = captures.arg?.[0];
      if (!scope || !arg) return null;
      const segs = scopedIdentifierSegments(scope.node);
      if (segs.length < 2) return null;
      const last = segs[segs.length - 1];
      const second = segs[segs.length - 2];
      if (!last || !RUST_FS_TERMINAL_METHODS.has(last)) return null;
      // For File methods, second-from-last must be "File".
      // For fs free-functions, second-from-last must be "fs".
      const isFileMethod = second === "File";
      const isFsFn = second === "fs";
      if (!isFileMethod && !isFsFn) return null;
      const enclosing = findEnclosingFunction(arg.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      const label = isFileMethod ? `File::${last}` : `fs::${last}`;
      return {
        pattern_id: "rust-ast-002-fs-path-of-parameter",
        severity: "high",
        file,
        line,
        matched_text: `${label}(${arg.node.text})`,
        context: `${label}(${arg.node.text})  // arg is a parameter — path traversal candidate`,
      };
    },
    explanation:
      "std::fs::read_to_string / std::fs::write / std::fs::remove_file / File::open / File::create (and friends) invoked with a path AST-traced to a function parameter. Without a canonicalize + base-prefix check, an attacker controlling this parameter can read or write files outside the intended directory via `../`. Path::canonicalize() resolves symlinks and `..` segments — verify the result starts with the intended root.",
    verify_prompt:
      "Is the function exposed to caller-controlled input?\n" +
      "1. HTTP/RPC handler / CLI taking a path arg — CONFIRMED unless validated.\n" +
      "2. Code calls Path::canonicalize and verifies the result has the expected base prefix BEFORE this call — FALSE_POSITIVE.\n" +
      "3. Internal-only callers, hardcoded paths — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED.",
    cwe: "CWE-22",
    fix_template:
      "Canonicalize: `let abs = Path::new(p).canonicalize()?;` then `if !abs.starts_with(BASE_DIR) { return Err(...); }`. Or scope all access under a per-tenant base dir.",
  },
];
