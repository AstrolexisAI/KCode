// KCode - Taint Walker (F4 of audit product plan, v2.10.366)
//
// Lightweight intra-procedural taint analysis for JavaScript /
// TypeScript. Used by `js-ast-003/004/005` patterns to verify a
// dangerous sink (eval, exec, innerHTML assignment) actually receives
// data that flows from an untrusted source.
//
// "Lite" means:
//   - intra-procedural only (within one function body)
//   - structural taint (any member access rooted in a known taint
//     root is tainted), no flow-sensitive narrowing
//   - sanitizer recognition is conservative — only call expressions
//     that wrap the entire value count
//   - propagation through assignments (`const x = req.body`) and
//     binary expressions (`"prefix " + req.body + suffix`)
//
// What we deliberately don't model:
//   - inter-procedural taint (passing tainted data into a helper)
//     — js-ast-001/002 already handle the function-parameter case
//   - taint laundering through Object.assign / spread / JSON.parse
//   - re-tainting after a sanitized value is concatenated with raw
//     input again (rare in practice, expensive to model)
//
// The trade-off: ~150 lines of code that catches the common cases
// the regex pattern library misses (param + concat propagation),
// without taking on a fully sound dataflow analysis.

import type { AstNode } from "./types";

/**
 * Top-level identifier names whose member-access we treat as
 * untrusted. A `req.body.code` member chain is tainted if `req` is
 * in this set. Names are matched conservatively — `request` matches
 * `request.args.foo` but not `myRequest.foo`.
 */
export const TAINT_ROOTS: ReadonlySet<string> = new Set([
  // Express / Connect / Koa / Fastify HTTP request handlers
  "req",
  "request",
  // Hapi / generic context
  "ctx",
  "context",
  // Node global — process.argv[N], process.env.X
  "process",
  // Common in middleware-style code
  "params",
  "query",
  "body",
  // GraphQL resolver shapes
  "args",
  // Browser globals — every `location.search`, `document.cookie`,
  // and `window.name` is attacker-controllable.
  "location",
  "document",
]);

/**
 * Function calls that consume potentially-tainted input and produce
 * a value safe to send to a sink. When we see `eval(validator.escape(x))`
 * or `el.innerHTML = DOMPurify.sanitize(raw)`, the wrapping call
 * launders the taint.
 *
 * Match by callee TEXT — checking against the rightmost member
 * property handles both `validator.escape(x)` and `escape(x)` forms.
 */
// v2.10.367 — tightened after audit. Earlier versions also included
// "parse" and "validate", but those are method names on countless
// unrelated objects (e.g. `userInput.parse(x)` returning the input
// untouched), creating false-negative risk for the taint walker.
// The remaining names are specific enough that a same-named method
// is overwhelmingly likely to be the laundering helper they imply.
export const SANITIZER_CALLS: ReadonlySet<string> = new Set([
  "escape",          // validator.escape, html-escape
  "sanitize",        // DOMPurify.sanitize, sanitize-html
  "sanitizeHtml",
  "purify",
  "encodeURI",
  "encodeURIComponent",
  "escapeShellArg",
  "shellescape",
  "shell-escape",
  "quote",           // shell-quote.quote
]);

/**
 * Walk an expression tree and return true if any leaf is a member
 * access rooted in a TAINT_ROOTS identifier. Returns false if every
 * branch terminates in a literal, an untainted identifier, or is
 * wrapped by a SANITIZER_CALLS call expression.
 *
 * `localTainted` is the set of local identifier names that earlier
 * assignments marked tainted. A bare identifier reference to one of
 * those names propagates taint without re-deriving it.
 */
export function isTainted(node: AstNode, localTainted: ReadonlySet<string>): boolean {
  return walkForTaint(node, localTainted, 0);
}

const MAX_DEPTH = 32;

function walkForTaint(node: AstNode, localTainted: ReadonlySet<string>, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;

  const t = node.type;

  // Sanitizer: wrapping call neutralizes the taint. Must check at the
  // CALL boundary so `escape(req.body)` returns false even though
  // `req.body` inside is tainted.
  if (t === "call_expression") {
    const callee = node.namedChild(0);
    if (callee && isSanitizerCallee(callee)) return false;
    // Non-sanitizer call: walk arguments. The callee itself can also
    // be tainted (e.g. `req.body.fn()`), but that's an exotic case.
    return walkChildrenForTaint(node, localTainted, depth);
  }

  // Member access: check if rooted in a tainted name.
  if (t === "member_expression" || t === "subscript_expression") {
    const root = leftmostObject(node);
    if (root && root.type === "identifier" && TAINT_ROOTS.has(root.text)) return true;
    if (root && root.type === "identifier" && localTainted.has(root.text)) return true;
    return walkChildrenForTaint(node, localTainted, depth);
  }

  // Bare identifier: tainted if it's a tracked local.
  if (t === "identifier") {
    if (TAINT_ROOTS.has(node.text)) return true;
    if (localTainted.has(node.text)) return true;
    return false;
  }

  // String concatenation, template literals, ternary, parenthesized,
  // binary expressions, assignments-as-expressions: walk every child.
  return walkChildrenForTaint(node, localTainted, depth);
}

function walkChildrenForTaint(
  node: AstNode,
  localTainted: ReadonlySet<string>,
  depth: number,
): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && walkForTaint(child, localTainted, depth + 1)) return true;
  }
  return false;
}

/**
 * Return true if a call expression's callee is a known sanitizer.
 * Handles both `escape(x)` (identifier callee) and `validator.escape(x)`
 * (member_expression callee — we match the rightmost property).
 */
function isSanitizerCallee(callee: AstNode): boolean {
  if (callee.type === "identifier") {
    return SANITIZER_CALLS.has(callee.text);
  }
  if (callee.type === "member_expression") {
    // Property is the second named child of member_expression in
    // tree-sitter-javascript. Walk to the property identifier.
    const prop = callee.namedChild(1);
    if (prop && (prop.type === "property_identifier" || prop.type === "identifier")) {
      return SANITIZER_CALLS.has(prop.text);
    }
  }
  return false;
}

/**
 * Walk a member_expression chain back to its leftmost object.
 * `req.body.code.x[y]` returns the `req` identifier node.
 */
function leftmostObject(node: AstNode): AstNode | null {
  let cur: AstNode | null = node;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (!cur) return null;
    if (cur.type !== "member_expression" && cur.type !== "subscript_expression") return cur;
    cur = cur.namedChild(0);
  }
  return null;
}

/**
 * Walk a function body and collect the names of local variables
 * whose initial value is tainted. Used by the sink-side patterns to
 * recognize `const x = req.body; eval(x);` as tainted-via-assignment.
 *
 * Conservative — only initial declarations count. Reassignments that
 * later overwrite x with sanitized data won't un-taint it. In real
 * code a single function rarely re-uses a tainted name as anything
 * else, so this is a fine approximation.
 */
export function collectTaintedLocals(
  funcBody: AstNode,
  parentTainted: ReadonlySet<string> = new Set(),
): Set<string> {
  const tainted = new Set<string>(parentTainted);
  walkForLocals(funcBody, tainted, 0);
  return tainted;
}

function walkForLocals(node: AstNode, tainted: Set<string>, depth: number): void {
  if (depth > MAX_DEPTH) return;

  // `const/let/var x = expr;` — variable_declarator
  if (node.type === "variable_declarator") {
    const name = node.namedChild(0);
    const value = node.namedChild(1);
    if (name && value && name.type === "identifier") {
      // Snapshot the current taint set before recursing — value can't
      // reference itself (would be a TDZ error in real JS).
      if (isTainted(value, tainted)) tainted.add(name.text);
    }
  }

  // Don't descend into nested function bodies — taint from THIS
  // function's locals doesn't reach into a closure's scope.
  if (
    node.type === "function_declaration" ||
    node.type === "function_expression" ||
    node.type === "arrow_function" ||
    node.type === "method_definition"
  ) {
    return;
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walkForLocals(child, tainted, depth + 1);
  }
}
