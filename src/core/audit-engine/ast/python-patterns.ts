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

  // ── v2.10.343 — second wave of Python AST patterns ──────────────

  {
    id: "py-ast-002-deserialization-of-parameter",
    title: "pickle / yaml / marshal / dill .loads(p) of a parameter (CWE-502)",
    severity: "critical",
    languages: ["python"],
    /**
     * Match `module.method(arg)` where the call shape is
     * (call (attribute (id) @mod (id) @method) (argument_list . (id) @arg))
     * and the module/method pair is a known unsafe deserializer.
     * The match() callback narrows the pair set and verifies the
     * argument is a parameter of the enclosing function.
     */
    query: `
      (call
        function: (attribute
          object: (identifier) @mod
          attribute: (identifier) @method)
        arguments: (argument_list . (identifier) @arg))
    `,
    match(captures, _source, file): Candidate | null {
      const mod = captures.mod?.[0];
      const method = captures.method?.[0];
      const arg = captures.arg?.[0];
      if (!mod || !method || !arg) return null;
      // Allowlist of (module, method) pairs that execute caller code
      // during deserialization. yaml.safe_load and json.loads are
      // intentionally NOT in this set — they're the safe alternatives.
      const m = mod.node.text;
      const fn = method.node.text;
      const dangerous = (
        (m === "pickle" && (fn === "loads" || fn === "load")) ||
        (m === "cPickle" && (fn === "loads" || fn === "load")) ||
        (m === "_pickle" && (fn === "loads" || fn === "load")) ||
        (m === "dill" && (fn === "loads" || fn === "load")) ||
        (m === "marshal" && (fn === "loads" || fn === "load")) ||
        (m === "yaml" && (fn === "load" || fn === "unsafe_load" || fn === "full_load")) ||
        (m === "shelve" && fn === "open")
      );
      if (!dangerous) return null;
      const enclosing = findEnclosingFunction(method.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "py-ast-002-deserialization-of-parameter",
        severity: "critical",
        file,
        line,
        matched_text: `${m}.${fn}(${arg.node.text})`,
        context: `${m}.${fn}(${arg.node.text})  # arg is a parameter — unsafe deserializer of caller-controlled bytes is an RCE primitive`,
      };
    },
    explanation:
      "An unsafe deserializer (pickle / dill / marshal / yaml.load / shelve.open) invoked with bytes/text that AST analysis traces back to a function parameter. Each of these formats can construct arbitrary Python objects during deserialization — the canonical attack is a malicious payload that runs `__reduce__` to invoke os.system. Note: `yaml.safe_load` and `json.loads` are explicitly NOT in this set.",
    verify_prompt:
      "Is the deserializer reading data the caller controls?\n" +
      "1. Function is an HTTP/RPC handler, message consumer, or session/cookie loader — CONFIRMED.\n" +
      "2. Function loads from a file path that's hardcoded or written only by the same trusted process — FALSE_POSITIVE.\n" +
      "3. The bytes pass through a signed / authenticated channel before this call (HMAC-verified, TLS-pinned) — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED — pickle of a parameter is the textbook RCE.",
    cwe: "CWE-502",
    fix_template:
      "Switch to a safe format: json.loads for data, yaml.safe_load for config. If pickle is unavoidable for performance/legacy reasons, sign the payload with HMAC and verify before deserializing. Never deserialize across a trust boundary without authentication.",
  },

  {
    id: "py-ast-003-subprocess-of-parameter",
    title: "subprocess / os.system / os.popen / os.exec* of a parameter (CWE-78 command injection)",
    severity: "critical",
    languages: ["python"],
    /**
     * Same module-method shape as py-ast-002. Anchored to first arg
     * because the binary / shell-string is at position 0 for every
     * dangerous form in this set; a list-form first arg
     * (`subprocess.run([p])`) won't match here, that's a future
     * enhancement.
     */
    query: `
      (call
        function: (attribute
          object: (identifier) @mod
          attribute: (identifier) @method)
        arguments: (argument_list . (identifier) @arg))
    `,
    match(captures, _source, file): Candidate | null {
      const mod = captures.mod?.[0];
      const method = captures.method?.[0];
      const arg = captures.arg?.[0];
      if (!mod || !method || !arg) return null;
      const m = mod.node.text;
      const fn = method.node.text;
      const dangerous = (
        (m === "subprocess" && (
          fn === "run" || fn === "call" || fn === "check_call" ||
          fn === "check_output" || fn === "Popen" || fn === "getoutput" ||
          fn === "getstatusoutput"
        )) ||
        (m === "os" && (
          fn === "system" || fn === "popen" || fn === "popen2" ||
          fn === "popen3" || fn === "popen4" ||
          fn === "execv" || fn === "execve" || fn === "execvp" ||
          fn === "execvpe" || fn === "execl" || fn === "execle" ||
          fn === "execlp" || fn === "execlpe" || fn === "spawnv" ||
          fn === "spawnve" || fn === "spawnvp" || fn === "spawnvpe" ||
          fn === "startfile"
        )) ||
        (m === "commands" && (fn === "getoutput" || fn === "getstatusoutput"))
      );
      if (!dangerous) return null;
      const enclosing = findEnclosingFunction(method.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "py-ast-003-subprocess-of-parameter",
        severity: "critical",
        file,
        line,
        matched_text: `${m}.${fn}(${arg.node.text})`,
        context: `${m}.${fn}(${arg.node.text})  # arg is a parameter — first arg becomes the binary or shell command`,
      };
    },
    explanation:
      "subprocess / os.system / os.popen / os.exec* / commands.getoutput invoked with a value AST-traced to a function parameter. os.system and os.popen always go through a shell; subprocess.run with shell=True is the same. Even shell=False forms are flagged because the parameter at position 0 typically becomes the binary path — letting an attacker run arbitrary executables.",
    verify_prompt:
      "Is the function exposed to external input?\n" +
      "1. HTTP/RPC handler, CLI taking command/file args, message consumer — CONFIRMED.\n" +
      "2. Internal-only callers passing a hardcoded binary — FALSE_POSITIVE.\n" +
      "3. Argument is allowlisted against a fixed set of binaries before this call — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED — subprocess of a parameter is the canonical command-injection sink.",
    cwe: "CWE-78",
    fix_template:
      "Use subprocess.run(['/usr/bin/known-binary', user_arg], shell=False, check=True). Never pass shell=True with user-controlled strings. Validate the parameter against an allowlist first.",
  },

  {
    id: "py-ast-004-open-of-parameter",
    title: "open() / pathlib of a function parameter (CWE-22 path traversal)",
    severity: "high",
    languages: ["python"],
    /**
     * Two shapes:
     *   open(p)               — builtin
     *   pathlib.Path(p).open() — chained
     * We match the simple builtin form here. The chained form is
     * caught by py-ast-002 / regex coverage.
     */
    query: `
      (call
        function: (identifier) @callee
        arguments: (argument_list . (identifier) @arg))
    `,
    match(captures, _source, file): Candidate | null {
      const callee = captures.callee?.[0];
      const arg = captures.arg?.[0];
      if (!callee || !arg) return null;
      if (callee.node.text !== "open") return null;
      const enclosing = findEnclosingFunction(callee.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "py-ast-004-open-of-parameter",
        severity: "high",
        file,
        line,
        matched_text: `open(${arg.node.text})`,
        context: `open(${arg.node.text})  # arg is a parameter — path traversal candidate (../../etc/passwd)`,
      };
    },
    explanation:
      "Builtin open() invoked with a path AST-traced to a function parameter. Without filepath sanitization (resolve + base-prefix check), an attacker can traverse out of the intended directory using `../`. Note: shadowing the builtin `open` with a user-defined function would cause a (rare) false positive — verifier-side check.",
    verify_prompt:
      "Is the function exposed to external input?\n" +
      "1. HTTP/RPC handler taking a path/filename arg — CONFIRMED unless validated.\n" +
      "2. The function calls os.path.realpath/Path.resolve and verifies the result starts with a known base directory BEFORE this call — FALSE_POSITIVE.\n" +
      "3. Internal-only callers, hardcoded paths — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED.",
    cwe: "CWE-22",
    fix_template:
      "Resolve to absolute via Path(p).resolve() and check str(resolved).startswith(str(BASE_DIR)). Reject any path with `..` after resolution. For multi-tenant systems, scope the path under a per-tenant root.",
  },
];
