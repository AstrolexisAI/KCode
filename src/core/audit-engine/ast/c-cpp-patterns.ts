// KCode - AST patterns for C and C++ (v2.10.346)
//
// Three patterns covering the dominant C/C++ sinks where caller-
// controlled input is the ballgame:
//
//   cpp-ast-001  system / popen / execv / execlp etc. of a parameter
//                (CWE-78 command injection)
//   cpp-ast-002  strcpy / strcat / strncpy / sprintf where source
//                or any later-position arg is a parameter
//                (CWE-120 / CWE-121 buffer overflow)
//   cpp-ast-003  printf(fmt) where fmt is a parameter
//                (CWE-134 uncontrolled format string)
//
// Both grammars (tree-sitter-c@0.24, tree-sitter-cpp@0.23) share
// the same essential AST shapes for these sinks: function_definition
// with function_declarator + parameter_list of parameter_declarations.
// We declare languages: ["c", "cpp"] so a pattern fires on both
// .c and .cpp/.cc/.hpp files; the runner picks the matching grammar.
//
// Node-type shapes (verified empirically):
//   function declarations  function_definition contains
//                          function_declarator and compound_statement
//                          (the body)
//   parameters             parameter_list of parameter_declaration nodes
//                          Each declaration:
//                            type_qualifier? + type + (decl-shape)
//                          where decl-shape is one of:
//                            identifier              (int x, T cmd)
//                            pointer_declarator      (char *x, char *const x)
//                            reference_declarator    (T& x — C++ only)
//                            array_declarator        (int x[])
//                          In each, the bottom-most identifier is
//                          the parameter name.
//   class methods (C++)    parsed AS function_definition; the
//                          function_declarator's name is a
//                          field_identifier instead of identifier,
//                          but the parameter shape is unchanged.

import type { Candidate } from "../types";
import type { AstNode, AstPattern } from "./types";

const CPP_FUNCTION_NODE_TYPES = new Set([
  "function_definition",
  "lambda_expression", // C++11 lambdas
]);

function findEnclosingFunction(node: AstNode): AstNode | null {
  let cur: AstNode | null = node.parent;
  while (cur !== null) {
    if (CPP_FUNCTION_NODE_TYPES.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Walk down a parameter_declaration's children to find the bottom-most
 * identifier, recursing through pointer_declarator / reference_declarator /
 * array_declarator wrappers. Returns null for unnamed parameters
 * (e.g. function-pointer formal `void (*)(int)` with no name).
 *
 * Bounded recursion at depth 8 — anything deeper is exotic enough
 * that giving up is correct.
 */
function findParamIdentifier(node: AstNode, depth = 0): string | null {
  if (depth > 8) return null;
  if (node.type === "identifier") return node.text;
  // Walk all named children; the parameter name is typically the
  // last one inside the declarator wrapper, but earlier ones can be
  // type qualifiers / type specifiers — we recurse into wrapper
  // shapes only.
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (
      child.type === "pointer_declarator" ||
      child.type === "reference_declarator" ||
      child.type === "array_declarator" ||
      child.type === "parenthesized_declarator" ||
      child.type === "init_declarator"
    ) {
      const inner = findParamIdentifier(child, depth + 1);
      if (inner) return inner;
    }
    if (child.type === "identifier") return child.text;
  }
  return null;
}

/**
 * Extract parameter names from a function_definition (or C++ lambda).
 *
 * function_definition contains:
 *   - return type stuff
 *   - function_declarator (which holds the name + parameter_list)
 *   - compound_statement (body)
 *
 * For lambdas, parameters are inside lambda_capture_specifier-adjacent
 * abstract_function_declarator — handled by recursing through
 * children.
 */
function parameterNames(func: AstNode): Set<string> {
  const names = new Set<string>();

  // Find the parameter_list — it lives one level down inside
  // function_declarator (or for lambdas, in abstract_function_declarator).
  let paramList: AstNode | null = null;
  function findParamList(node: AstNode, depth = 0): boolean {
    if (depth > 4) return false;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === "parameter_list") {
        paramList = child;
        return true;
      }
      if (
        child.type === "function_declarator" ||
        child.type === "abstract_function_declarator" ||
        child.type === "pointer_declarator" ||
        child.type === "reference_declarator"
      ) {
        if (findParamList(child, depth + 1)) return true;
      }
    }
    return false;
  }
  findParamList(func);
  if (!paramList) return names;

  for (let i = 0; i < (paramList as AstNode).namedChildCount; i++) {
    const decl = (paramList as AstNode).namedChild(i);
    if (!decl) continue;
    if (decl.type !== "parameter_declaration") continue;
    const name = findParamIdentifier(decl);
    if (name) names.add(name);
  }
  return names;
}

const CPP_SYSTEM_CALLEES = new Set([
  "system",
  "popen",
  "execv",
  "execve",
  "execvp",
  "execvpe",
  "execl",
  "execle",
  "execlp",
  "execlpe",
  "_execv",
  "_execve",
  "_execvp",
  "_execvpe", // Windows _exec*
  "_execl",
  "_execle",
  "_execlp",
  "_execlpe",
  "_spawnv",
  "_spawnve",
  "_spawnvp",
  "_spawnvpe",
  "wsystem", // wide-char variant
]);

const CPP_STR_COPY_CALLEES = new Set([
  "strcpy",
  "strcat",
  "strncpy",
  "strncat",
  "wcscpy",
  "wcscat",
  "wcsncpy",
  "wcsncat",
  "lstrcpy",
  "lstrcat",
  "sprintf",
  "vsprintf", // unbounded sprintf is the canonical buffer overflow
  "stpcpy",
  "stpncpy",
]);

const CPP_PRINTF_CALLEES = new Set([
  "printf",
  "puts",
  "wprintf",
  // fprintf/sprintf/snprintf/dprintf have the format string at a
  // later position — we'd need per-function position info to handle
  // them safely. Left for a future enhancement; the regex layer
  // catches them.
]);

export const C_CPP_AST_PATTERNS: AstPattern[] = [
  {
    id: "cpp-ast-001-system-of-parameter",
    title: "system / popen / exec* of a function parameter (CWE-78 command injection)",
    severity: "critical",
    languages: ["c", "cpp"],
    /**
     * Anchored to argument 0 — for system / popen / execv-family
     * the binary or shell-string is at position 0 every time.
     */
    query: `
      (call_expression
        function: (identifier) @callee
        arguments: (argument_list . (identifier) @arg))
    `,
    match(captures, _source, file): Candidate | null {
      const callee = captures.callee?.[0];
      const arg = captures.arg?.[0];
      if (!callee || !arg) return null;
      if (!CPP_SYSTEM_CALLEES.has(callee.node.text)) return null;
      const enclosing = findEnclosingFunction(callee.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "cpp-ast-001-system-of-parameter",
        severity: "critical",
        file,
        line,
        matched_text: `${callee.node.text}(${arg.node.text})`,
        context: `${callee.node.text}(${arg.node.text})  // arg is a parameter — caller-controlled binary or shell command`,
      };
    },
    explanation:
      "system / popen / exec* invoked with a value AST-traced to a function parameter. system() and popen() always invoke /bin/sh (or cmd.exe on Windows), so a caller-controlled string is shell injection. exec*() variants run the named binary directly — letting an attacker pick which executable runs.",
    verify_prompt:
      "Is the function exposed to caller-controlled input?\n" +
      "1. Function takes input from CLI args / network / IPC — CONFIRMED.\n" +
      "2. Internal-only callers passing a hardcoded binary — FALSE_POSITIVE.\n" +
      "3. Argument is allowlisted before this call — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED.",
    cwe: "CWE-78",
    fix_template:
      "Replace system(p) with execvp() / posix_spawn() taking a fixed argv[0] and the user input as later arguments. Validate against an allowlist when dynamic dispatch is required.",
  },

  {
    id: "cpp-ast-002-strcpy-of-parameter",
    title: "strcpy / strcat / sprintf with a parameter source (CWE-120 buffer overflow)",
    severity: "high",
    languages: ["c", "cpp"],
    /**
     * No position anchor — matches every identifier argument and
     * checks each against the enclosing-function parameter set.
     * Reasoning: for strcpy/strcat the SOURCE (position 1) is the
     * dangerous arg; for sprintf the format AND any %s arg are
     * dangerous. Matching any-position keeps it simple at the cost
     * of a possible double-flag for `strcpy(p1, p2)` — both would
     * fire, which is also semantically correct (both are
     * parameter-derived values flowing into the unbounded copy).
     */
    query: `
      (call_expression
        function: (identifier) @callee
        arguments: (argument_list (identifier) @arg))
    `,
    match(captures, _source, file): Candidate | null {
      const callee = captures.callee?.[0];
      const arg = captures.arg?.[0];
      if (!callee || !arg) return null;
      if (!CPP_STR_COPY_CALLEES.has(callee.node.text)) return null;
      // v346 audit fix — position 0 is the destination buffer for
      // every callee in the strcpy family (`strcpy(dst, src)`,
      // `sprintf(buf, fmt, ...)`, etc.). The buffer-overflow bug is
      // when SOURCE (position 1+) is caller-controlled, not when
      // dst is a parameter. Skipping position 0 cuts a hot FP on
      // every routine `strcpy(my_buf, "literal")` call where my_buf
      // is the function's outparam.
      const argList = arg.node.parent;
      if (argList) {
        let pos = -1;
        for (let i = 0; i < argList.namedChildCount; i++) {
          const c = argList.namedChild(i);
          if (c && c.startIndex === arg.node.startIndex) {
            pos = i;
            break;
          }
        }
        if (pos === 0) return null;
      }
      const enclosing = findEnclosingFunction(callee.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "cpp-ast-002-strcpy-of-parameter",
        severity: "high",
        file,
        line,
        matched_text: `${callee.node.text}(...${arg.node.text}...)`,
        context: `${callee.node.text}(...${arg.node.text}...)  // arg is a parameter — unbounded copy of caller-controlled string`,
      };
    },
    explanation:
      "strcpy / strcat / strncpy / strncat / sprintf / vsprintf / wcscpy etc. invoked with a value AST-traced to a function parameter. These C-runtime calls are the classic stack-smashing primitives — a caller-controlled string longer than the destination buffer overwrites the saved frame pointer / return address, enabling code execution. strncpy / strncat with an unchecked n parameter also fall in this set because the bound is itself caller-controlled.",
    verify_prompt:
      "Is the function exposed to caller-controlled input?\n" +
      "1. Network handler / IPC consumer / CLI parser — CONFIRMED.\n" +
      "2. The destination buffer is sized at compile-time AND the function explicitly bounds the copy by `min(strlen(src), sizeof(dst)-1)` BEFORE this call — FALSE_POSITIVE.\n" +
      "3. Internal callers always pass strings that fit — FALSE_POSITIVE if the contract is documented.\n" +
      "Default to CONFIRMED.",
    cwe: "CWE-120",
    fix_template:
      "Switch to strlcpy / strlcat (BSD), or strncpy_s / strcat_s (C11 Annex K), or std::string::copy with a bound. For C++, prefer std::string concatenation altogether. Always size by destination buffer, never by source length.",
  },

  {
    id: "cpp-ast-003-printf-format-of-parameter",
    title: "printf(fmt) where fmt is a function parameter (CWE-134 format string)",
    severity: "high",
    languages: ["c", "cpp"],
    /**
     * Anchored to argument 0 because printf takes the format string
     * at position 0. fprintf/sprintf/snprintf/dprintf put the format
     * at a later position — those need per-function position
     * dispatch and are left for a future enhancement; the regex layer
     * catches them.
     */
    query: `
      (call_expression
        function: (identifier) @callee
        arguments: (argument_list . (identifier) @arg))
    `,
    match(captures, _source, file): Candidate | null {
      const callee = captures.callee?.[0];
      const arg = captures.arg?.[0];
      if (!callee || !arg) return null;
      if (!CPP_PRINTF_CALLEES.has(callee.node.text)) return null;
      const enclosing = findEnclosingFunction(callee.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "cpp-ast-003-printf-format-of-parameter",
        severity: "high",
        file,
        line,
        matched_text: `${callee.node.text}(${arg.node.text})`,
        context: `${callee.node.text}(${arg.node.text})  // format string is a parameter — attacker can use %s / %n to read or write memory`,
      };
    },
    explanation:
      'printf / wprintf / puts invoked with a format string AST-traced to a function parameter. A caller-controlled format string lets an attacker use `%s` to dereference arbitrary stack values (memory disclosure), `%n` to write to attacker-chosen addresses, and `%99999s` to crash the process. The signature `printf(p)` instead of `printf("%s", p)` is the canonical bug pattern.',
    verify_prompt:
      "Is the function exposed to caller-controlled input?\n" +
      "1. CLI logger / network handler / template engine — CONFIRMED.\n" +
      "2. The parameter is documented as a hardcoded internal format string by every caller — FALSE_POSITIVE.\n" +
      "3. The format string is constructed inside the function from a small allowlisted set — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED — printf(p) is the canonical format-string vulnerability.",
    cwe: "CWE-134",
    fix_template:
      'Always use a literal format string: replace `printf(p)` with `printf("%s", p)`. For dynamic format selection, use a small allowlisted lookup table.',
  },
];
