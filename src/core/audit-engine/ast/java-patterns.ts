// KCode - AST patterns for Java (v2.10.344)
//
// Three patterns covering the dominant Java sinks where caller-
// controlled input is the ballgame:
//
//   java-ast-001  Runtime.getRuntime().exec(p) / new ProcessBuilder(p)
//                 of a parameter (CWE-78 command injection)
//   java-ast-002  new File(p) / new FileInputStream(p) / new FileReader(p)
//                 etc. of a parameter (CWE-22 path traversal)
//   java-ast-003  Class.forName(p) / ClassLoader.loadClass(p)
//                 of a parameter (CWE-470 reflection / CWE-502)
//
// Node-type shapes (verified empirically against tree-sitter-java@0.23):
//   functions              method_declaration | constructor_declaration |
//                          lambda_expression
//   parameter container    formal_parameters
//   parameter shapes       formal_parameter (type + identifier)
//                          spread_parameter (type + variable_declarator(identifier))
//   lambda parameters      inferred_parameters (containing identifiers) OR
//                          bare identifier child of lambda_expression
//   method calls           method_invocation (object . name(args))
//   constructors           object_creation_expression (type . args)

import type { Candidate } from "../types";
import type { AstNode, AstPattern } from "./types";

const JAVA_FUNCTION_NODE_TYPES = new Set([
  "method_declaration",
  "constructor_declaration",
  "lambda_expression",
]);

function findEnclosingFunction(node: AstNode): AstNode | null {
  let cur: AstNode | null = node.parent;
  while (cur !== null) {
    if (JAVA_FUNCTION_NODE_TYPES.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Extract parameter names from a Java function-shaped node.
 *
 * lambda_expression has two shapes:
 *   `x -> body`    — direct `identifier` child is the parameter
 *   `(x) -> body`  — `inferred_parameters` child wraps the identifiers
 *   `(String x) -> body` — `formal_parameters` child wraps formal_parameters
 *
 * method_declaration / constructor_declaration always have a
 * `formal_parameters` child wrapping the params.
 */
function parameterNames(func: AstNode): Set<string> {
  const names = new Set<string>();

  if (func.type === "lambda_expression") {
    // Walk direct children of the lambda to find params.
    for (let i = 0; i < func.namedChildCount; i++) {
      const child = func.namedChild(i);
      if (!child) continue;
      if (child.type === "identifier") {
        // Bare shorthand: `x -> ...`
        names.add(child.text);
        return names;
      }
      if (child.type === "inferred_parameters") {
        // `(x, y) -> ...` — children are identifiers.
        for (let j = 0; j < child.namedChildCount; j++) {
          const sub = child.namedChild(j);
          if (sub && sub.type === "identifier") names.add(sub.text);
        }
        return names;
      }
      // Fall through to formal_parameters handling below.
      if (child.type === "formal_parameters") break;
    }
  }

  // method_declaration / constructor_declaration / explicitly-typed
  // lambda — find the formal_parameters child.
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
    collectJavaParamName(param, names);
  }
  return names;
}

/**
 * Each formal_parameter has shape (type, identifier). Spread (varargs)
 * is `spread_parameter (type, variable_declarator(identifier))` —
 * we recurse one level deeper for that case.
 */
/**
 * v344 audit fix — Java's tree-sitter represents fully-qualified
 * names like `java.io.File` as `scoped_type_identifier` containing
 * a chain of `type_identifier` children. The simple name is the
 * LAST type_identifier descendant. Without this helper the queries
 * only matched the unqualified form (`new File(p)`); any code that
 * writes `new java.io.File(p)` (common in code-generation output and
 * in IDE-imported snippets) silently passed through.
 *
 * For a plain `type_identifier` node we just return its text. For a
 * `scoped_type_identifier`, we walk to the last named child until
 * we find a leaf type_identifier.
 */
function simpleTypeName(node: AstNode): string {
  if (node.type === "type_identifier") return node.text;
  if (node.type === "scoped_type_identifier") {
    // Walk the last named child until we hit a plain type_identifier.
    // Bound at depth 6 to be defensive — `a.b.c.d.e.f.G` is already
    // beyond what real codebases use.
    let cur: AstNode | null = node;
    for (let depth = 0; depth < 6 && cur; depth++) {
      let last: AstNode | null = null;
      for (let i = cur.namedChildCount - 1; i >= 0; i--) {
        const c = cur.namedChild(i);
        if (c) {
          last = c;
          break;
        }
      }
      if (!last) break;
      if (last.type === "type_identifier") return last.text;
      cur = last;
    }
  }
  return node.text;
}

function collectJavaParamName(param: AstNode, names: Set<string>): void {
  if (param.type === "formal_parameter") {
    // Walk children for the identifier (it's typically the second
    // named child after the type, but receiver_parameter can sit at
    // [0] for inner classes with an explicit `this` receiver).
    for (let i = 0; i < param.namedChildCount; i++) {
      const sub = param.namedChild(i);
      if (sub && sub.type === "identifier") {
        names.add(sub.text);
        return;
      }
    }
    return;
  }
  if (param.type === "spread_parameter") {
    // type + variable_declarator(identifier).
    for (let i = 0; i < param.namedChildCount; i++) {
      const sub = param.namedChild(i);
      if (!sub) continue;
      if (sub.type === "variable_declarator") {
        for (let j = 0; j < sub.namedChildCount; j++) {
          const inner = sub.namedChild(j);
          if (inner && inner.type === "identifier") {
            names.add(inner.text);
            return;
          }
        }
      }
      if (sub.type === "identifier") {
        // Some grammar versions use a direct identifier here.
        names.add(sub.text);
        return;
      }
    }
    return;
  }
}

const JAVA_EXEC_METHODS = new Set(["exec"]);
const JAVA_PROCESS_TYPES = new Set(["ProcessBuilder"]);
// v344 audit fix — only types that actually have a String-path
// constructor. BufferedReader / BufferedWriter wrap a Reader / Writer
// (not a path); Scanner(String) treats the string as INPUT TEXT, not
// a path. Including those produced false positives on every routine
// io-pipeline construction. ZipFile / JarFile / PrintStream / FileChannel
// are added — all have legitimate String-path constructors.
const JAVA_FILE_TYPES = new Set([
  "File",
  "FileInputStream",
  "FileOutputStream",
  "FileReader",
  "FileWriter",
  "RandomAccessFile",
  "PrintWriter",
  "PrintStream",
  "ZipFile",
  "JarFile",
]);
const JAVA_REFLECTION_METHODS = new Set([
  "forName",     // Class.forName
  "loadClass",   // ClassLoader.loadClass
]);

export const JAVA_AST_PATTERNS: AstPattern[] = [
  {
    id: "java-ast-001-runtime-exec-of-parameter",
    title: "Runtime.exec / ProcessBuilder of a function parameter (CWE-78 command injection)",
    severity: "critical",
    languages: ["java"],
    /**
     * Two shapes:
     *   x.exec(p)              method_invocation with name "exec"
     *   new ProcessBuilder(p)  object_creation_expression with type ProcessBuilder
     * Type captures cover BOTH plain `type_identifier` AND
     * `scoped_type_identifier` (FQN like `java.lang.ProcessBuilder`)
     * — v344 audit fix; before this only the unqualified form fired.
     * The argument is anchored to position 0; for ProcessBuilder
     * with multiple args (`new ProcessBuilder("sh","-c", p)`) the
     * later-position parameter is the dangerous one but our anchor
     * pins position 0 (the binary). Future enhancement: walk into
     * the argument_list looking for any param-typed identifier.
     */
    query: `
      [
        (method_invocation
          name: (identifier) @method
          arguments: (argument_list . (identifier) @arg))
        (object_creation_expression
          type: (type_identifier) @type
          arguments: (argument_list . (identifier) @arg))
        (object_creation_expression
          type: (scoped_type_identifier) @type
          arguments: (argument_list . (identifier) @arg))
      ]
    `,
    match(captures, _source, file): Candidate | null {
      const arg = captures.arg?.[0];
      if (!arg) return null;
      const method = captures.method?.[0];
      const type = captures.type?.[0];
      let trigger: AstNode | null = null;
      let label = "";
      if (method && JAVA_EXEC_METHODS.has(method.node.text)) {
        trigger = method.node;
        label = `.${method.node.text}(${arg.node.text})`;
      } else if (type) {
        const simple = simpleTypeName(type.node);
        if (!JAVA_PROCESS_TYPES.has(simple)) return null;
        trigger = type.node;
        label = `new ${simple}(${arg.node.text})`;
      } else {
        return null;
      }
      const enclosing = findEnclosingFunction(trigger);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "java-ast-001-runtime-exec-of-parameter",
        severity: "critical",
        file,
        line,
        matched_text: label,
        context: `${label}  // arg is a parameter — caller-controlled binary or shell command`,
      };
    },
    explanation:
      "Runtime.getRuntime().exec(...) or new ProcessBuilder(...) invoked with a value AST-traced to a function parameter. exec(String) goes through Runtime#exec which tokenizes on whitespace — passing a single user-controlled string leaks the ability to invoke any binary. ProcessBuilder is shell-free but the parameter typically becomes argv[0] (the binary path). Note: any user-defined method literally named `exec` will also match the .exec(p) shape; the verifier should de-duplicate against actual Runtime/Process callers.",
    verify_prompt:
      "Is the function exposed to caller-controlled input?\n" +
      "1. Servlet / @RestController handler / message consumer / CLI parser — CONFIRMED.\n" +
      "2. The receiver of .exec is NOT java.lang.Runtime / java.lang.Process — could be a user-defined method named exec, possibly FALSE_POSITIVE depending on its semantics.\n" +
      "3. Argument is allowlisted before this call — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED.",
    cwe: "CWE-78",
    fix_template:
      "Use ProcessBuilder with a hardcoded binary and the user input as a later argv element. Validate against an allowlist when dynamic dispatch is required. Never pass concatenated shell strings.",
  },

  {
    id: "java-ast-002-file-construction-of-parameter",
    title: "new File / FileInputStream / FileReader of a function parameter (CWE-22 path traversal)",
    severity: "high",
    languages: ["java"],
    query: `
      [
        (object_creation_expression
          type: (type_identifier) @type
          arguments: (argument_list . (identifier) @arg))
        (object_creation_expression
          type: (scoped_type_identifier) @type
          arguments: (argument_list . (identifier) @arg))
      ]
    `,
    match(captures, _source, file): Candidate | null {
      const type = captures.type?.[0];
      const arg = captures.arg?.[0];
      if (!type || !arg) return null;
      const simple = simpleTypeName(type.node);
      if (!JAVA_FILE_TYPES.has(simple)) return null;
      const enclosing = findEnclosingFunction(type.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "java-ast-002-file-construction-of-parameter",
        severity: "high",
        file,
        line,
        matched_text: `new ${simple}(${arg.node.text})`,
        context: `new ${simple}(${arg.node.text})  // arg is a parameter — path traversal candidate`,
      };
    },
    explanation:
      "java.io.File / FileInputStream / FileReader / RandomAccessFile (and friends) constructed with a path AST-traced to a function parameter. Without a canonicalize + base-prefix check, an attacker controlling this parameter can read or write files outside the intended directory via `../`.",
    verify_prompt:
      "Is the function exposed to caller-controlled input?\n" +
      "1. HTTP handler / RPC method taking a path/filename arg — CONFIRMED unless validated.\n" +
      "2. Code calls `new File(p).getCanonicalPath().startsWith(BASE_DIR)` (or equivalent) before this construction — FALSE_POSITIVE.\n" +
      "3. Internal-only callers, hardcoded paths — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED.",
    cwe: "CWE-22",
    fix_template:
      "Canonicalize the path with Path.toAbsolutePath().normalize() and verify the result has the expected base prefix. Reject any input containing `..` AFTER normalization.",
  },

  {
    id: "java-ast-003-class-forname-of-parameter",
    title: "Class.forName / ClassLoader.loadClass of a function parameter (CWE-470 reflection)",
    severity: "high",
    languages: ["java"],
    query: `
      (method_invocation
        name: (identifier) @method
        arguments: (argument_list . (identifier) @arg))
    `,
    match(captures, _source, file): Candidate | null {
      const method = captures.method?.[0];
      const arg = captures.arg?.[0];
      if (!method || !arg) return null;
      if (!JAVA_REFLECTION_METHODS.has(method.node.text)) return null;
      const enclosing = findEnclosingFunction(method.node);
      if (!enclosing) return null;
      const params = parameterNames(enclosing);
      if (!params.has(arg.node.text)) return null;
      const line = arg.node.startPosition.row + 1;
      return {
        pattern_id: "java-ast-003-class-forname-of-parameter",
        severity: "high",
        file,
        line,
        matched_text: `.${method.node.text}(${arg.node.text})`,
        context: `.${method.node.text}(${arg.node.text})  // arg is a parameter — caller picks which class is loaded`,
      };
    },
    explanation:
      "Class.forName / ClassLoader.loadClass invoked with a class name AST-traced to a function parameter. Letting a caller pick which class is loaded (and frequently followed by a no-arg newInstance() or constructor reflection) lets an attacker instantiate gadget classes — the canonical Java deserialization-attack vector. Also relevant for CVE-2017-9805-style attacks on legacy XML / serialization stacks.",
    verify_prompt:
      "Is the function exposed to caller-controlled input?\n" +
      "1. HTTP/RPC handler, configuration loader reading user-supplied class names — CONFIRMED.\n" +
      "2. Class name is allowlisted against a fixed set BEFORE forName/loadClass — FALSE_POSITIVE.\n" +
      "3. Loaded class is immediately cast to a sealed interface AND the user can't pick the interface — FALSE_POSITIVE if the cast actually constrains the runtime type.\n" +
      "Default to CONFIRMED.",
    cwe: "CWE-470",
    fix_template:
      "Maintain a `Map<String, Class<?>>` allowlist of legitimate dispatchable types. Look up by key and reject misses. Never pass user input directly to forName.",
  },
];
