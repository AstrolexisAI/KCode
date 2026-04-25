// KCode - AST patterns for Ruby (v2.10.349)
//
// Three patterns covering the dominant Ruby sinks:
//
//   rb-ast-001  eval / instance_eval / class_eval / module_eval of
//               a parameter (CWE-95)
//   rb-ast-002  system / exec / spawn / Kernel.exec / backtick of
//               a parameter (CWE-78)
//   rb-ast-003  File.open / File.read / IO.read of a parameter
//               (CWE-22)
//
// Node-type shapes (verified empirically against tree-sitter-ruby@0.23):
//   functions/blocks   method, singleton_method, block, lambda
//   parameters         method_parameters / block_parameters /
//                      lambda_parameters — all contain `identifier`
//                      nodes directly (Ruby is duck-typed; no
//                      type wrappers)
//   call shapes
//     bare:            (call (identifier "system") (argument_list ...))
//     method:          (call (constant "File") (identifier "open") ...)
//     subshell:        (subshell (interpolation (identifier) @arg))
//                      — the backtick form `\`#{cmd}\``

import type { Candidate } from "../types";
import type { AstNode, AstPattern } from "./types";

const RUBY_FUNCTION_NODE_TYPES = new Set([
  "method",
  "singleton_method",
  "block",
  "do_block",
  "lambda",
]);

function findEnclosingFunction(node: AstNode): AstNode | null {
  let cur: AstNode | null = node.parent;
  while (cur !== null) {
    if (RUBY_FUNCTION_NODE_TYPES.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Extract parameter names from a Ruby function-shaped node. All
 * Ruby parameter containers (method_parameters, block_parameters,
 * lambda_parameters) hold identifier nodes directly. Optional
 * shapes we handle:
 *   - identifier         — plain `def f(x)` / `|x|`
 *   - splat_parameter    — `def f(*args)` — name is inside
 *   - hash_splat_parameter — `def f(**kw)`
 *   - keyword_parameter  — `def f(key:)` — name is the keyword
 *   - optional_parameter — `def f(x = 5)` — name is first child
 *   - block_parameter    — `def f(&blk)`
 */
function parameterNames(func: AstNode): Set<string> {
  const names = new Set<string>();
  collectFromContainer(func, names);
  // Special case: `->(p) { ... }` parses as a `lambda` containing a
  // `block` body. When findEnclosingFunction lands on the inner
  // block (because the eval is inside `block_body`), the params are
  // actually on the lambda parent — not on the block itself. Walk
  // up one level when func is a parameter-less block whose parent
  // is a lambda or do_block.
  if (
    (func.type === "block" || func.type === "do_block") &&
    names.size === 0 &&
    func.parent &&
    (func.parent.type === "lambda" || RUBY_FUNCTION_NODE_TYPES.has(func.parent.type))
  ) {
    collectFromContainer(func.parent, names);
  }
  return names;
}

function collectFromContainer(func: AstNode, names: Set<string>): void {
  for (let i = 0; i < func.namedChildCount; i++) {
    const child = func.namedChild(i);
    if (!child) continue;
    if (
      child.type !== "method_parameters" &&
      child.type !== "block_parameters" &&
      child.type !== "lambda_parameters"
    ) {
      continue;
    }
    for (let j = 0; j < child.namedChildCount; j++) {
      const param = child.namedChild(j);
      if (!param) continue;
      if (param.type === "identifier") {
        names.add(param.text);
        continue;
      }
      // Shaped parameters: the name is the first identifier inside.
      // splat_parameter, hash_splat_parameter, optional_parameter,
      // keyword_parameter, block_parameter all wrap a name.
      for (let k = 0; k < param.namedChildCount; k++) {
        const sub = param.namedChild(k);
        if (sub && sub.type === "identifier") {
          names.add(sub.text);
          break;
        }
      }
    }
    break;
  }
}

const RUBY_EVAL_METHODS = new Set([
  "eval",
  "instance_eval",
  "class_eval",
  "module_eval",
  "binding_eval",
]);

const RUBY_SHELL_METHODS = new Set([
  "system",
  "exec",
  "spawn",
  "popen",
  "syscall",
]);

const RUBY_FILE_METHODS = new Set([
  "open",
  "read",
  "readlines",
  "readline",
  "delete",
  "unlink",
]);

const RUBY_FILE_RECEIVERS = new Set(["File", "IO", "Pathname", "Dir", "FileUtils"]);

export const RUBY_AST_PATTERNS: AstPattern[] = [
  {
    id: "rb-ast-001-eval-of-parameter",
    title: "eval / instance_eval / class_eval / module_eval of a parameter (CWE-95)",
    severity: "critical",
    languages: ["ruby"],
    /**
     * Match bare-form calls (no receiver): `eval(p)`. Also catches
     * `instance_eval(p)` etc. when called on `self` (no explicit
     * receiver — the AST is the same shape as a bare call).
     */
    query: `
      (call
        method: (identifier) @method
        arguments: (argument_list . (identifier) @arg))
    `,
    match(captures, _source, file): Candidate | null {
      const method = captures.method?.[0];
      const arg = captures.arg?.[0];
      if (!method || !arg) return null;
      if (!RUBY_EVAL_METHODS.has(method.node.text)) return null;
      const enclosing = findEnclosingFunction(method.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "rb-ast-001-eval-of-parameter",
        severity: "critical",
        file,
        line,
        matched_text: `${method.node.text}(${arg.node.text})`,
        context: `${method.node.text}(${arg.node.text})  # arg is a parameter — eval of caller-controlled string is RCE`,
      };
    },
    explanation:
      "eval / instance_eval / class_eval / module_eval invoked with a string AST-traced to a function parameter. Each compiles and runs Ruby code at the call site — caller-controlled input is full RCE.",
    verify_prompt:
      "Is the function exposed to caller-controlled input?\n" +
      "1. Rack/Rails handler, ActiveJob worker, Sidekiq job — CONFIRMED.\n" +
      "2. Internal-only callers passing a hardcoded string — FALSE_POSITIVE.\n" +
      "3. Argument is allowlisted before this call — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED — eval of a parameter is the textbook Ruby RCE.",
    cwe: "CWE-95",
    fix_template:
      "Replace eval(x) with a Hash dispatch: lookup against a fixed map, raise on unknown keys. For data, parse as JSON / YAML.safe_load.",
  },

  {
    id: "rb-ast-002-shell-of-parameter",
    title: "system / exec / spawn / backtick of a parameter (CWE-78 command injection)",
    severity: "critical",
    languages: ["ruby"],
    /**
     * Match TWO shapes:
     *   1. Bare-form call: `system(cmd)`
     *   2. Subshell (backtick): `\`#{cmd}\`` parses as
     *      (subshell (interpolation (identifier) @arg))
     *
     * Bare-form Kernel-method calls (system, exec, spawn) match
     * the same call shape as eval — different method-name set.
     */
    query: `
      [
        (call
          method: (identifier) @method
          arguments: (argument_list . (identifier) @arg))
        (subshell
          (interpolation
            (identifier) @arg) @interp) @sub
      ]
    `,
    match(captures, _source, file): Candidate | null {
      const arg = captures.arg?.[0];
      if (!arg) return null;
      const method = captures.method?.[0];
      const sub = captures.sub?.[0];
      let label = "";
      let trigger: AstNode | null = null;
      if (method) {
        if (!RUBY_SHELL_METHODS.has(method.node.text)) return null;
        trigger = method.node;
        label = `${method.node.text}(${arg.node.text})`;
      } else if (sub) {
        trigger = sub.node;
        label = `\`#{${arg.node.text}}\``;
      } else {
        return null;
      }
      const enclosing = findEnclosingFunction(trigger);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "rb-ast-002-shell-of-parameter",
        severity: "critical",
        file,
        line,
        matched_text: label,
        context: `${label}  # arg is a parameter — shells the value via /bin/sh`,
      };
    },
    explanation:
      "system / exec / spawn / Kernel methods that go through a shell — invoked with a value AST-traced to a function parameter. The backtick `\\`#{p}\\`` syntax is identical: it forks /bin/sh -c with the interpolated string. Any caller-controlled input is shell injection.",
    verify_prompt:
      "Is the function exposed to caller-controlled input?\n" +
      "1. Rails controller / Rack app / Sidekiq job — CONFIRMED.\n" +
      "2. Argument is allowlisted before this call — FALSE_POSITIVE.\n" +
      "3. Internal-only with hardcoded callers — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED.",
    cwe: "CWE-78",
    fix_template:
      "Use the array-form: system('/usr/bin/known', user_arg) — no shell involved. Or use Open3.capture3 with an array. Validate against an allowlist for dynamic dispatch.",
  },

  {
    id: "rb-ast-003-file-open-of-parameter",
    title: "File.open / File.read / IO.read of a parameter (CWE-22 path traversal)",
    severity: "high",
    languages: ["ruby"],
    /**
     * Receiver-method shape:
     *   File.open(p) → call: receiver is constant "File", method
     *                  is identifier "open", arg is identifier "p"
     */
    query: `
      (call
        receiver: (constant) @recv
        method: (identifier) @method
        arguments: (argument_list . (identifier) @arg))
    `,
    match(captures, _source, file): Candidate | null {
      const recv = captures.recv?.[0];
      const method = captures.method?.[0];
      const arg = captures.arg?.[0];
      if (!recv || !method || !arg) return null;
      if (!RUBY_FILE_RECEIVERS.has(recv.node.text)) return null;
      if (!RUBY_FILE_METHODS.has(method.node.text)) return null;
      const enclosing = findEnclosingFunction(method.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "rb-ast-003-file-open-of-parameter",
        severity: "high",
        file,
        line,
        matched_text: `${recv.node.text}.${method.node.text}(${arg.node.text})`,
        context: `${recv.node.text}.${method.node.text}(${arg.node.text})  # arg is a parameter — path traversal candidate`,
      };
    },
    explanation:
      "File.open / File.read / File.delete / IO.read / Pathname#open / Dir / FileUtils invoked with a path AST-traced to a function parameter. Without a canonicalization + base-prefix check, an attacker controlling this parameter can read or write files outside the intended directory via `../`.",
    verify_prompt:
      "Is the function exposed to caller-controlled input?\n" +
      "1. Rails controller / Rack app reading a path arg — CONFIRMED unless validated.\n" +
      "2. Code calls Pathname#expand_path or File.expand_path AND checks the result is within a base dir BEFORE this call — FALSE_POSITIVE.\n" +
      "3. Internal-only callers, hardcoded paths — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED.",
    cwe: "CWE-22",
    fix_template:
      "Resolve via Pathname#expand_path and verify .start_with?(BASE_DIR). Reject inputs containing `..` after expansion. Scope per-tenant access to a per-tenant root.",
  },
];
