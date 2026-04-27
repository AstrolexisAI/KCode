// KCode - AST patterns for JavaScript/TypeScript (v2.10.340)
//
// Same shape as python-patterns.ts: a query finds candidate call
// sites, the match() callback walks the AST to confirm taint via a
// function parameter (versus a hardcoded literal). Two patterns:
//   js-ast-001  eval / Function / setTimeout-string of a parameter
//   js-ast-002  child_process.exec / execSync / spawn of a parameter
//
// Node-type shapes (verified empirically against tree-sitter-javascript@0.25):
//   functions         function_declaration | function_expression |
//                     arrow_function | method_definition
//   parameter list    formal_parameters (or, for arrow_function shorthand
//                     `x => ...`, the parameter is a direct identifier
//                     child of the arrow_function — NO formal_parameters)
//   parameter shapes  identifier
//                     assignment_pattern    (x = default)
//                     rest_pattern          (...args)
//                     object_pattern        ({a, b})  → shorthand_property_identifier_pattern
//                     array_pattern         ([c, d])  → identifiers

import type { Candidate } from "../types";
import type { AstNode, AstPattern } from "./types";

const JS_FUNCTION_NODE_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "generator_function_declaration",
  "function", // some grammar versions use bare "function"
]);

function findEnclosingFunction(node: AstNode): AstNode | null {
  let cur: AstNode | null = node.parent;
  while (cur !== null) {
    if (JS_FUNCTION_NODE_TYPES.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Extract parameter names from a JavaScript function-shaped node.
 *
 * Two cases:
 *   A) Arrow function shorthand `x => ...`: the parameter is a direct
 *      `identifier` child of the arrow_function, NOT wrapped in a
 *      formal_parameters node. Bypassing this case is the JS analogue
 *      of the v2.10.338 lambda bug in Python.
 *   B) Everything else (declarations, expressions, methods, parenthesized
 *      arrows): a `formal_parameters` child wraps the params.
 *
 * Destructured params (object_pattern / array_pattern) extract every
 * bound name they introduce.
 */
function parameterNames(func: AstNode): Set<string> {
  const names = new Set<string>();

  if (func.type === "arrow_function") {
    // Case A: walk direct children for an `identifier` child that
    // appears BEFORE the body — that's the shorthand parameter.
    for (let i = 0; i < func.namedChildCount; i++) {
      const child = func.namedChild(i);
      if (!child) continue;
      if (child.type === "identifier") {
        names.add(child.text);
        return names;
      }
      if (child.type === "formal_parameters") break; // case B handles it below
    }
  }

  // Case B: formal_parameters is the container.
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
    collectParamNames(param, names);
  }
  return names;
}

/**
 * Recursively walk a parameter node, adding every binding name it
 * introduces. Handles assignment_pattern (`x = 5`), rest_pattern
 * (`...args`), object_pattern (`{a, b}` — uses
 * shorthand_property_identifier_pattern OR pair_pattern's value),
 * array_pattern (`[c, d]`), and plain identifier.
 *
 * Bounded depth so a pathological grammar can't recurse forever.
 */
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
    case "rest_pattern": {
      // ...args — the inner identifier is the bound name.
      for (let i = 0; i < param.namedChildCount; i++) {
        const c = param.namedChild(i);
        if (c) collectParamNames(c, names, depth + 1);
      }
      return;
    }
    case "object_pattern":
    case "array_pattern": {
      for (let i = 0; i < param.namedChildCount; i++) {
        const c = param.namedChild(i);
        if (c) collectParamNames(c, names, depth + 1);
      }
      return;
    }
    case "pair_pattern": {
      // {a: b} — the *value* (rhs) is the bound name in the local
      // scope, the key isn't.
      const rhs = param.namedChild(1);
      if (rhs) collectParamNames(rhs, names, depth + 1);
      return;
    }
    case "required_parameter":
    case "optional_parameter": {
      // TypeScript-grammar wrappers. The first named child is the
      // binding (identifier / rest_pattern / object_pattern / ...);
      // siblings are type_annotation / default value. Recurse into
      // the binding only — type annotations don't introduce a name.
      const bind = param.namedChild(0);
      if (bind) collectParamNames(bind, names, depth + 1);
      return;
    }
    default:
      return;
  }
}

const JS_DANGEROUS_GLOBALS = new Set([
  "eval",
  "Function", // new Function(code) / Function(code) — same execution semantics
]);

const JS_DANGEROUS_TIMER_GLOBALS = new Set(["setTimeout", "setInterval"]);

const JS_DANGEROUS_CHILD_PROCESS_METHODS = new Set([
  "exec",
  "execSync",
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
]);

export const JAVASCRIPT_AST_PATTERNS: AstPattern[] = [
  {
    id: "js-ast-001-eval-of-parameter",
    title: "eval / Function / setTimeout(string) of a function parameter (taint via AST)",
    severity: "critical",
    languages: ["javascript", "typescript"],
    /**
     * Match both `Function(p)` (call_expression) and `new Function(p)`
     * (new_expression) where the first argument is a bare identifier.
     * `new Function(arg)` is the more common form in production JS
     * for code-execution-from-string and was silently missed before
     * the union — caught during the v341 audit. The match() callback
     * narrows by callee identity and verifies parameter scope.
     */
    query: `
      [
        (call_expression
          function: (identifier) @callee
          arguments: (arguments . (identifier) @arg))
        (new_expression
          constructor: (identifier) @callee
          arguments: (arguments . (identifier) @arg))
      ]
    `,
    match(captures, _source, file): Candidate | null {
      const callee = captures.callee?.[0];
      const arg = captures.arg?.[0];
      if (!callee || !arg) return null;
      const fn = callee.node.text;
      const isCodeExec = JS_DANGEROUS_GLOBALS.has(fn);
      const isTimerString = JS_DANGEROUS_TIMER_GLOBALS.has(fn);
      if (!isCodeExec && !isTimerString) return null;
      const enclosing = findEnclosingFunction(callee.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      // The captured node is the callee/constructor identifier; tell
      // new_expression apart from call_expression by walking up one.
      const isNewExpr = callee.node.parent?.type === "new_expression";
      const prefix = isNewExpr ? "new " : "";
      const note = isCodeExec
        ? "arg is a parameter of the enclosing function"
        : "arg is a parameter — setTimeout/setInterval with a non-function first arg evaluates as code";
      return {
        pattern_id: "js-ast-001-eval-of-parameter",
        severity: "critical",
        file,
        line,
        matched_text: `${prefix}${fn}(${arg.node.text})`,
        context: `${prefix}${fn}(${arg.node.text})  // ${note}`,
      };
    },
    explanation:
      "eval, Function, or a string-form setTimeout/setInterval invoked with an argument that AST analysis traces back to a function parameter. The regex form catches the call but can't prove the argument flows from caller-controlled input. AST resolves the chain.",
    verify_prompt:
      "Is the function exposed to external input?\n" +
      "1. The function is an HTTP handler / CLI entrypoint / IPC method / event listener — CONFIRMED.\n" +
      "2. The function is internal-only and every call site passes a hardcoded literal — FALSE_POSITIVE.\n" +
      "3. The argument is allowlisted (compared against a fixed set) before the eval — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED — eval of a parameter is almost always a hole.",
    cwe: "CWE-95",
    fix_template:
      "Replace eval(x) with JSON.parse(x) for data, a Map/Object lookup for dispatch, or schema-validated input. Never eval a value the caller controls.",
  },

  {
    id: "js-ast-002-child-process-exec-of-parameter",
    title:
      "child_process.exec / spawn / execFile of a function parameter (command injection via AST)",
    severity: "critical",
    languages: ["javascript", "typescript"],
    /**
     * Match member-call shape `obj.method(arg)` where method is one
     * of the dangerous child_process functions and arg is a bare
     * identifier. The taint check (parameter scope) happens in match().
     */
    query: `
      (call_expression
        function: (member_expression property: (property_identifier) @method)
        arguments: (arguments . (identifier) @arg))
    `,
    match(captures, _source, file): Candidate | null {
      const method = captures.method?.[0];
      const arg = captures.arg?.[0];
      if (!method || !arg) return null;
      if (!JS_DANGEROUS_CHILD_PROCESS_METHODS.has(method.node.text)) return null;
      const enclosing = findEnclosingFunction(method.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "js-ast-002-child-process-exec-of-parameter",
        severity: "critical",
        file,
        line,
        matched_text: `.${method.node.text}(${arg.node.text})`,
        context: `.${method.node.text}(${arg.node.text})  // arg is a parameter of the enclosing function`,
      };
    },
    explanation:
      "child_process.exec / execSync / spawn / execFile invoked with a value that AST analysis traces back to a function parameter. exec and execSync go through a shell, so any caller-controlled string is a command-injection candidate. spawn/execFile without shell:true are safer but still flagged because the parameter typically becomes the binary path or argv[0].",
    verify_prompt:
      "Is the function exposed to external input?\n" +
      "1. Function is an HTTP/RPC handler, CLI parser, or message consumer — CONFIRMED.\n" +
      "2. Method is spawn/execFile WITHOUT shell:true and the parameter is destined for argv[1+] (data, not the binary) — could be FALSE_POSITIVE if input is validated as a path with no separators.\n" +
      "3. Hardcoded callers only OR allowlisted command set checked before this call — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED — exec of a parameter is the canonical command-injection sink.",
    cwe: "CWE-78",
    fix_template:
      "Use execFile(binary, [arg1, arg2]) with hardcoded binary, or spawn() without shell:true. Validate the parameter against an allowlist before use. Never pass caller-controlled strings to exec / execSync.",
  },

  {
    id: "js-ast-003-regexp-construction-of-parameter",
    title: "new RegExp(p) / RegExp(p) where p is a function parameter (ReDoS sink)",
    severity: "high",
    languages: ["javascript", "typescript"],
    /**
     * Match both `new RegExp(p)` (new_expression) and `RegExp(p)`
     * (call_expression) where the constructor / function identifier
     * is RegExp and the first argument is a bare identifier.
     * tree-sitter exposes new_expression with a `constructor` field
     * and call_expression with a `function` field; we match both
     * shapes in a union.
     */
    query: `
      [
        (new_expression
          constructor: (identifier) @callee
          arguments: (arguments . (identifier) @arg))
        (call_expression
          function: (identifier) @callee
          arguments: (arguments . (identifier) @arg))
      ]
    `,
    match(captures, _source, file): Candidate | null {
      const callee = captures.callee?.[0];
      const arg = captures.arg?.[0];
      if (!callee || !arg) return null;
      if (callee.node.text !== "RegExp") return null;
      const enclosing = findEnclosingFunction(callee.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "js-ast-003-regexp-construction-of-parameter",
        severity: "high",
        file,
        line,
        matched_text: `new RegExp(${arg.node.text})`,
        context: `RegExp(${arg.node.text})  // arg is a parameter — caller-controlled regex source is a ReDoS sink`,
      };
    },
    explanation:
      "RegExp built from a value that AST analysis traces back to a function parameter. A caller-controlled regex source can trigger catastrophic backtracking on benign-looking inputs (e.g. `(a+)+$` against a long matching prefix). Even when the regex isn't pathological, accepting raw regex from a caller leaks the ability to enumerate or fingerprint internal data via crafted patterns.",
    verify_prompt:
      "Is the function exposed to external input?\n" +
      "1. The function is a search / filter / validator endpoint that takes a pattern string from the caller — CONFIRMED.\n" +
      "2. The parameter is escaped with a regex-escape helper before construction (e.g. wrapped in `[\\^$.|?*+()]\\\\&` replace, or passed through a known escape function) — FALSE_POSITIVE.\n" +
      "3. The parameter is allowlisted against a fixed set of regex strings — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED — building a RegExp from caller input without escaping is a top-3 ReDoS root cause.",
    cwe: "CWE-1333",
    fix_template:
      "Either (a) escape the parameter with a regex-escape helper before passing it to RegExp, (b) use String.prototype.includes / indexOf if substring containment is what you need, or (c) bound the input length and reject regex-like control characters.",
  },

  // ── F4 (v2.10.366) — taint-lite patterns ─────────────────────
  // These complement js-ast-001/002/003 (which catch the
  // function-parameter case) by also catching member-access
  // sources (req.body, process.argv, etc.) and assignment-propagated
  // taint (`const x = req.body; eval(x);`). The taint walker lives
  // in ./taint-walker.ts and recognizes a small set of sanitizers
  // that launder the value (validator.escape, DOMPurify.sanitize,
  // shell-escape, etc.).

  {
    id: "js-ast-005-eval-of-tainted-expression",
    title: "eval / Function / setTimeout(string) of a tainted expression (taint-lite)",
    severity: "critical",
    languages: ["javascript", "typescript"],
    /**
     * Match call_expression and new_expression where the callee is
     * `eval`, `Function`, `setTimeout`, or `setInterval`. We match
     * the whole expression so the taint walker can inspect the
     * argument shape (member access, assignment, concat, etc.).
     */
    query: `
      [
        (call_expression
          function: (identifier) @callee
          arguments: (arguments) @args)
        (new_expression
          constructor: (identifier) @callee
          arguments: (arguments) @args)
      ]
    `,
    match(captures, _source, file): Candidate | null {
      const callee = captures.callee?.[0];
      const args = captures.args?.[0];
      if (!callee || !args) return null;
      const fn = callee.node.text;
      const isCodeExec = JS_DANGEROUS_GLOBALS.has(fn);
      const isTimerString = JS_DANGEROUS_TIMER_GLOBALS.has(fn);
      if (!isCodeExec && !isTimerString) return null;

      // Skip the bare-parameter shape — js-ast-001 already covers it
      // and we don't want to double-flag the same site.
      const firstArg = args.node.namedChild(0);
      if (!firstArg) return null;
      if (firstArg.type === "identifier") {
        // Could be either: bare param (js-ast-001's territory) OR a
        // local that earlier was assigned tainted data. Defer to
        // js-ast-001 for the parameter case; here we only emit if
        // the identifier is a *local* tainted variable, which means
        // collectTaintedLocals saw a tainted assignment to it.
        const enclosing = findEnclosingFunction(callee.node);
        if (!enclosing) return null;
        const body = findFunctionBody(enclosing);
        if (!body) return null;
        // Need to import lazily because of test-time module ordering.
        const { collectTaintedLocals } =
          require("./taint-walker") as typeof import("./taint-walker");
        const tainted = collectTaintedLocals(body);
        if (!tainted.has(firstArg.text)) return null;
      } else {
        // Non-identifier argument — check directly via the walker.
        const enclosing = findEnclosingFunction(callee.node);
        const body = enclosing ? findFunctionBody(enclosing) : null;
        const { isTainted, collectTaintedLocals } =
          require("./taint-walker") as typeof import("./taint-walker");
        const tainted = body ? collectTaintedLocals(body) : new Set<string>();
        if (!isTainted(firstArg, tainted)) return null;
      }

      const line = firstArg.startPosition.row + 1;
      const isNewExpr = callee.node.parent?.type === "new_expression";
      const prefix = isNewExpr ? "new " : "";
      const snippet = firstArg.text.length > 80 ? `${firstArg.text.slice(0, 77)}…` : firstArg.text;
      return {
        pattern_id: "js-ast-005-eval-of-tainted-expression",
        severity: "critical",
        file,
        line,
        matched_text: `${prefix}${fn}(${snippet})`,
        context: `${prefix}${fn}(${snippet})  // expression is tainted (member access / assignment / concat from req/request/process/ctx/document/location)`,
      };
    },
    explanation:
      "eval / Function / setTimeout-string with an argument the taint walker traces back to an external source (HTTP request, process.argv, process.env, document, location) — possibly through an intermediate `const x = req.body` style assignment. js-ast-001 catches the parameter case; this catches the assignment + member-access cases the regex pattern can't prove.",
    verify_prompt:
      "Does the expression carry attacker-controlled data into eval / Function?\n" +
      "1. The argument is a member of req/request/process/document/location (directly or via assignment) — CONFIRMED.\n" +
      "2. The argument is wrapped by a parser that throws on unexpected shapes (zod.parse, ajv) — FALSE_POSITIVE.\n" +
      "3. The argument is built from compile-time constants concatenated with the tainted value — CONFIRMED (concatenation does not launder taint).\n" +
      "Default to CONFIRMED — eval of attacker-reachable data is RCE.",
    cwe: "CWE-95",
    fix_template:
      "Replace eval(x) with JSON.parse(x) for data, a dispatch table for command names, or a parser that validates structure before use. Concatenation does not sanitize.",
  },

  {
    id: "js-ast-006-exec-of-tainted-expression",
    title: "child_process.exec / spawn / execFile of a tainted expression (taint-lite)",
    severity: "critical",
    languages: ["javascript", "typescript"],
    query: `
      (call_expression
        function: (member_expression property: (property_identifier) @method)
        arguments: (arguments) @args)
    `,
    match(captures, _source, file): Candidate | null {
      const method = captures.method?.[0];
      const args = captures.args?.[0];
      if (!method || !args) return null;
      if (!JS_DANGEROUS_CHILD_PROCESS_METHODS.has(method.node.text)) return null;
      const firstArg = args.node.namedChild(0);
      if (!firstArg) return null;
      if (firstArg.type === "identifier") {
        const enclosing = findEnclosingFunction(method.node);
        if (!enclosing) return null;
        const body = findFunctionBody(enclosing);
        if (!body) return null;
        const { collectTaintedLocals } =
          require("./taint-walker") as typeof import("./taint-walker");
        const tainted = collectTaintedLocals(body);
        // Skip bare parameters — js-ast-002 covers them.
        const params = parameterNames(enclosing);
        if (params.has(firstArg.text)) return null;
        if (!tainted.has(firstArg.text)) return null;
      } else {
        const enclosing = findEnclosingFunction(method.node);
        const body = enclosing ? findFunctionBody(enclosing) : null;
        const { isTainted, collectTaintedLocals } =
          require("./taint-walker") as typeof import("./taint-walker");
        const tainted = body ? collectTaintedLocals(body) : new Set<string>();
        if (!isTainted(firstArg, tainted)) return null;
      }
      const line = firstArg.startPosition.row + 1;
      const snippet = firstArg.text.length > 80 ? `${firstArg.text.slice(0, 77)}…` : firstArg.text;
      return {
        pattern_id: "js-ast-006-exec-of-tainted-expression",
        severity: "critical",
        file,
        line,
        matched_text: `.${method.node.text}(${snippet})`,
        context: `.${method.node.text}(${snippet})  // command string is tainted from req/request/process/ctx/document/location (possibly via assignment + concat)`,
      };
    },
    explanation:
      "child_process.exec / spawn / execFile with a command string the taint walker traces back to an external source. js-ast-002 catches the bare-parameter case; this catches concat (`'ls ' + userPath`) and assignment-propagated taint patterns that regex misses.",
    verify_prompt:
      "Does the command string carry attacker input?\n" +
      "1. The command embeds a member of req/request/process/document/location (directly, via assignment, or concatenated) — CONFIRMED.\n" +
      "2. The argument is wrapped by `shell-escape` / `shell-quote.quote` / `escapeShellArg` — FALSE_POSITIVE.\n" +
      "3. The exec uses `execFile`/`spawn` with the args array form, where the command is a hardcoded literal and only argv entries are tainted — still CONFIRMED if any tainted entry isn't shell-quoted.\n" +
      "Default to CONFIRMED — exec of attacker-reachable data is shell-injection.",
    cwe: "CWE-78",
    fix_template:
      "Use execFile/spawn with the args array form and a hardcoded command, then shell-escape every tainted argv entry. Never build the shell command via string concat with external input.",
  },

  {
    id: "js-ast-007-innerhtml-of-tainted-expression",
    title: "innerHTML / outerHTML assigned a tainted expression (taint-lite)",
    severity: "high",
    languages: ["javascript", "typescript"],
    /**
     * Match `<expr>.innerHTML = <rhs>` and `.outerHTML = <rhs>`. The
     * taint walker inspects rhs for member access rooted in a taint
     * source, with sanitizer recognition for DOMPurify.sanitize etc.
     */
    query: `
      (assignment_expression
        left: (member_expression property: (property_identifier) @prop)
        right: (_) @rhs)
    `,
    match(captures, _source, file): Candidate | null {
      const prop = captures.prop?.[0];
      const rhs = captures.rhs?.[0];
      if (!prop || !rhs) return null;
      const propName = prop.node.text;
      if (propName !== "innerHTML" && propName !== "outerHTML") return null;
      const enclosing = findEnclosingFunction(prop.node);
      const body = enclosing ? findFunctionBody(enclosing) : null;
      const { isTainted, collectTaintedLocals } =
        require("./taint-walker") as typeof import("./taint-walker");
      const tainted = body ? collectTaintedLocals(body) : new Set<string>();
      if (!isTainted(rhs.node, tainted)) return null;
      const line = rhs.node.startPosition.row + 1;
      const snippet = rhs.node.text.length > 80 ? `${rhs.node.text.slice(0, 77)}…` : rhs.node.text;
      return {
        pattern_id: "js-ast-007-innerhtml-of-tainted-expression",
        severity: "high",
        file,
        line,
        matched_text: `.${propName} = ${snippet}`,
        context: `.${propName} = ${snippet}  // RHS is tainted from req/request/process/ctx/document/location (XSS sink)`,
      };
    },
    explanation:
      "innerHTML / outerHTML assigned a value the taint walker traces back to an external source — XSS. The regex pattern (js-002-innerhtml) catches the assignment but can't prove the value is attacker-controlled. The AST taint walker can.",
    verify_prompt:
      "Does the assigned HTML carry attacker-controlled content?\n" +
      "1. The expression is a member of req/request/document.cookie/location.search (directly or via concat) — CONFIRMED.\n" +
      "2. The value is wrapped by DOMPurify.sanitize / sanitize-html / a strict allowlist before assignment — FALSE_POSITIVE.\n" +
      "3. The expression is built from compile-time HTML concatenated with the tainted value — CONFIRMED (concatenation does not launder).\n" +
      "Default to CONFIRMED — innerHTML of attacker-reachable data is XSS.",
    cwe: "CWE-79",
    fix_template:
      "Use textContent for plain text or DOMPurify.sanitize(value) before innerHTML. Concatenation with literal HTML does not sanitize the value.",
  },
];

/**
 * Find the body node of a function — the children include the
 * formal_parameters and a statement_block / arrow body. We need the
 * statement_block (or single-expression body) for taint analysis to
 * scope to the right region.
 */
function findFunctionBody(func: AstNode): AstNode | null {
  for (let i = 0; i < func.namedChildCount; i++) {
    const child = func.namedChild(i);
    if (!child) continue;
    if (
      child.type === "statement_block" ||
      child.type === "function_body" ||
      // Arrow functions can have an expression body — return the
      // arrow function itself so collectTaintedLocals walks the
      // expression (no declarations there but still safe).
      (func.type === "arrow_function" && i === func.namedChildCount - 1)
    ) {
      return child;
    }
  }
  return func;
}
