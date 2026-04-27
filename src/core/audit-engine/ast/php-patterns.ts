// KCode - AST patterns for PHP (v2.10.349)
//
// Three patterns covering the dominant PHP sinks:
//
//   php-ast-001  eval / assert of a parameter (CWE-95 RCE)
//   php-ast-002  system / shell_exec / exec / passthru / popen / pcntl_exec
//                of a parameter (CWE-78 command injection)
//   php-ast-003  include / require / file_get_contents / fopen of a
//                parameter (CWE-98 RFI / CWE-22 path traversal)
//
// Note: this build bundles `tree-sitter-php_only` (renamed to
// tree-sitter-php.wasm so the runner finds it). It parses pure PHP
// source — files mixing PHP with HTML still process via tree-sitter
// error recovery, but full mixed-mode coverage would need the wider
// tree-sitter-php grammar (a future addition).
//
// Node-type shapes (verified empirically against tree-sitter-php@0.24):
//   functions/methods   function_definition / method_declaration
//   anonymous           anonymous_function / arrow_function
//   parameters          formal_parameters of simple_parameter,
//                       variadic_parameter, property_promotion_parameter
//   parameter naming    each parameter wraps a `variable_name` whose
//                       child `name` is the bare identifier text
//   call shape          function_call_expression with `name` (the
//                       callee) + `arguments`
//   argument shape      `arguments` contains `argument` nodes;
//                       each argument's variable_name is `(variable_name (name))`
//   include syntax      include_expression / include_once_expression /
//                       require_expression / require_once_expression —
//                       wrap a (variable_name (name)) directly

import type { Candidate } from "../types";
import type { AstNode, AstPattern } from "./types";

const PHP_FUNCTION_NODE_TYPES = new Set([
  "function_definition",
  "method_declaration",
  "anonymous_function",
  "arrow_function",
]);

function findEnclosingFunction(node: AstNode): AstNode | null {
  let cur: AstNode | null = node.parent;
  while (cur !== null) {
    if (PHP_FUNCTION_NODE_TYPES.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Extract parameter names from a PHP function-shaped node.
 *
 * Each `formal_parameters` child is a `simple_parameter`,
 * `variadic_parameter`, or `property_promotion_parameter`. Inside,
 * the parameter name is wrapped two levels deep:
 *   (simple_parameter (variable_name (name "x")))
 * We extract the bare `name` text. Type annotations and default
 * values are siblings — they don't introduce names.
 */
function parameterNames(func: AstNode): Set<string> {
  const names = new Set<string>();
  // Find formal_parameters child.
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
    if (!param) continue;
    if (
      param.type !== "simple_parameter" &&
      param.type !== "variadic_parameter" &&
      param.type !== "property_promotion_parameter"
    ) {
      continue;
    }
    // Walk children for the variable_name; its child `name` is the
    // bare identifier text.
    for (let j = 0; j < param.namedChildCount; j++) {
      const sub = param.namedChild(j);
      if (!sub || sub.type !== "variable_name") continue;
      for (let k = 0; k < sub.namedChildCount; k++) {
        const nm = sub.namedChild(k);
        if (nm && nm.type === "name") {
          names.add(nm.text);
          break;
        }
      }
    }
  }
  return names;
}

const PHP_EVAL_CALLEES = new Set(["eval", "assert"]);

const PHP_SHELL_CALLEES = new Set([
  "system",
  "shell_exec",
  "exec",
  "passthru",
  "popen",
  "proc_open",
  "pcntl_exec",
]);

const PHP_FILE_CALLEES = new Set([
  "file_get_contents",
  "file_put_contents",
  "fopen",
  "readfile",
  "file",
  "include", // include() is also callable as a function in some PHP versions
  "require",
  "include_once",
  "require_once",
  "parse_ini_file",
  "highlight_file",
  "show_source",
  "unlink",
  "rmdir",
  "rename",
  "copy",
  "fileperms",
  "fileowner",
  "stat",
  "lstat",
]);

export const PHP_AST_PATTERNS: AstPattern[] = [
  {
    id: "php-ast-001-eval-of-parameter",
    title: "eval / assert of a parameter (CWE-95 RCE)",
    severity: "critical",
    languages: ["php"],
    /**
     * Match `eval($x)` and `assert($x)` (string-form assert is also
     * an RCE primitive in PHP <8). The arg is anchored to position 0
     * — eval takes one arg. Two query branches: bare-name and
     * qualified-name (`\eval($x)`, used to escape an enclosing
     * namespace and call the global). v349 audit fix added the
     * qualified-name branch.
     */
    query: `
      [
        (function_call_expression
          function: (name) @callee
          arguments: (arguments . (argument (variable_name (name) @arg))))
        (function_call_expression
          function: (qualified_name (name) @callee)
          arguments: (arguments . (argument (variable_name (name) @arg))))
      ]
    `,
    match(captures, _source, file): Candidate | null {
      const callee = captures.callee?.[0];
      const arg = captures.arg?.[0];
      if (!callee || !arg) return null;
      if (!PHP_EVAL_CALLEES.has(callee.node.text)) return null;
      const enclosing = findEnclosingFunction(callee.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "php-ast-001-eval-of-parameter",
        severity: "critical",
        file,
        line,
        matched_text: `${callee.node.text}($${arg.node.text})`,
        context: `${callee.node.text}($${arg.node.text})  // arg is a parameter — eval of caller-controlled string is RCE`,
      };
    },
    explanation:
      "eval / assert (when invoked with a string) compiles and runs PHP code at the call site. A caller-controlled input is full RCE. eval is rare in modern PHP; assert with string arg is deprecated since PHP 7.2 and was removed in 8.0 — but legacy code still hits this.",
    verify_prompt:
      "Is the function exposed to caller-controlled input?\n" +
      "1. HTTP/RPC handler, message consumer — CONFIRMED.\n" +
      "2. Internal-only callers passing a hardcoded string — FALSE_POSITIVE.\n" +
      "3. Argument is allowlisted before this call — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED — eval of a parameter is the textbook PHP RCE.",
    cwe: "CWE-95",
    fix_template:
      "Replace eval($x) with a switch/match dispatch. For data, parse as JSON via json_decode. Never eval caller input.",
  },

  {
    id: "php-ast-002-shell-of-parameter",
    title: "system / shell_exec / exec / passthru of a parameter (CWE-78 command injection)",
    severity: "critical",
    languages: ["php"],
    query: `
      [
        (function_call_expression
          function: (name) @callee
          arguments: (arguments . (argument (variable_name (name) @arg))))
        (function_call_expression
          function: (qualified_name (name) @callee)
          arguments: (arguments . (argument (variable_name (name) @arg))))
      ]
    `,
    match(captures, _source, file): Candidate | null {
      const callee = captures.callee?.[0];
      const arg = captures.arg?.[0];
      if (!callee || !arg) return null;
      if (!PHP_SHELL_CALLEES.has(callee.node.text)) return null;
      const enclosing = findEnclosingFunction(callee.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "php-ast-002-shell-of-parameter",
        severity: "critical",
        file,
        line,
        matched_text: `${callee.node.text}($${arg.node.text})`,
        context: `${callee.node.text}($${arg.node.text})  // arg is a parameter — runs through /bin/sh`,
      };
    },
    explanation:
      "system / shell_exec / exec / passthru / popen / proc_open / pcntl_exec invoked with a value AST-traced to a function parameter. shell_exec and the backtick operator both fork /bin/sh -c with the interpolated string; system / exec / passthru likewise pass the raw string to a shell. Any caller-controlled input is shell injection.",
    verify_prompt:
      "Is the function exposed to caller-controlled input?\n" +
      "1. Web request handler, RPC method, queue consumer — CONFIRMED.\n" +
      "2. Argument is escaped with escapeshellarg / escapeshellcmd before this call — FALSE_POSITIVE if the escape is correct for the receiving shell.\n" +
      "3. Argument is allowlisted before this call — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED.",
    cwe: "CWE-78",
    fix_template:
      "Always wrap user input with escapeshellarg(). Better: use proc_open with an array of fixed binary + args. For dispatch, use an allowlist Map of legitimate operations.",
  },

  {
    id: "php-ast-003-include-of-parameter",
    title: "include / require / file_get_contents / fopen of a parameter (CWE-98 / CWE-22)",
    severity: "high",
    languages: ["php"],
    /**
     * Two shapes:
     *   1. include $p / include_once $p / require $p / require_once $p
     *      — these are include_*_expression nodes wrapping
     *      (variable_name (name) @arg)
     *   2. file_get_contents($p) / fopen($p) / readfile($p) — same
     *      function_call_expression shape as eval
     */
    query: `
      [
        (function_call_expression
          function: (name) @callee
          arguments: (arguments . (argument (variable_name (name) @arg))))
        (function_call_expression
          function: (qualified_name (name) @callee)
          arguments: (arguments . (argument (variable_name (name) @arg))))
        (include_expression
          (variable_name (name) @arg) @incl_arg) @incl
        (include_once_expression
          (variable_name (name) @arg) @incl_arg) @incl
        (require_expression
          (variable_name (name) @arg) @incl_arg) @incl
        (require_once_expression
          (variable_name (name) @arg) @incl_arg) @incl
      ]
    `,
    match(captures, _source, file): Candidate | null {
      const arg = captures.arg?.[0];
      if (!arg) return null;
      const callee = captures.callee?.[0];
      const incl = captures.incl?.[0];
      let label = "";
      let trigger: AstNode | null = null;
      if (callee) {
        if (!PHP_FILE_CALLEES.has(callee.node.text)) return null;
        trigger = callee.node;
        label = `${callee.node.text}($${arg.node.text})`;
      } else if (incl) {
        // Strip the "_expression" suffix to label e.g. "include_once".
        const kw = incl.node.type.replace(/_expression$/, "");
        trigger = incl.node;
        label = `${kw} $${arg.node.text}`;
      } else {
        return null;
      }
      const enclosing = findEnclosingFunction(trigger);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "php-ast-003-include-of-parameter",
        severity: "high",
        file,
        line,
        matched_text: label,
        context: `${label}  // arg is a parameter — include of caller-controlled path is RFI/LFI; file_get_contents is path traversal`,
      };
    },
    explanation:
      "include / require / include_once / require_once with a caller-controlled path is the canonical PHP Remote File Inclusion (when allow_url_include is on) or Local File Inclusion vector. file_get_contents / fopen / readfile / parse_ini_file with a parameter path is the path-traversal counterpart. Either way, the attacker picks which file the server reads or executes.",
    verify_prompt:
      "Is the function exposed to caller-controlled input?\n" +
      "1. HTTP request handler, queue consumer, message processor — CONFIRMED.\n" +
      "2. Path is normalized AND checked against a base-dir prefix before this call — FALSE_POSITIVE.\n" +
      "3. Internal-only callers, hardcoded paths — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED — include of caller input was historically the #1 PHP RCE root cause.",
    cwe: "CWE-98",
    fix_template:
      "Maintain a hash of legitimate include targets and look up by key. For data files, realpath() the resolved path and verify it starts with the intended base dir; reject paths containing `..` after normalization.",
  },
];
