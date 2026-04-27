// KCode - AST patterns for TypeScript (v2.10.341)
//
// Patterns specific to TypeScript / TSX. Patterns that target both
// JS and TS share the language declaration `["javascript", "typescript"]`
// in javascript-patterns.ts; this file is for shapes that only
// meaningfully appear in TS code.
//
//   ts-ast-001  obj[key] = ... where key is a parameter (CWE-1321,
//               prototype pollution candidate). Same shape exists in
//               JS but appears far more often in TS codebases that
//               use `Record<string, T>` shapes — so we route this
//               pattern through the typescript grammar primarily.
//
// All param-name extraction reuses the JS helpers (parameterNames,
// collectParamNames) which already handle the TS `required_parameter`
// / `optional_parameter` wrappers introduced in v2.10.341.

import type { Candidate } from "../types";
import type { AstNode, AstPattern } from "./types";

const TS_FUNCTION_NODE_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "function_signature",
  "method_signature",
  "generator_function_declaration",
  "function",
]);

function findEnclosingFunction(node: AstNode): AstNode | null {
  let cur: AstNode | null = node.parent;
  while (cur !== null) {
    if (TS_FUNCTION_NODE_TYPES.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

function collectParamNames(param: AstNode, names: Set<string>, depth = 0): void {
  if (depth > 8) return;
  switch (param.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      names.add(param.text);
      return;
    case "assignment_pattern": {
      const lhs = param.namedChild(0);
      if (lhs) collectParamNames(lhs, names, depth + 1);
      return;
    }
    case "rest_pattern":
    case "object_pattern":
    case "array_pattern": {
      for (let i = 0; i < param.namedChildCount; i++) {
        const c = param.namedChild(i);
        if (c) collectParamNames(c, names, depth + 1);
      }
      return;
    }
    case "pair_pattern": {
      const rhs = param.namedChild(1);
      if (rhs) collectParamNames(rhs, names, depth + 1);
      return;
    }
    case "required_parameter":
    case "optional_parameter": {
      const bind = param.namedChild(0);
      if (bind) collectParamNames(bind, names, depth + 1);
      return;
    }
    default:
      return;
  }
}

function parameterNames(func: AstNode): Set<string> {
  const names = new Set<string>();
  if (func.type === "arrow_function") {
    for (let i = 0; i < func.namedChildCount; i++) {
      const child = func.namedChild(i);
      if (!child) continue;
      if (child.type === "identifier") {
        names.add(child.text);
        return names;
      }
      if (child.type === "formal_parameters") break;
    }
  }
  let formalParams: AstNode | null = null;
  for (let i = 0; i < func.namedChildCount; i++) {
    const child = func.namedChild(i);
    if (child && child.type === "formal_parameters") {
      formalParams = child;
      break;
    }
  }
  if (!formalParams) return names;
  for (let i = 0; i < formalParams.namedChildCount; i++) {
    const param = formalParams.namedChild(i);
    if (param) collectParamNames(param, names);
  }
  return names;
}

/**
 * v341 audit fix — without a type-aware filter, ts-ast-001 fires on
 * `arr[i] = val` for every numeric array index, which is everywhere
 * in TypeScript code. Returns true iff the named parameter of `func`
 * carries a numeric type annotation (`number`, `bigint`). The check
 * is purely syntactic: a programmer could lie about types, but at
 * that point the FP is on them, not on us.
 *
 * Recognized numeric annotations:
 *   :number, :bigint
 *   :number | undefined, :number | null    (union with nullables)
 *   :Number, :Integer                       (rare custom types — accept)
 */
function paramHasNumericType(func: AstNode, name: string): boolean {
  let formalParams: AstNode | null = null;
  for (let i = 0; i < func.namedChildCount; i++) {
    const child = func.namedChild(i);
    if (child && child.type === "formal_parameters") {
      formalParams = child;
      break;
    }
  }
  if (!formalParams) return false;
  for (let i = 0; i < formalParams.namedChildCount; i++) {
    const param = formalParams.namedChild(i);
    if (!param) continue;
    if (param.type !== "required_parameter" && param.type !== "optional_parameter") {
      continue;
    }
    const bind = param.namedChild(0);
    if (!bind || bind.type !== "identifier" || bind.text !== name) continue;
    // Find the type_annotation sibling.
    for (let j = 1; j < param.namedChildCount; j++) {
      const sib = param.namedChild(j);
      if (!sib || sib.type !== "type_annotation") continue;
      const inner = sib.namedChild(0);
      if (!inner) return false;
      const t = inner.text.trim();
      // Strip trailing `| undefined` / `| null` to catch nullable
      // numerics. We're conservative: any union containing `number`
      // counts as numeric for FP-suppression purposes.
      if (/^(number|bigint|Number|Integer)(\s*\|\s*(null|undefined))*$/.test(t)) {
        return true;
      }
      // Reject early on anything that's clearly a string/object type;
      // anything else falls through and the pattern fires.
      return false;
    }
  }
  return false;
}

export const TYPESCRIPT_AST_PATTERNS: AstPattern[] = [
  {
    id: "ts-ast-001-prototype-pollution-of-parameter",
    title: "obj[key] = ... where key is a function parameter (prototype pollution candidate)",
    severity: "high",
    languages: ["typescript"],
    /**
     * Match every assignment whose left side is `something[ident]`
     * and the bracket index is a bare identifier. The match()
     * callback verifies that the bracket identifier is a parameter
     * of the enclosing function — meaning the caller can pass
     * "__proto__" or "constructor" and walk up the prototype chain.
     */
    query: `
      (assignment_expression
        left: (subscript_expression
          (identifier) @obj
          (identifier) @key))
    `,
    match(captures, _source, file): Candidate | null {
      const obj = captures.obj?.[0];
      const key = captures.key?.[0];
      if (!obj || !key) return null;
      // The subscript_expression's first identifier is the object,
      // the second is the index. Defensive: if there's only one
      // identifier captured (rare grammar quirk), bail.
      if (obj.node.startIndex === key.node.startIndex) return null;
      const enclosing = findEnclosingFunction(key.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(key.node.text)) return null;
      // FP suppression — `arr[i] = val` with i:number is array
      // indexing, not prototype pollution. v341 audit fix; without
      // this, the pattern was hot on every TS array-write loop body.
      if (paramHasNumericType(enclosing, key.node.text)) return null;
      const line = key.node.startPosition.row + 1;
      return {
        pattern_id: "ts-ast-001-prototype-pollution-of-parameter",
        severity: "high",
        file,
        line,
        matched_text: `${obj.node.text}[${key.node.text}] = ...`,
        context: `${obj.node.text}[${key.node.text}] = ...  // key is a parameter — attacker can pass "__proto__" / "constructor"`,
      };
    },
    explanation:
      "Assignment to obj[key] where AST analysis traces key back to a function parameter. If the function is exposed and the caller controls key, they can set obj.__proto__, obj.constructor, or obj.prototype, which (depending on usage downstream) can let them inject properties into Object.prototype itself. Common in helper functions like `merge(target, key, value)` and `set(o, k, v)` that sit underneath Lodash-like APIs.",
    verify_prompt:
      "Is the function exposed to caller-controlled input?\n" +
      "1. HTTP/RPC handler, deserializer, or merge/set utility called by such a handler — CONFIRMED.\n" +
      '2. The function explicitly checks key against ["__proto__", "constructor", "prototype"] (or uses Object.create(null) for the target, or Object.hasOwn before reading it back) — FALSE_POSITIVE.\n' +
      "3. Internal-only callers always pass a hardcoded string — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED for any code that resembles a generic merge/set helper.",
    cwe: "CWE-1321",
    fix_template:
      'Reject the dangerous keys before assigning: `if (key === "__proto__" || key === "constructor" || key === "prototype") return;`. Better: use `Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })`, or use Map.set when the underlying type allows it.',
  },
];
