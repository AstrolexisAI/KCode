// F4 (v2.10.366) — taint-walker tests.
//
// Tests the helpers via direct invocation against minimal AST fakes.
// We deliberately don't reach for tree-sitter here — the walker only
// uses the AstNode interface, so a tiny synthetic tree exercises the
// branches without grammar dependencies.

import { describe, expect, test } from "bun:test";
import {
  collectTaintedLocals,
  isTainted,
  SANITIZER_CALLS,
  TAINT_ROOTS,
} from "./taint-walker";
import type { AstNode } from "./types";

function node(opts: {
  type: string;
  text?: string;
  children?: AstNode[];
}): AstNode {
  const children = opts.children ?? [];
  const n: AstNode = {
    type: opts.type,
    text: opts.text ?? "",
    startIndex: 0,
    endIndex: 0,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: 0 },
    namedChildCount: children.length,
    namedChild: (i: number) => children[i] ?? null,
    parent: null,
  };
  // Backlink children for parent walks (none of our paths require it,
  // but preserve the contract).
  for (const c of children) (c as { parent: AstNode | null }).parent = n;
  return n;
}

const ident = (text: string) => node({ type: "identifier", text });
const memberExpr = (object: AstNode, property: AstNode) =>
  node({
    type: "member_expression",
    text: `${object.text}.${property.text}`,
    children: [object, property],
  });
const subscriptExpr = (object: AstNode, index: AstNode) =>
  node({
    type: "subscript_expression",
    text: `${object.text}[${index.text}]`,
    children: [object, index],
  });
const callExpr = (callee: AstNode, ...args: AstNode[]) =>
  node({
    type: "call_expression",
    text: `${callee.text}(${args.map((a) => a.text).join(", ")})`,
    children: [callee, ...args],
  });
const binary = (left: AstNode, right: AstNode) =>
  node({ type: "binary_expression", text: `${left.text} + ${right.text}`, children: [left, right] });
const string = (text: string) => node({ type: "string", text });

describe("TAINT_ROOTS / SANITIZER_CALLS sanity", () => {
  test("TAINT_ROOTS contains the well-known names", () => {
    expect(TAINT_ROOTS.has("req")).toBe(true);
    expect(TAINT_ROOTS.has("request")).toBe(true);
    expect(TAINT_ROOTS.has("process")).toBe(true);
    expect(TAINT_ROOTS.has("ctx")).toBe(true);
    expect(TAINT_ROOTS.has("location")).toBe(true);
    expect(TAINT_ROOTS.has("document")).toBe(true);
  });

  test("SANITIZER_CALLS contains common laundering helpers", () => {
    expect(SANITIZER_CALLS.has("escape")).toBe(true);
    expect(SANITIZER_CALLS.has("sanitize")).toBe(true);
    expect(SANITIZER_CALLS.has("encodeURIComponent")).toBe(true);
    expect(SANITIZER_CALLS.has("shellescape")).toBe(true);
  });
});

describe("isTainted", () => {
  test("bare identifier in TAINT_ROOTS is tainted", () => {
    expect(isTainted(ident("req"), new Set())).toBe(true);
  });

  test("bare identifier not in TAINT_ROOTS or locals is clean", () => {
    expect(isTainted(ident("hello"), new Set())).toBe(false);
  });

  test("member_expression rooted in tainted name is tainted", () => {
    // req.body.code
    const body = ident("body");
    const code = ident("code");
    const reqBody = memberExpr(ident("req"), body);
    const full = memberExpr(reqBody, code);
    expect(isTainted(full, new Set())).toBe(true);
  });

  test("subscript_expression rooted in tainted name is tainted", () => {
    // process.argv[2]
    const argv = ident("argv");
    const procArgv = memberExpr(ident("process"), argv);
    const sub = subscriptExpr(procArgv, ident("2"));
    expect(isTainted(sub, new Set())).toBe(true);
  });

  test("local variable in localTainted set is tainted", () => {
    expect(isTainted(ident("userInput"), new Set(["userInput"]))).toBe(true);
  });

  test("sanitizer wrapping launders taint", () => {
    // escape(req.body)
    const reqBody = memberExpr(ident("req"), ident("body"));
    const call = callExpr(ident("escape"), reqBody);
    expect(isTainted(call, new Set())).toBe(false);
  });

  test("member-form sanitizer wrapping launders taint", () => {
    // DOMPurify.sanitize(req.body)
    const sanitize = memberExpr(ident("DOMPurify"), node({ type: "property_identifier", text: "sanitize" }));
    const reqBody = memberExpr(ident("req"), ident("body"));
    const call = callExpr(sanitize, reqBody);
    expect(isTainted(call, new Set())).toBe(false);
  });

  test("non-sanitizer call with tainted argument propagates taint", () => {
    // someHelper(req.body)
    const reqBody = memberExpr(ident("req"), ident("body"));
    const call = callExpr(ident("someHelper"), reqBody);
    expect(isTainted(call, new Set())).toBe(true);
  });

  test("string concatenation with tainted leaf is tainted", () => {
    // "ls " + req.body.path
    const reqBody = memberExpr(memberExpr(ident("req"), ident("body")), ident("path"));
    const concat = binary(string('"ls "'), reqBody);
    expect(isTainted(concat, new Set())).toBe(true);
  });

  test("string concatenation of clean leaves is clean", () => {
    const concat = binary(string('"ls "'), string('"-la"'));
    expect(isTainted(concat, new Set())).toBe(false);
  });
});

describe("collectTaintedLocals", () => {
  function variableDeclarator(name: string, value: AstNode): AstNode {
    return node({
      type: "variable_declarator",
      text: `${name} = ${value.text}`,
      children: [ident(name), value],
    });
  }
  function lexicalDecl(...declarators: AstNode[]): AstNode {
    return node({ type: "lexical_declaration", children: declarators });
  }
  function statementBlock(...stmts: AstNode[]): AstNode {
    return node({ type: "statement_block", children: stmts });
  }

  test("flat: const x = req.body.code marks x tainted", () => {
    const reqBodyCode = memberExpr(memberExpr(ident("req"), ident("body")), ident("code"));
    const decl = variableDeclarator("x", reqBodyCode);
    const body = statementBlock(lexicalDecl(decl));
    const tainted = collectTaintedLocals(body);
    expect(tainted.has("x")).toBe(true);
  });

  test("flat: const x = literal does not mark x tainted", () => {
    const decl = variableDeclarator("x", string('"hardcoded"'));
    const body = statementBlock(lexicalDecl(decl));
    const tainted = collectTaintedLocals(body);
    expect(tainted.has("x")).toBe(false);
  });

  test("chained: const x = req.body; const y = x; marks both tainted", () => {
    const reqBody = memberExpr(ident("req"), ident("body"));
    const declX = variableDeclarator("x", reqBody);
    const declY = variableDeclarator("y", ident("x"));
    const body = statementBlock(lexicalDecl(declX), lexicalDecl(declY));
    const tainted = collectTaintedLocals(body);
    expect(tainted.has("x")).toBe(true);
    expect(tainted.has("y")).toBe(true);
  });

  test("does not descend into nested function bodies", () => {
    const reqBody = memberExpr(ident("req"), ident("body"));
    const innerDecl = variableDeclarator("inner", reqBody);
    const innerFn = node({
      type: "function_declaration",
      children: [ident("inner"), statementBlock(lexicalDecl(innerDecl))],
    });
    const body = statementBlock(innerFn);
    const tainted = collectTaintedLocals(body);
    expect(tainted.has("inner")).toBe(false);
  });

  test("sanitizer assignment does not propagate taint", () => {
    // const safe = escape(req.body)
    const reqBody = memberExpr(ident("req"), ident("body"));
    const call = callExpr(ident("escape"), reqBody);
    const decl = variableDeclarator("safe", call);
    const body = statementBlock(lexicalDecl(decl));
    const tainted = collectTaintedLocals(body);
    expect(tainted.has("safe")).toBe(false);
  });
});
