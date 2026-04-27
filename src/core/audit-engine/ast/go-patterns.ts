// KCode - AST patterns for Go (v2.10.340)
//
// Two patterns:
//   go-ast-001  os/exec.Command / CommandContext of a function parameter
//               (command injection — the canonical exec sink in Go)
//   go-ast-002  os.Open / os.OpenFile / ioutil.ReadFile / os.ReadFile
//               of a function parameter (path traversal candidate)
//
// Node-type shapes (verified empirically against tree-sitter-go@0.25):
//   functions     function_declaration | method_declaration | func_literal
//                 method_declaration has TWO parameter_list children:
//                 the receiver and the regular params. We collect both.
//   parameters    parameter_list contains parameter_declaration and/or
//                 variadic_parameter_declaration. Each declaration has
//                 multiple identifier children (the names) followed by
//                 a type node. We collect identifiers only.

import type { Candidate } from "../types";
import type { AstNode, AstPattern } from "./types";

const GO_FUNCTION_NODE_TYPES = new Set([
  "function_declaration",
  "method_declaration",
  "func_literal",
]);

function findEnclosingFunction(node: AstNode): AstNode | null {
  let cur: AstNode | null = node.parent;
  while (cur !== null) {
    if (GO_FUNCTION_NODE_TYPES.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Collect every parameter (and method receiver) name from a Go
 * function-shaped node. method_declaration has two parameter_list
 * children — the first is the receiver, the second the regular
 * params; we collect from both because shadowing means the receiver
 * is in-scope for the function body.
 */
function parameterNames(func: AstNode): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < func.namedChildCount; i++) {
    const child = func.namedChild(i);
    if (!child || child.type !== "parameter_list") continue;
    for (let j = 0; j < child.namedChildCount; j++) {
      const decl = child.namedChild(j);
      if (!decl) continue;
      if (decl.type !== "parameter_declaration" && decl.type !== "variadic_parameter_declaration") {
        continue;
      }
      // Each declaration is `name1, name2, ... <type>`. We collect
      // every identifier child; the type is a *_type node, never a
      // bare identifier (parameters with naked types like `f(string)`
      // produce a single non-identifier child and contribute no name).
      for (let k = 0; k < decl.namedChildCount; k++) {
        const sub = decl.namedChild(k);
        if (sub && sub.type === "identifier") names.add(sub.text);
      }
    }
  }
  return names;
}

// Only Command — its binary is argument 0, which is what the
// anchored `.` in the query below pins to. exec.CommandContext takes
// (ctx, name, ...args), so the binary is argument 1; matching that
// safely needs a different query shape and is left for a later
// pattern. The regex-based go-007 still catches CommandContext at
// the string level.
const GO_EXEC_METHODS = new Set(["Command"]);

const GO_FILE_OPEN_METHODS = new Set([
  "Open",
  "OpenFile",
  "ReadFile",
  "Create",
  "Stat",
  "Lstat",
  "Remove",
  "RemoveAll",
]);

const GO_IOUTIL_FILE_METHODS = new Set(["ReadFile", "WriteFile"]);

export const GO_AST_PATTERNS: AstPattern[] = [
  {
    id: "go-ast-001-exec-command-of-parameter",
    title: "exec.Command / exec.CommandContext of a function parameter (command injection via AST)",
    severity: "critical",
    languages: ["go"],
    /**
     * Match calls of the shape `pkg.Method(arg, ...)` where the first
     * argument is a bare identifier. The match() callback narrows to
     * Command / CommandContext on a package selector that names exec
     * (or aliases like cmd, sh — common conventions). The taint check
     * verifies arg is a parameter of the enclosing function.
     */
    query: `
      (call_expression
        function: (selector_expression
          operand: (identifier) @pkg
          field: (field_identifier) @method)
        arguments: (argument_list . (identifier) @arg))
    `,
    match(captures, _source, file): Candidate | null {
      const pkg = captures.pkg?.[0];
      const method = captures.method?.[0];
      const arg = captures.arg?.[0];
      if (!pkg || !method || !arg) return null;
      if (!GO_EXEC_METHODS.has(method.node.text)) return null;
      // Be conservative: only match when the operand looks like the
      // exec package. Common imports: `os/exec` aliased as `exec`. If
      // the user renames it, the regex go-007 still catches the
      // string-form calls.
      if (pkg.node.text !== "exec") return null;
      const enclosing = findEnclosingFunction(method.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "go-ast-001-exec-command-of-parameter",
        severity: "critical",
        file,
        line,
        matched_text: `exec.${method.node.text}(${arg.node.text})`,
        context: `exec.${method.node.text}(${arg.node.text})  // arg is a parameter — first arg becomes argv[0] of the spawned process`,
      };
    },
    explanation:
      "exec.Command / exec.CommandContext invoked with a value that AST analysis traces back to a function parameter. The first argument is the binary name; passing a caller-controlled value lets an attacker pick which executable runs. Note: Go's exec.Command does NOT spawn a shell, so this isn't classic command-injection-via-shell — but it IS arbitrary-binary-execution.",
    verify_prompt:
      "Is the function exposed to external input?\n" +
      "1. Function is an HTTP/RPC handler, CLI parser, or message consumer — CONFIRMED.\n" +
      "2. First arg is allowlisted against a fixed set of binary names BEFORE this call — FALSE_POSITIVE.\n" +
      "3. Internal-only callers passing a hardcoded string — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED.",
    cwe: "CWE-78",
    fix_template:
      "Hardcode the binary name; pass user input only as later arguments. Validate against an allowlist if dynamic dispatch is required.",
  },

  {
    id: "go-ast-002-os-open-of-parameter",
    title:
      "os.Open / os.ReadFile / ioutil.ReadFile of a function parameter (path traversal via AST)",
    severity: "high",
    languages: ["go"],
    /**
     * Match `pkg.Method(arg, ...)` where pkg is `os` or `ioutil` and
     * the method is a file-open variant. Same parameter-scope check
     * as above.
     */
    query: `
      (call_expression
        function: (selector_expression
          operand: (identifier) @pkg
          field: (field_identifier) @method)
        arguments: (argument_list . (identifier) @arg))
    `,
    match(captures, _source, file): Candidate | null {
      const pkg = captures.pkg?.[0];
      const method = captures.method?.[0];
      const arg = captures.arg?.[0];
      if (!pkg || !method || !arg) return null;
      const isOs = pkg.node.text === "os" && GO_FILE_OPEN_METHODS.has(method.node.text);
      const isIoutil = pkg.node.text === "ioutil" && GO_IOUTIL_FILE_METHODS.has(method.node.text);
      if (!isOs && !isIoutil) return null;
      const enclosing = findEnclosingFunction(method.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "go-ast-002-os-open-of-parameter",
        severity: "high",
        file,
        line,
        matched_text: `${pkg.node.text}.${method.node.text}(${arg.node.text})`,
        context: `${pkg.node.text}.${method.node.text}(${arg.node.text})  // arg is a parameter — path traversal candidate (../../etc/passwd)`,
      };
    },
    explanation:
      "os.Open / os.ReadFile / ioutil.ReadFile invoked with a value AST-traced to a function parameter. Without filepath.Clean + a base-prefix check, an attacker controlling this parameter can read files outside the intended directory via `../` traversal.",
    verify_prompt:
      "Is the function exposed to external input?\n" +
      "1. HTTP handler / RPC method / CLI taking a path arg — CONFIRMED unless a clean+contains check is present.\n" +
      "2. The function calls filepath.Clean and then strings.HasPrefix(cleanPath, baseDir) — FALSE_POSITIVE.\n" +
      "3. Internal-only callers, hardcoded paths — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED — path-traversal CVEs are a top-10 web-app issue.",
    cwe: "CWE-22",
    fix_template:
      "Use filepath.Clean and verify the result has the expected base prefix BEFORE opening. Reject any path containing `..` after cleaning. Prefer a chroot or per-tenant base dir for multi-tenant systems.",
  },
];
