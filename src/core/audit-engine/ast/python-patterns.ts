// KCode - AST patterns for Python (v2.10.336)
//
// Demonstration of why AST-based detection beats regex for taint
// flow. Initial drop ships ONE pattern that the regex library
// genuinely struggles with: eval() with an argument that's reachable
// from a function parameter.

import type { Candidate } from "../types";
import type { AstNode, AstPattern } from "./types";

function findEnclosingFunction(node: AstNode): AstNode | null {
  let cur: AstNode | null = node.parent;
  while (cur !== null) {
    // v2.10.338 audit fix: also stop on lambda. `lambda x: eval(x)`
    // is identical taint to `def f(x): eval(x)` but tree-sitter uses
    // a different node type ("lambda") and a different parameters
    // node ("lambda_parameters"). Without this, lambda-style code
    // sneaks past the analysis entirely.
    if (cur.type === "function_definition" || cur.type === "lambda") return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Walk the named children of `func` until we find the parameters
 * list, then return the set of parameter names. Handles regular
 * function_definition (`parameters` node) and lambda (`lambda_parameters`).
 *
 * Recognized parameter shapes:
 *   identifier                — `def f(x): ...`, `lambda x: ...`
 *   typed_parameter           — `def f(x: T): ...`
 *   default_parameter         — `def f(x = "v"): ...`
 *   typed_default_parameter   — `def f(x: T = v): ...`
 *   list_splat_pattern        — `def f(*args): ...`     → name = "args"
 *   dictionary_splat_pattern  — `def f(**kw): ...`      → name = "kw"
 *   positional_separator      — `/` divider (no name)
 *   keyword_separator         — `*` divider (no name)
 *
 * For each, the parameter NAME is the first identifier child. v2.10.338
 * audit fix expanded coverage from "identifier-only" to the full
 * splat / typed / default set.
 */
function parameterNames(func: AstNode): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < func.namedChildCount; i++) {
    const child = func.namedChild(i);
    if (!child) continue;
    if (child.type !== "parameters" && child.type !== "lambda_parameters") {
      continue;
    }
    for (let j = 0; j < child.namedChildCount; j++) {
      const param = child.namedChild(j);
      if (!param) continue;
      if (param.type === "identifier") {
        names.add(param.text);
        continue;
      }
      // For splat / typed / default forms, recurse to find the
      // first identifier descendant — but bounded to direct children
      // first (the common case) so we don't accidentally pull in
      // type-annotation identifiers.
      let foundName = false;
      for (let k = 0; k < param.namedChildCount; k++) {
        const sub = param.namedChild(k);
        if (sub && sub.type === "identifier") {
          names.add(sub.text);
          foundName = true;
          break;
        }
      }
      // list_splat_pattern / dictionary_splat_pattern wrap the name
      // inside an inner identifier. If the direct-child scan didn't
      // find one, try one level deeper.
      if (!foundName && (param.type === "list_splat_pattern" || param.type === "dictionary_splat_pattern")) {
        for (let k = 0; k < param.namedChildCount; k++) {
          const sub = param.namedChild(k);
          if (!sub) continue;
          for (let m = 0; m < sub.namedChildCount; m++) {
            const inner = sub.namedChild(m);
            if (inner && inner.type === "identifier") {
              names.add(inner.text);
              break;
            }
          }
        }
      }
    }
    break;
  }
  return names;
}

export const PYTHON_AST_PATTERNS: AstPattern[] = [
  {
    id: "py-ast-001-eval-of-parameter",
    title: "eval() / exec() of a function parameter (taint via AST)",
    severity: "critical",
    languages: ["python"],
    /**
     * Match every call to eval/exec whose first argument is a
     * bare identifier. The taint check happens in match() — we
     * verify the identifier is one of the enclosing function's
     * parameters, which would mean the caller controls it.
     */
    query: `
      (call
        function: (identifier) @callee
        arguments: (argument_list (identifier) @arg))
    `,
    match(captures, _source, file): Candidate | null {
      const callee = captures.callee?.[0];
      const arg = captures.arg?.[0];
      if (!callee || !arg) return null;
      if (!["eval", "exec", "compile"].includes(callee.node.text)) return null;
      const enclosing = findEnclosingFunction(callee.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "py-ast-001-eval-of-parameter",
        severity: "critical",
        file,
        line,
        matched_text: `${callee.node.text}(${arg.node.text})`,
        context: `${callee.node.text}(${arg.node.text})  # arg is a parameter of the enclosing function`,
      };
    },
    explanation:
      "eval / exec / compile invoked with an argument that AST analysis traces back to a function parameter. The regex form catches the call site but can't prove the argument flows from a parameter (versus a hardcoded literal or a sanitized internal value). AST taint resolves the chain in one query.",
    verify_prompt:
      "Is the function exposed to external input?\n" +
      "1. The function is a request handler / RPC method / CLI entrypoint → CONFIRMED.\n" +
      "2. The function is internal-only and the caller passes a hardcoded literal in every call site → FALSE_POSITIVE.\n" +
      "3. The argument is sanitized (allowlist comparison, ast.literal_eval, etc.) inside the function before the eval/exec → FALSE_POSITIVE.\n" +
      "Default to CONFIRMED — eval() of a parameter is almost always a hole.",
    cwe: "CWE-95",
    fix_template:
      "Replace eval(x) with ast.literal_eval(x) for data, or a hash-lookup / case-when for dispatch. Never eval a value the caller controls.",
  },
];
