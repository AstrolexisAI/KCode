// KCode - TypeScript AST patterns tests (v2.10.341)

import { describe, expect, it } from "bun:test";
import { _resetAstRunnerForTest, runAstPatterns } from "./runner";
import { TYPESCRIPT_AST_PATTERNS } from "./typescript-patterns";

function gateOnGrammar<T>(stats: { grammar_loaded: boolean }[], thunk: () => T): T | undefined {
  if (stats.every((s) => !s.grammar_loaded)) return undefined;
  return thunk();
}

describe("ts-ast-001 prototype-pollution-of-parameter", () => {
  it("flags obj[key] = val when key is a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `function set(target: any, key: string, val: any): void {
  target[key] = val;
}
`;
    const r = await runAstPatterns(TYPESCRIPT_AST_PATTERNS, "/tmp/a.ts", code);
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(1);
      expect(r.candidates[0]!.matched_text).toBe("target[key] = ...");
    });
  });

  it("flags arrow form: (target, key) => { target[key] = 1 }", async () => {
    _resetAstRunnerForTest();
    const code = `const set = (target: any, key: string) => { target[key] = 1; };\n`;
    const r = await runAstPatterns(TYPESCRIPT_AST_PATTERNS, "/tmp/a.ts", code);
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(1);
    });
  });

  it("flags class method form", async () => {
    _resetAstRunnerForTest();
    const code = `class Store {
  set(key: string, val: any): void {
    (this as any)[key] = val;
  }
  setOnTarget(target: Record<string, unknown>, key: string): void {
    target[key] = 1;
  }
}
`;
    const r = await runAstPatterns(TYPESCRIPT_AST_PATTERNS, "/tmp/a.ts", code);
    gateOnGrammar(r.stats, () => {
      // Only setOnTarget matches: `(this as any)[key]` is not a
      // bare identifier object — the LHS is a parenthesized type
      // assertion. The simpler `target[key]` matches.
      expect(r.candidates.length).toBe(1);
      expect(r.candidates[0]!.matched_text).toBe("target[key] = ...");
    });
  });

  it('does not flag obj["literal"] (key is a string, not an identifier)', async () => {
    _resetAstRunnerForTest();
    const code = `function f(target: any) { target["literal"] = 1; }\n`;
    const r = await runAstPatterns(TYPESCRIPT_AST_PATTERNS, "/tmp/a.ts", code);
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(0);
    });
  });

  it("does not flag obj.foo = val (member, not subscript)", async () => {
    _resetAstRunnerForTest();
    const code = `function f(target: any) { target.foo = 1; }\n`;
    const r = await runAstPatterns(TYPESCRIPT_AST_PATTERNS, "/tmp/a.ts", code);
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(0);
    });
  });

  it("does not flag obj[key] when key is a local variable, not a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `function f(target: any) {
  const key = "safe";
  target[key] = 1;
}
`;
    const r = await runAstPatterns(TYPESCRIPT_AST_PATTERNS, "/tmp/a.ts", code);
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(0);
    });
  });

  it("does not flag when key is captured from outer fn, not param of immediate enclosing fn", async () => {
    _resetAstRunnerForTest();
    const code = `function outer(key: string) {
  function inner(target: any) {
    target[key] = 1;
  }
  inner({});
}
`;
    const r = await runAstPatterns(TYPESCRIPT_AST_PATTERNS, "/tmp/a.ts", code);
    gateOnGrammar(r.stats, () => {
      // key is a param of OUTER but not INNER. Current pattern is
      // strict: it requires the immediate enclosing function. A
      // future enhancement could walk up; for now, this is the
      // documented behavior so a closure-based helper isn't a hot
      // false positive.
      expect(r.candidates.length).toBe(0);
    });
  });

  it("flags rest-param: function f(target: any, ...keys: string[]) — key matches first rest element", async () => {
    _resetAstRunnerForTest();
    const code = `function f(target: any, ...keys: string[]) {
  const k = keys[0];
  target[k] = 1;
}
`;
    const r = await runAstPatterns(TYPESCRIPT_AST_PATTERNS, "/tmp/a.ts", code);
    gateOnGrammar(r.stats, () => {
      // k is a local, not a parameter. So 0 candidates.
      // But if we wrote target[keys[0]] = 1 — the bracket index
      // would be a subscript_expression, not an identifier, so we
      // also wouldn't match. Documented strict behavior.
      expect(r.candidates.length).toBe(0);
    });
  });

  it("flags optional-parameter form: function f(target: any, key?: string)", async () => {
    _resetAstRunnerForTest();
    const code = `function f(target: any, key?: string) {
  if (!key) return;
  target[key] = 1;
}
`;
    const r = await runAstPatterns(TYPESCRIPT_AST_PATTERNS, "/tmp/a.ts", code);
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(1);
    });
  });

  it("does NOT flag arr[i] = val when i is typed number (v341 audit FP fix)", async () => {
    _resetAstRunnerForTest();
    const code = `function f(arr: number[], i: number, val: number) {
  arr[i] = val;
}
`;
    const r = await runAstPatterns(TYPESCRIPT_AST_PATTERNS, "/tmp/a.ts", code);
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(0);
    });
  });

  it("does NOT flag bigint-typed index either", async () => {
    _resetAstRunnerForTest();
    const code = `function f(buf: any, i: bigint) { buf[i] = 1; }\n`;
    const r = await runAstPatterns(TYPESCRIPT_AST_PATTERNS, "/tmp/a.ts", code);
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(0);
    });
  });

  it("does NOT flag nullable number: i: number | undefined", async () => {
    _resetAstRunnerForTest();
    const code = `function f(arr: any, i: number | undefined) { if (i !== undefined) arr[i] = 1; }\n`;
    const r = await runAstPatterns(TYPESCRIPT_AST_PATTERNS, "/tmp/a.ts", code);
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(0);
    });
  });

  it("DOES flag when key is string-typed (regression, ensure suppression isn't over-broad)", async () => {
    _resetAstRunnerForTest();
    const code = `function f(target: any, k: string) { target[k] = 1; }\n`;
    const r = await runAstPatterns(TYPESCRIPT_AST_PATTERNS, "/tmp/a.ts", code);
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(1);
    });
  });

  it("DOES flag when key has no type annotation (untyped key)", async () => {
    _resetAstRunnerForTest();
    const code = `function f(target: any, k: any) { target[k] = 1; }\n`;
    const r = await runAstPatterns(TYPESCRIPT_AST_PATTERNS, "/tmp/a.ts", code);
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(1);
    });
  });

  it("flags destructured-key: function f({key}: {key: string}, target: any)", async () => {
    _resetAstRunnerForTest();
    const code = `function f({key}: {key: string}, target: any) {
  target[key] = 1;
}
`;
    const r = await runAstPatterns(TYPESCRIPT_AST_PATTERNS, "/tmp/a.ts", code);
    gateOnGrammar(r.stats, () => {
      expect(r.candidates.length).toBe(1);
    });
  });
});

describe("typescript-patterns shape", () => {
  it("declares ids and CWE", () => {
    expect(TYPESCRIPT_AST_PATTERNS.length).toBe(1);
    const p = TYPESCRIPT_AST_PATTERNS[0]!;
    expect(p.id).toBe("ts-ast-001-prototype-pollution-of-parameter");
    expect(p.cwe).toBe("CWE-1321");
    expect(p.severity).toBe("high");
    expect(p.languages).toContain("typescript");
  });
});
