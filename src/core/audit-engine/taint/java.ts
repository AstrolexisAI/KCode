// KCode - Java taint flow classifier (Fix #3, v2.10.399)
//
// Intra-procedural origin classifier for Java variables. Given a
// candidate from the regex pattern library, walks the variable's
// assignment chain backward inside the same file and returns one
// of:
//
//   tainted    — the variable's value flows from a Servlet API or
//                another known untrusted source
//   constant   — the value is provably a literal, or built only
//                from literals
//   sanitized  — a tainted value was wrapped by a known neutralizing
//                call (e.g. Integer.parseInt, ESAPI.encoder()) before
//                reaching the candidate's match site
//   unknown    — couldn't classify (preserves recall: caller keeps
//                the candidate)
//
// Phase 1: intra-procedural only (within-file, single method body).
// Phase 2 will resolve same-file method calls; Phase 3 will fan out
// across files in the same directory; Phase 4 will add literal
// constant-folding for trivial conditionals; Phase 5 ties it together
// and re-benchmarks.

import type { Candidate } from "../types";
import type { ClassifyContext, ClassifyResult } from "./types";

// ── Source / sanitizer DBs ────────────────────────────────────────

/**
 * Top-level method calls whose return value is treated as untrusted.
 * Each regex matches a call expression's *prefix* (it's tested
 * against a trimmed candidate RHS, anchored to start).
 *
 * Built from the Servlet API surface used by OWASP Benchmark v1.2:
 * any of these as the right-hand side of an assignment marks the
 * variable as tainted.
 */
const TAINT_SOURCE_RES: RegExp[] = [
  /^request\.getParameter\s*\(/,
  /^request\.getParameterValues\s*\(/,
  /^request\.getParameterMap\s*\(/,
  /^request\.getCookies\s*\(/,
  /^request\.getHeader\s*\(/,
  /^request\.getHeaders\s*\(/,
  /^request\.getQueryString\s*\(/,
  /^request\.getRequestURI\s*\(/,
  /^request\.getRequestURL\s*\(/,
  /^request\.getInputStream\s*\(/,
  /^request\.getReader\s*\(/,
  /^request\.getRemoteHost\s*\(/,
  /^request\.getRemoteAddr\s*\(/,
  /^request\.getRemoteUser\s*\(/,
  /^System\.getenv\s*\(/,
  /^System\.getProperty\s*\(/,
  // Cookie iteration shape: theCookie.getValue() / .getName()
  /\.getValue\s*\(\s*\)\s*$/,
  /\.getName\s*\(\s*\)\s*$/,
];

/**
 * Method calls that neutralize a tainted argument by type-coercion
 * or output encoding. Tested as a prefix on a trimmed RHS.
 *
 * Coercion-style sanitizers (parseInt, parseLong, fromString) are
 * sound for SQL injection because the parsed-then-stringified value
 * can never carry quotes/semicolons. Encoder-style sanitizers
 * (ESAPI, StringEscapeUtils, OWASP Java Encoder) are categorical:
 * we accept that any encoded path neutralizes the matching CWE.
 */
const SANITIZER_RES: RegExp[] = [
  /^Integer\.parseInt\s*\(/,
  /^Long\.parseLong\s*\(/,
  /^Short\.parseShort\s*\(/,
  /^Byte\.parseByte\s*\(/,
  /^Float\.parseFloat\s*\(/,
  /^Double\.parseDouble\s*\(/,
  /^Boolean\.parseBoolean\s*\(/,
  /^UUID\.fromString\s*\(/,
  /^java\.util\.UUID\.fromString\s*\(/,
  /^ESAPI\.encoder\s*\(\s*\)\.encodeForHTML\s*\(/,
  /^ESAPI\.encoder\s*\(\s*\)\.encodeForHTMLAttribute\s*\(/,
  /^ESAPI\.encoder\s*\(\s*\)\.encodeForJavaScript\s*\(/,
  /^ESAPI\.encoder\s*\(\s*\)\.encodeForJSON\s*\(/,
  /^ESAPI\.encoder\s*\(\s*\)\.encodeForLDAP\s*\(/,
  /^ESAPI\.encoder\s*\(\s*\)\.encodeForXPath\s*\(/,
  /^ESAPI\.encoder\s*\(\s*\)\.encodeForOS\s*\(/,
  /^org\.owasp\.esapi\.ESAPI\.encoder\s*\(\s*\)\.encodeFor\w+\s*\(/,
  /^StringEscapeUtils\.escapeHtml(?:4)?\s*\(/,
  /^StringEscapeUtils\.escapeJava(?:Script)?\s*\(/,
  /^StringEscapeUtils\.escapeXml(?:10|11)?\s*\(/,
  /^StringEscapeUtils\.escapeSql\s*\(/,
  /^Encode\.forHtml(?:Content|Attribute)?\s*\(/,
  /^Encode\.forJavaScript(?:Block|Source|Attribute)?\s*\(/,
  /^Encode\.forJava\s*\(/,
  /^org\.owasp\.encoder\.Encode\.forHtml\w*\s*\(/,
];

/**
 * The regex pattern IDs whose candidates we attempt to classify.
 * Patterns not in this set are passed through untouched — preserves
 * recall on the patterns we haven't analyzed.
 *
 * Selection: high-FP-volume patterns observed in the OWASP Benchmark
 * v1.2 diagnostic (see scripts/diagnose-owasp-fps.py output).
 */
const TAINT_FLOW_PATTERN_IDS: ReadonlySet<string> = new Set([
  "java-001-sql-injection",
  "java-007-sql-concat-prepared",
  "java-023-sql-injection-var-flow",
  "java-024-xss-writer-direct",
  "java-026-path-traversal-var-flow",
  "java-030-xss-writer-non-literal",
  "java-031-cmdi-exec-non-literal",
  "java-032-path-file-non-literal",
  "java-033-ldap-non-literal",
]);

export function shouldClassifyForTaint(patternId: string): boolean {
  return TAINT_FLOW_PATTERN_IDS.has(patternId);
}

// ── Variable-name extraction ──────────────────────────────────────

/**
 * Pull the "tainted variable" name out of a Candidate's matched_text.
 *
 * The patterns we hook into come in two shapes:
 *
 *   var-flow: matched_text begins with "String <var> = ..." and the
 *             variable is the one feeding the sink later in the match.
 *
 *   sink:    matched_text contains a sink call like
 *            "response.getWriter().println(<var>)" and the variable
 *            is the rightmost identifier inside that call.
 */
export function extractTaintedVarName(candidate: Candidate): string | null {
  const text = candidate.matched_text;
  if (!text) return null;

  const decl = text.match(/\bString\s+(\w+)\s*=/);
  if (decl?.[1]) return decl[1];

  const sinkCalls = [...text.matchAll(/\(\s*([a-zA-Z_]\w*)\s*[,)]/g)];
  const last = sinkCalls[sinkCalls.length - 1];
  if (last?.[1]) return last[1];
  return null;
}

// ── Expression parsing helpers ────────────────────────────────────

function extractFirstArg(callExpr: string): string | null {
  const open = callExpr.indexOf("(");
  if (open === -1) return null;
  let depth = 0;
  let inString = false;
  let stringChar = "";
  let start = open + 1;
  for (let i = open; i < callExpr.length; i++) {
    const ch = callExpr[i];
    if (inString) {
      if (ch === stringChar && callExpr[i - 1] !== "\\") inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return callExpr.slice(start, i).trim();
    } else if (ch === "," && depth === 1) {
      return callExpr.slice(start, i).trim();
    }
  }
  return null;
}

function splitTopLevelConcat(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let stringChar = "";
  let cur = "";
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inString) {
      cur += ch;
      if (ch === stringChar && expr[i - 1] !== "\\") inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "+" && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// ── Single-expression classification ──────────────────────────────

/**
 * Classify a single RHS expression. Recurses through concat and
 * sanitizer wrappers; identifiers and method calls return "unknown"
 * here — caller is responsible for the variable walk and (in Phase 2)
 * for resolving method declarations.
 */
export function classifyExpression(
  expr: string,
  ctx: ClassifyContext = {},
): ClassifyResult {
  const depth = ctx.depth ?? 0;
  const maxDepth = ctx.maxDepth ?? 8;
  if (depth > maxDepth) {
    return { origin: "unknown", reason: "max recursion depth" };
  }

  const trimmed = expr.trim();
  if (!trimmed) return { origin: "unknown", reason: "empty" };

  if (/^"[^"\\]*(?:\\.[^"\\]*)*"$/.test(trimmed)) {
    return { origin: "constant", reason: "string literal" };
  }

  if (/^-?\d+(\.\d+)?[fFlLdD]?$/.test(trimmed)) {
    return { origin: "constant", reason: "numeric literal" };
  }

  if (trimmed === "true" || trimmed === "false" || trimmed === "null") {
    return { origin: "constant", reason: "boolean/null literal" };
  }

  for (const sanRe of SANITIZER_RES) {
    if (sanRe.test(trimmed)) {
      const inner = extractFirstArg(trimmed);
      if (inner !== null) {
        const innerCls = classifyExpression(inner, { ...ctx, depth: depth + 1 });
        if (innerCls.origin === "constant") {
          return { origin: "constant", reason: "sanitizer over constant" };
        }
        return { origin: "sanitized", reason: "wrapped by known sanitizer" };
      }
      return { origin: "sanitized", reason: "wrapped by known sanitizer" };
    }
  }

  for (const srcRe of TAINT_SOURCE_RES) {
    if (srcRe.test(trimmed)) {
      return { origin: "tainted", reason: "Servlet API source" };
    }
  }

  if (trimmed.includes("+")) {
    const parts = splitTopLevelConcat(trimmed);
    if (parts.length > 1) {
      let hasTainted = false;
      let hasUnknown = false;
      let hasSanitized = false;
      for (const p of parts) {
        const cls = classifyExpression(p, { ...ctx, depth: depth + 1 });
        if (cls.origin === "tainted") hasTainted = true;
        else if (cls.origin === "unknown") hasUnknown = true;
        else if (cls.origin === "sanitized") hasSanitized = true;
      }
      if (hasTainted) {
        return { origin: "tainted", reason: "concat contains tainted operand" };
      }
      if (hasUnknown) {
        return { origin: "unknown", reason: "concat with unclassified operand" };
      }
      if (hasSanitized) {
        return { origin: "sanitized", reason: "concat of sanitized + constants" };
      }
      return { origin: "constant", reason: "concat of constants" };
    }
  }

  // Plain identifier — resolve by collecting ALL recent assignments to
  // this variable within the surrounding scope and merging their
  // verdicts conservatively. This handles `if/else` and `switch/case`
  // shapes where the variable is reassigned across branches.
  if (/^\w+$/.test(trimmed)) {
    // Phase 5 lite — parameter binding: if we're inside a callee's
    // body and the identifier names a parameter, return the
    // call-site classification.
    if (ctx.paramBindings?.has(trimmed)) {
      const bound = ctx.paramBindings.get(trimmed);
      if (bound) return { ...bound, reason: `param '${trimmed}' bound: ${bound.reason}` };
    }
    if (!ctx.fileContent || ctx.currentLine == null) {
      return { origin: "unknown", reason: `identifier '${trimmed}' (no file ctx)` };
    }
    const visited = ctx.visited ?? new Set<string>();
    if (visited.has(trimmed)) {
      return { origin: "unknown", reason: "variable cycle" };
    }
    const nextVisited = new Set(visited);
    nextVisited.add(trimmed);
    const assigns = findAllAssignmentsInScope(
      ctx.fileContent,
      trimmed,
      ctx.currentLine,
    );
    if (assigns.length === 0) {
      return { origin: "unknown", reason: `no assignment for '${trimmed}'` };
    }
    // Merge each branch's verdict. Conservative ordering:
    //   tainted   beats anything (one path leaks → leaks)
    //   unknown   beats sanitized/constant (we can't prove safety)
    //   sanitized beats constant (any sanitizer path makes the value
    //             "encoded" but not literal)
    //   constant  if and only if every branch is constant
    let hasTainted = false;
    let hasUnknown = false;
    let hasSanitized = false;
    let hasConstant = false;
    let lastEvidence: number | undefined;
    for (const a of assigns) {
      const sub = classifyExpression(a.rhs, {
        ...ctx,
        currentLine: a.line,
        visited: nextVisited,
        depth: depth + 1,
      });
      if (sub.origin === "tainted") hasTainted = true;
      else if (sub.origin === "unknown") hasUnknown = true;
      else if (sub.origin === "sanitized") hasSanitized = true;
      else if (sub.origin === "constant") hasConstant = true;
      if (lastEvidence === undefined) lastEvidence = a.line;
    }
    if (hasTainted) {
      return { origin: "tainted", reason: `'${trimmed}' has tainted branch`, evidenceLine: lastEvidence };
    }
    if (hasUnknown) {
      return { origin: "unknown", reason: `'${trimmed}' has unclassified branch`, evidenceLine: lastEvidence };
    }
    if (hasSanitized) {
      return { origin: "sanitized", reason: `'${trimmed}' sanitized in all paths`, evidenceLine: lastEvidence };
    }
    if (hasConstant) {
      return { origin: "constant", reason: `'${trimmed}' constant in all paths`, evidenceLine: lastEvidence };
    }
    return { origin: "unknown", reason: `'${trimmed}' empty merge` };
  }

  // Method call — resolve same-file (Phase 2) or cross-file (Phase 3)
  // by parsing the target method's declaration and merging the
  // verdicts of its return statements.
  if (/^\w+(?:\.\w+)*\s*\(/.test(trimmed)) {
    return classifyMethodCall(trimmed, { ...ctx, depth: depth + 1 });
  }

  return { origin: "unknown", reason: "unhandled expression shape" };
}

// ── Phase 2/3: method resolution ───────────────────────────────────

/**
 * Classify a method call by resolving the target method's body —
 * either in the current file (Phase 2) or in another file in the
 * same directory (Phase 3, when ctx.filesInDir is provided).
 *
 * Forms recognized:
 *   methodName(args)          — same-class instance/static method
 *   obj.methodName(args)      — instance method (obj traced to `new ClassName(...)`)
 *   Class.staticMethod(args)  — static method on a known class
 */
export function classifyMethodCall(
  callExpr: string,
  ctx: ClassifyContext,
): ClassifyResult {
  const depth = ctx.depth ?? 0;
  if (depth > (ctx.maxDepth ?? 8)) {
    return { origin: "unknown", reason: "max recursion in method resolve" };
  }

  // Strip leading `(Type)` cast: `(String) foo.bar()` → `foo.bar()`
  let expr = callExpr.trim();
  expr = expr.replace(/^\(\s*\w[\w.]*\s*\)\s*/, "");

  const callMatch = expr.match(/^(?:([\w.]+)\.)?(\w+)\s*\(/);
  if (!callMatch) return { origin: "unknown", reason: "unparseable call" };
  const qualifier = callMatch[1] ?? "";
  const methodName = callMatch[2] ?? "";
  if (!methodName) return { origin: "unknown", reason: "no method name" };

  // Pick the target file content. Default to the current file.
  let targetContent: string | undefined = ctx.fileContent;
  let resolvedAcrossFile = false;

  if (qualifier && ctx.filesInDir) {
    // Static call: qualifier itself is the class name.
    if (/^[A-Z]/.test(qualifier) && !qualifier.includes(".")) {
      const cross = ctx.filesInDir.get(qualifier);
      if (cross) {
        targetContent = cross;
        resolvedAcrossFile = true;
      }
    } else if (!qualifier.includes(".")) {
      // Lowercase qualifier — likely an instance variable. Trace it
      // to its `new ClassName(...)` assignment in the current file.
      const className =
        ctx.fileContent && ctx.currentLine != null
          ? resolveClassOfVariable(ctx.fileContent, qualifier, ctx.currentLine)
          : null;
      if (className) {
        const cross = ctx.filesInDir.get(className);
        if (cross) {
          targetContent = cross;
          resolvedAcrossFile = true;
        }
      }
    }
  }

  if (!targetContent) {
    return { origin: "unknown", reason: "no resolvable target file" };
  }

  const sigInfo = findMethodSignature(targetContent, methodName);
  if (sigInfo === null) {
    return { origin: "unknown", reason: `method ${methodName} not found` };
  }
  const { paramNames, body } = sigInfo;
  const returns = findReturnExpressions(body);
  if (returns.length === 0) {
    return { origin: "unknown", reason: `${methodName} has no return` };
  }

  // Phase 5 — parameter binding: classify each call-site argument
  // in the CALLER's context, then bind to the method's parameter
  // names so that `return param;` and `if (cond) bar = param;` shapes
  // inside the callee resolve to the actual caller value.
  const callerArgs = parseCallArgs(expr);
  const paramBindings = new Map<string, ClassifyResult>();
  for (let i = 0; i < paramNames.length && i < callerArgs.length; i++) {
    const arg = callerArgs[i];
    const name = paramNames[i];
    if (arg === undefined || name === undefined) continue;
    paramBindings.set(name, classifyExpression(arg, ctx));
  }

  // Merge return verdicts conservatively. tainted ⊐ unknown ⊐
  // sanitized ⊐ constant.
  let hasTainted = false;
  let hasUnknown = false;
  let hasSanitized = false;
  let hasConstant = false;
  // Recurse with a fresh ctx scoped to the method body so that
  // intra-body variable walks resolve against the right line numbers
  // (findReturnExpressions emits body-relative lines, not absolute
  // file-relative). visited gets reset since identifiers in the
  // callee are a different scope.
  const subCtx: ClassifyContext = {
    ...ctx,
    fileContent: body,
    currentLine: undefined,
    visited: new Set(),
    paramBindings,
    depth: depth + 1,
  };
  for (const ret of returns) {
    // For each return, we need a currentLine for in-callee identifier
    // walks. Use the line where the return statement sits.
    const sub = classifyExpression(ret.expr, {
      ...subCtx,
      currentLine: ret.line,
    });
    if (sub.origin === "tainted") hasTainted = true;
    else if (sub.origin === "unknown") hasUnknown = true;
    else if (sub.origin === "sanitized") hasSanitized = true;
    else if (sub.origin === "constant") hasConstant = true;
  }
  const tag = resolvedAcrossFile ? " (cross-file)" : "";
  if (hasTainted) {
    return { origin: "tainted", reason: `${methodName} returns tainted${tag}` };
  }
  if (hasUnknown) {
    return { origin: "unknown", reason: `${methodName} returns unclassified${tag}` };
  }
  if (hasSanitized) {
    return { origin: "sanitized", reason: `${methodName} returns sanitized${tag}` };
  }
  if (hasConstant) {
    return { origin: "constant", reason: `${methodName} returns constant${tag}` };
  }
  return { origin: "unknown", reason: `${methodName} empty merge` };
}

/**
 * Trace a local variable `varName` back to the class it was assigned
 * to via `new ClassName(...)`. Returns the class name, or null when
 * the variable isn't traceable to a constructor invocation in scope.
 *
 * Handles two declaration shapes:
 *   ClassName varName = new ClassName(...);
 *   <Type> varName = new ClassName(...);    (varName uses field type)
 *   ClassName varName;       (declaration only)
 *   varName = new ClassName(...);
 */
export function resolveClassOfVariable(
  fileContent: string,
  varName: string,
  beforeLine: number,
): string | null {
  const assigns = findAllAssignmentsInScope(fileContent, varName, beforeLine);
  for (const a of assigns) {
    const m = a.rhs.match(/^new\s+([\w.]+)\s*\(/);
    if (m && m[1]) return m[1].split(".").pop() ?? m[1];
  }
  // Fall back: scan for `<Type> varName` declaration anywhere before
  // beforeLine — picks up the field type even when no `new` is visible.
  const lines = fileContent.split("\n");
  const stop = Math.min(beforeLine - 1, lines.length - 1);
  const declRe = new RegExp(
    String.raw`(?:^|[^=!<>\w])([A-Z]\w*)\s+\b${escapeReg(varName)}\b\s*[;=]`,
  );
  for (let i = stop; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = line.match(declRe);
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * Locate a method's body in a Java source file. Returns the body
 * text (without surrounding braces) or null when the method isn't
 * found.
 *
 * This is a regex-based heuristic — sufficient for the OWASP
 * helper-class shape. Handles overloads by picking the first match.
 */
export function findMethodBody(
  fileContent: string,
  methodName: string,
): string | null {
  return findMethodSignature(fileContent, methodName)?.body ?? null;
}

/**
 * Same as findMethodBody, but also extracts the parameter names so
 * the caller can bind each call-site argument before classifying
 * the body's return statements.
 */
export function findMethodSignature(
  fileContent: string,
  methodName: string,
): { paramNames: string[]; body: string } | null {
  const re = new RegExp(
    String.raw`(?:public|protected|private|static|\s)+\s+[\w.<>\[\]]+\s+\b${escapeReg(methodName)}\s*\(([^)]*)\)\s*(?:throws[^{]*)?\{`,
    "g",
  );
  const m = re.exec(fileContent);
  if (!m) return null;
  const paramList = (m[1] ?? "").trim();
  const paramNames: string[] = [];
  if (paramList) {
    for (const p of paramList.split(",")) {
      // Each parameter looks like `Type name`, `final Type name`, or
      // `Type<X> name`. We just want the trailing identifier.
      const tokens = p.trim().split(/\s+/);
      const last = tokens[tokens.length - 1];
      if (last) paramNames.push(last.replace(/^\.{3}/, "")); // varargs
    }
  }
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let inString = false;
  let stringChar = "";
  for (let i = start; i < fileContent.length; i++) {
    const ch = fileContent[i];
    if (inString) {
      if (ch === stringChar && fileContent[i - 1] !== "\\") inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return { paramNames, body: fileContent.slice(start + 1, i) };
      }
    }
  }
  return null;
}

/**
 * Parse the comma-separated arguments of a call expression
 * `name(arg1, arg2, ...)` respecting nested parens / brackets and
 * string literals. Returns each argument's text in order.
 */
export function parseCallArgs(callExpr: string): string[] {
  const open = callExpr.indexOf("(");
  if (open === -1) return [];
  const args: string[] = [];
  let depth = 0;
  let inString = false;
  let stringChar = "";
  let cur = "";
  for (let i = open; i < callExpr.length; i++) {
    const ch = callExpr[i];
    if (inString) {
      cur += ch;
      if (ch === stringChar && callExpr[i - 1] !== "\\") inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      cur += ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      if (depth === 1) continue;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        if (cur.trim()) args.push(cur.trim());
        return args;
      }
    } else if (ch === "[" || ch === "{") {
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
    } else if (ch === "," && depth === 1) {
      args.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  return args;
}

/**
 * Extract `return X;` expressions from a method body. Returns each
 * RHS along with its 1-indexed line within the body. Empty `return;`
 * (void return) is omitted from the result.
 */
export function findReturnExpressions(
  body: string,
): Array<{ expr: string; line: number }> {
  const out: Array<{ expr: string; line: number }> = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(/^\s*return\s+([^;]+);/);
    if (m && m[1]) out.push({ expr: m[1].trim(), line: i + 1 });
  }
  return out;
}

// ── Variable origin walk ──────────────────────────────────────────

/**
 * Find the most recent assignment of `varName` at or before
 * `beforeLine` in `fileContent`. Returns the RHS text and the
 * line where the assignment starts. Handles single-line and
 * multi-line (statement spanning lines until `;`) assignments.
 *
 * Reassignment shapes recognized:
 *   String x = ...;
 *   final String x = ...;
 *   x = ...;
 *   <Type> x = ...;       (any single-token type)
 */
export function findLastAssignment(
  fileContent: string,
  varName: string,
  beforeLine: number,
): { rhs: string; line: number } | null {
  const all = findAllAssignmentsInScope(fileContent, varName, beforeLine);
  if (all.length === 0) return null;
  // Single unconditional assignment is the trivial case.
  if (all.length === 1 && !all[0]!.inBranch) {
    return { rhs: all[0]!.rhs, line: all[0]!.line };
  }
  return null;
}

/**
 * Collect all assignments of `varName` in the scope ending at
 * `beforeLine`, walking back up to `lookback` lines. Each entry
 * carries the RHS expression, its line number, and a conservative
 * flag for whether the assignment was found inside a control-flow
 * branch (if/else/case/default). The classifier merges these
 * conservatively so a branch assigning a tainted value defeats
 * a sibling branch's literal constant.
 */
export function findAllAssignmentsInScope(
  fileContent: string,
  varName: string,
  beforeLine: number,
  lookback = 80,
): Array<{ rhs: string; line: number; inBranch: boolean }> {
  const lines = fileContent.split("\n");
  const startLine = Math.min(beforeLine - 1, lines.length - 1);
  const stopLine = Math.max(0, startLine - lookback);
  const assignRe = new RegExp(
    String.raw`(?:^|[^=!<>\w])\b${escapeReg(varName)}\s*=(?!=)\s*(.*)$`,
  );
  const out: Array<{ rhs: string; line: number; inBranch: boolean }> = [];
  // Track brace depth as we scan backward — when we exit the
  // enclosing block (depth becomes positive after seeing more `}`
  // than `{` going back), we've crossed into a sibling method or
  // outer scope and should stop.
  let braceDepth = 0;
  for (let i = startLine; i >= stopLine; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    // Count braces (ignoring those inside strings — best-effort).
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (ch === "}") braceDepth++;
      else if (ch === "{") braceDepth--;
    }
    // We exited the block we started in. Going backward, each `{`
    // decrements depth (we entered the block from outside) — if
    // depth drops below 0 we've crossed the opening brace of the
    // method/block enclosing our start position and should stop.
    if (braceDepth < 0) break;
    const m = line.match(assignRe);
    if (!m || m[1] === undefined) continue;
    let rhs = m[1];
    if (rhs.includes(";")) {
      rhs = rhs.slice(0, rhs.lastIndexOf(";"));
    } else {
      for (let j = i + 1; j < lines.length; j++) {
        const tail = lines[j];
        if (tail === undefined) break;
        if (tail.includes(";")) {
          rhs += " " + tail.slice(0, tail.indexOf(";"));
          break;
        }
        rhs += " " + tail.trim();
      }
    }
    // Phase 4 — constant folding: if this assignment lives inside a
    // branch whose controlling `if (...)` is foldable to a literal
    // boolean, skip the unreachable side. Returns null when the
    // branch is dead, in which case we drop the assignment from the
    // merge entirely.
    const branchKind = classifyBranchPosition(lines, i);
    if (branchKind === "dead") continue;
    out.push({
      rhs: rhs.trim(),
      line: i + 1,
      inBranch: branchKind !== "unconditional",
    });
  }
  return out;
}

/**
 * Decide whether a one-liner assignment at lineIdx is:
 *   "unconditional"   — top-level method body assignment
 *   "live"            — inside a control-flow branch we can't fold
 *   "dead"            — inside an unreachable branch (constant-folded)
 *
 * The folding is best-effort: we only walk back ~3 lines for an
 * `if (...)` and try to evaluate the condition with literals and
 * simple integer-typed local variables (`int n = 196;` style).
 */
function classifyBranchPosition(
  lines: string[],
  lineIdx: number,
): "unconditional" | "live" | "dead" {
  const line = lines[lineIdx] ?? "";
  // `else <var> = ...` — controlling `if (cond)` is on a previous line.
  if (/^\s*else\b/.test(line)) {
    const cond = findControllingIfCondition(lines, lineIdx, /* isElse= */ true);
    if (cond !== null) {
      const folded = evaluateConstantBoolExpr(cond, lines, lineIdx);
      if (folded === true) return "dead";
      if (folded === false) return "unconditional";
    }
    return "live";
  }
  // One-liner `if (cond) <var> = ...`
  const inlineIfCond = extractIfCondition(line);
  if (inlineIfCond !== null && /=\s*[^=]/.test(line)) {
    const folded = evaluateConstantBoolExpr(inlineIfCond, lines, lineIdx);
    if (folded === true) return "unconditional";
    if (folded === false) return "dead";
    return "live";
  }
  // Body of a previous-line control statement
  for (let j = lineIdx - 1; j >= Math.max(0, lineIdx - 3); j--) {
    const prev = lines[j];
    if (prev === undefined) break;
    const trimmedPrev = prev.trim();
    if (trimmedPrev === "" || trimmedPrev.startsWith("//")) continue;
    const prevCond = extractIfCondition(prev);
    if (prevCond !== null && !prev.includes(";")) {
      const folded = evaluateConstantBoolExpr(prevCond, lines, j);
      if (folded === true) return "unconditional";
      if (folded === false) return "dead";
      return "live";
    }
    if (/^\s*(?:case\s+[^:]+|default)\s*:\s*$/.test(prev)) return "live";
    break;
  }
  return "unconditional";
}

/**
 * Extract the condition expression text inside `if (...)` from a
 * line, balancing nested parentheses correctly (the regex
 * `\([^)]+\)` is wrong because it stops at the first inner `)`).
 *
 * Returns null when the line doesn't open an `if` / `else if`.
 */
function extractIfCondition(line: string): string | null {
  const m = line.match(/^\s*}?\s*(?:else\s+)?if\s*\(/);
  if (!m) return null;
  const start = m.index! + m[0].length;
  let depth = 1;
  for (let i = start; i < line.length; i++) {
    const ch = line[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return line.slice(start, i);
    }
  }
  return null;
}

/**
 * Walk back from `lineIdx` (the `else` body line) to find the
 * matching `if (cond)` opener. Returns the cond text or null.
 */
function findControllingIfCondition(
  lines: string[],
  lineIdx: number,
  isElse: boolean,
): string | null {
  void isElse;
  for (let j = lineIdx - 1; j >= Math.max(0, lineIdx - 6); j--) {
    const prev = lines[j];
    if (prev === undefined) break;
    if (prev.trim() === "") continue;
    const cond = extractIfCondition(prev);
    if (cond !== null) return cond;
  }
  return null;
}

/**
 * Best-effort evaluator for a Java boolean expression made of
 * integer literals, simple `int <n> = <literal>;` references, and
 * the operators `+ - * / > < >= <= == !=`. Returns true/false when
 * the expression folds to a literal; null otherwise.
 *
 * Used to fold OWASP-style guard conditions like
 *   `int num = 196; if ((500 / 42) + num > 200) ...`
 * which always take the if branch by construction.
 */
export function evaluateConstantBoolExpr(
  expr: string,
  lines: string[],
  fromLineIdx: number,
): boolean | null {
  // Substitute integer locals: `int <name> = <literal>;` within
  // the preceding ~20 lines. Numeric only.
  const intLocals = new Map<string, number>();
  const stop = Math.max(0, fromLineIdx - 20);
  for (let j = fromLineIdx - 1; j >= stop; j--) {
    const line = lines[j];
    if (line === undefined) continue;
    const m = line.match(
      /^\s*(?:final\s+)?(?:int|long|short|byte)\s+(\w+)\s*=\s*(-?\d+)\s*;/,
    );
    if (m && m[1] !== undefined && m[2] !== undefined) {
      intLocals.set(m[1], parseInt(m[2], 10));
    }
  }
  let substituted = expr;
  for (const [name, val] of intLocals) {
    const re = new RegExp(String.raw`\b${escapeReg(name)}\b`, "g");
    substituted = substituted.replace(re, String(val));
  }
  // Reject anything that doesn't look like a pure numeric/boolean
  // expression after substitution.
  if (!/^[\d\s+\-*/%()<>=!&|.]+$/.test(substituted)) return null;
  try {
    // Restrict allowed operators in the final string. `eval` would be
    // unsafe with arbitrary input; here we've already gated on the
    // character class above.
    // biome-ignore lint/security/noGlobalEval: input is gated by regex
    const result = (0, eval)(substituted);
    if (typeof result === "boolean") return result;
    if (typeof result === "number") return result !== 0;
  } catch {
    return null;
  }
  return null;
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True if the assignment at lineIdx (0-indexed) is part of a
 * conditional branch — either a one-liner starting with `else ` /
 * `if (...) ... = ...`, or the body of a control statement opened
 * on a preceding line whose own line lacks a `;` and ends in `)`
 * with leading `if`/`else if`/`for`/`while`. Conservative: any of
 * these shapes returns true so the caller declines to classify.
 */
function isInsideConditionalBranch(lines: string[], lineIdx: number): boolean {
  const line = lines[lineIdx] ?? "";
  // One-liner `else <var> = ...` or `else if (...) <var> = ...`
  if (/^\s*else\b/.test(line)) return true;
  // One-liner `if (...) <var> = ...`
  if (/^\s*}?\s*(?:else\s+)?if\s*\(/.test(line) && /=\s*[^=]/.test(line)) return true;
  // Walk back over blank/comment lines to find the closest non-empty
  // preceding line. If it opens a control flow construct (if/for/while
  // without `;`) or is a `case`/`default:` label, the assignment is
  // a branch body and we bail conservatively.
  for (let j = lineIdx - 1; j >= Math.max(0, lineIdx - 3); j--) {
    const prev = lines[j];
    if (prev === undefined) break;
    const trimmedPrev = prev.trim();
    if (trimmedPrev === "" || trimmedPrev.startsWith("//")) continue;
    if (/^\s*}?\s*(?:else\s+)?(?:if|for|while)\s*\(/.test(prev) && !prev.includes(";")) {
      return true;
    }
    // `case <const>:` / `default:` label preceding the assignment.
    if (/^\s*(?:case\s+[^:]+|default)\s*:\s*$/.test(prev)) return true;
    break;
  }
  return false;
}

/**
 * Public entry: classify the candidate's tainted variable by walking
 * its assignment chain.
 *
 * Returns `unknown` whenever any step is uncertain — this is the
 * conservative side, preserving the candidate so the user still
 * sees the finding. Only `constant` or `sanitized` verdicts
 * justify suppression at the audit-engine level.
 */
export function classifyJavaCandidate(
  candidate: Candidate,
  fileContent: string,
  baseCtx: ClassifyContext = {},
): ClassifyResult {
  const ctx: ClassifyContext = { ...baseCtx, fileContent };
  if (!shouldClassifyForTaint(candidate.pattern_id)) {
    return { origin: "unknown", reason: "pattern not in taint-flow set" };
  }

  const initialVar = extractTaintedVarName(candidate);
  if (!initialVar) {
    return { origin: "unknown", reason: "could not extract var name" };
  }

  const visited = new Set<string>();
  let curVar: string | null = initialVar;
  let curLine = candidate.line;
  const maxDepth = ctx.maxDepth ?? 8;

  for (let step = 0; step < maxDepth; step++) {
    if (curVar === null) break;
    if (visited.has(curVar)) {
      return { origin: "unknown", reason: "variable cycle" };
    }
    visited.add(curVar);

    const assign = findLastAssignment(fileContent, curVar, curLine);
    if (!assign) {
      // Variable never assigned in this scope — could be a method
      // parameter or field. Treat as unknown.
      return { origin: "unknown", reason: `no assignment for '${curVar}'` };
    }

    const cls = classifyExpression(assign.rhs, {
      ...ctx,
      fileContent,
      currentLine: assign.line,
      visited,
      depth: step,
    });
    return { ...cls, evidenceLine: assign.line };
  }

  return { origin: "unknown", reason: "max depth in variable walk" };
}
