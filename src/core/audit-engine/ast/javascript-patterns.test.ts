// KCode - JavaScript AST patterns tests (v2.10.340)
//
// Same skip-when-grammar-missing predicate as python-patterns.test.ts
// — the suite stays green on hosts without the bundled wasm.

import { describe, expect, it } from "bun:test";
import { _resetAstRunnerForTest, runAstPatterns } from "./runner";
import { JAVASCRIPT_AST_PATTERNS } from "./javascript-patterns";

function gateOnGrammar<T>(stats: { grammar_loaded: boolean }[], thunk: () => T): T | undefined {
  if (stats.every((s) => !s.grammar_loaded)) return undefined;
  return thunk();
}

describe("js-ast-001 eval-of-parameter — function shapes", () => {
  it("flags eval(x) inside function declaration", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `function f(x) { eval(x); }\n`,
    );
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(1);
      expect(r.candidates[0]!.matched_text).toBe("eval(x)");
    });
  });

  it("flags eval(x) inside arrow shorthand: x => eval(x)", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `const f = x => eval(x);\n`,
    );
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(1);
      expect(r.candidates[0]!.matched_text).toBe("eval(x)");
    });
  });

  it("flags eval(x) inside parenthesized arrow: (x) => eval(x)", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `const f = (x) => eval(x);\n`,
    );
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(1);
    });
  });

  it("flags eval(x) inside function expression", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `const f = function(x) { eval(x); };\n`,
    );
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(1);
    });
  });

  it("flags eval(x) inside method definition", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `class A { m(x) { eval(x); } }\n`,
    );
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(1);
    });
  });

  it("flags eval(args) for ...args rest parameter", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `function f(...args) { eval(args); }\n`,
    );
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(1);
      expect(r.candidates[0]!.matched_text).toBe("eval(args)");
    });
  });

  it("flags eval(x) for default-value parameter (x = 5)", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `function f(x = 5) { eval(x); }\n`,
    );
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(1);
    });
  });

  it("flags eval(a) for object-destructured param: {a, b}", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `function f({a, b}) { eval(a); }\n`,
    );
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(1);
    });
  });
});

describe("js-ast-001 — negative cases", () => {
  it("does not flag eval(literal)", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `function f(x) { eval("1 + 1"); }\n`,
    );
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(0);
    });
  });

  it("does not flag eval of an internal local variable", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `function f() {\n  const y = "1+1";\n  eval(y);\n}\n`,
    );
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(0);
    });
  });

  it("respects scope: outer-function param does not bleed into inner function", async () => {
    _resetAstRunnerForTest();
    const code = `function outer(userInput) {
  function inner() {
    eval("ok");
  }
  inner();
  eval(userInput);
}
`;
    const r = await runAstPatterns(JAVASCRIPT_AST_PATTERNS, "/tmp/a.js", code);
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(1);
      expect(r.candidates[0]!.matched_text).toBe("eval(userInput)");
    });
  });

  it("flags Function(x) in addition to eval(x)", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `function f(x) { Function(x); }\n`,
    );
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(1);
      expect(r.candidates[0]!.matched_text).toBe("Function(x)");
    });
  });

  it("flags `new Function(x)` — the common code-from-string form", async () => {
    // v341 audit fix: pre-fix this was silently missed because the
    // query only matched call_expression. new_expression is a
    // separate AST node type; the union now covers both.
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `function f(x) { return new Function(x); }\n`,
    );
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(1);
      expect(r.candidates[0]!.matched_text).toBe("new Function(x)");
    });
  });

  it("flags setTimeout(x) when x is a parameter (string-form sink)", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `function f(x) { setTimeout(x); }\n`,
    );
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(1);
    });
  });
});

describe("js-ast-002 child_process exec-of-parameter", () => {
  it("flags cp.exec(userInput) when userInput is a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `const cp = require("child_process");
function handler(userInput) { cp.exec(userInput); }
`;
    const r = await runAstPatterns(JAVASCRIPT_AST_PATTERNS, "/tmp/a.js", code);
    gateOnGrammar(r.stats, () => {
      const ast002 = r.candidates.filter((c) => c.pattern_id === "js-ast-002-child-process-exec-of-parameter");
      expect(ast002.length).toBe(1);
      expect(ast002[0]!.matched_text).toBe(".exec(userInput)");
    });
  });

  it("flags spawn / execSync / spawnSync / execFile / execFileSync", async () => {
    _resetAstRunnerForTest();
    const code = `function a(x) { cp.spawn(x); }
function b(x) { cp.execSync(x); }
function c(x) { cp.spawnSync(x); }
function d(x) { cp.execFile(x); }
function e(x) { cp.execFileSync(x); }
`;
    const r = await runAstPatterns(JAVASCRIPT_AST_PATTERNS, "/tmp/a.js", code);
    gateOnGrammar(r.stats, () => {
      const ast002 = r.candidates.filter((c) => c.pattern_id === "js-ast-002-child-process-exec-of-parameter");
      expect(ast002.length).toBe(5);
    });
  });

  it("does not flag exec of a literal", async () => {
    _resetAstRunnerForTest();
    const code = `function f() { cp.exec("ls -la"); }\n`;
    const r = await runAstPatterns(JAVASCRIPT_AST_PATTERNS, "/tmp/a.js", code);
    gateOnGrammar(r.stats, () => {
      const ast002 = r.candidates.filter((c) => c.pattern_id === "js-ast-002-child-process-exec-of-parameter");
      expect(ast002.length).toBe(0);
    });
  });

  it("does not flag exec of an internal variable", async () => {
    _resetAstRunnerForTest();
    const code = `function f() {
  const cmd = "ls -la";
  cp.exec(cmd);
}
`;
    const r = await runAstPatterns(JAVASCRIPT_AST_PATTERNS, "/tmp/a.js", code);
    gateOnGrammar(r.stats, () => {
      const ast002 = r.candidates.filter((c) => c.pattern_id === "js-ast-002-child-process-exec-of-parameter");
      expect(ast002.length).toBe(0);
    });
  });

  it("does not flag a non-child_process method (e.g. .map(x))", async () => {
    _resetAstRunnerForTest();
    const code = `function f(x) { return arr.map(x); }\n`;
    const r = await runAstPatterns(JAVASCRIPT_AST_PATTERNS, "/tmp/a.js", code);
    gateOnGrammar(r.stats, () => {
      const ast002 = r.candidates.filter((c) => c.pattern_id === "js-ast-002-child-process-exec-of-parameter");
      expect(ast002.length).toBe(0);
    });
  });
});

describe("js-ast-003 regexp-construction-of-parameter", () => {
  it("flags new RegExp(p) when p is a parameter", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `function f(p) { return new RegExp(p); }\n`,
    );
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "js-ast-003-regexp-construction-of-parameter");
      expect(hits.length).toBe(1);
      expect(hits[0]!.matched_text).toBe("new RegExp(p)");
    });
  });

  it("flags RegExp(p) without 'new' when p is a parameter", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `function f(p) { return RegExp(p); }\n`,
    );
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "js-ast-003-regexp-construction-of-parameter");
      expect(hits.length).toBe(1);
    });
  });

  it("does not flag new RegExp(literal)", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `function f() { return new RegExp("[a-z]+"); }\n`,
    );
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "js-ast-003-regexp-construction-of-parameter");
      expect(hits.length).toBe(0);
    });
  });

  it("does not flag new RegExp of an internal local", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `function f() { const pat = "[a-z]"; return new RegExp(pat); }\n`,
    );
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "js-ast-003-regexp-construction-of-parameter");
      expect(hits.length).toBe(0);
    });
  });

  it("does not flag a non-RegExp constructor (e.g. new Date(p))", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `function f(p) { return new Date(p); }\n`,
    );
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "js-ast-003-regexp-construction-of-parameter");
      expect(hits.length).toBe(0);
    });
  });

  it("flags new RegExp(p, 'g') — second arg (flags) doesn't affect the match", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(
      JAVASCRIPT_AST_PATTERNS,
      "/tmp/a.js",
      `function f(p) { return new RegExp(p, "g"); }\n`,
    );
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "js-ast-003-regexp-construction-of-parameter");
      expect(hits.length).toBe(1);
    });
  });
});

describe("javascript-patterns shape", () => {
  it("declares ids and CWE", () => {
    const ids = JAVASCRIPT_AST_PATTERNS.map((p) => p.id).sort();
    expect(ids).toEqual([
      "js-ast-001-eval-of-parameter",
      "js-ast-002-child-process-exec-of-parameter",
      "js-ast-003-regexp-construction-of-parameter",
      "js-ast-005-eval-of-tainted-expression",
      "js-ast-006-exec-of-tainted-expression",
      "js-ast-007-innerhtml-of-tainted-expression",
    ]);
    for (const p of JAVASCRIPT_AST_PATTERNS) {
      expect(p.languages).toContain("javascript");
      expect(p.languages).toContain("typescript");
      expect(typeof p.match).toBe("function");
      expect(typeof p.query).toBe("string");
    }
    expect(JAVASCRIPT_AST_PATTERNS.find((p) => p.id === "js-ast-003-regexp-construction-of-parameter")!.cwe).toBe("CWE-1333");
  });
});
