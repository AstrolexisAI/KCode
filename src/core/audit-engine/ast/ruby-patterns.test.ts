// KCode - Ruby AST patterns tests (v2.10.349)

import { describe, expect, it } from "bun:test";
import { _resetAstRunnerForTest, runAstPatterns } from "./runner";
import { RUBY_AST_PATTERNS } from "./ruby-patterns";

function gateOnGrammar<T>(stats: { grammar_loaded: boolean }[], thunk: () => T): T | undefined {
  if (stats.every((s) => !s.grammar_loaded)) return undefined;
  return thunk();
}

describe("rb-ast-001 eval-of-parameter", () => {
  it("flags eval(p) when p is a parameter", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(RUBY_AST_PATTERNS, "/tmp/a.rb", `def f(p); eval(p); end\n`);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rb-ast-001-eval-of-parameter");
      expect(hits.length).toBe(1);
      expect(hits[0]!.matched_text).toBe("eval(p)");
    });
  });

  it("flags instance_eval / class_eval / module_eval", async () => {
    _resetAstRunnerForTest();
    const code = `def a(p); instance_eval(p); end
def b(p); class_eval(p); end
def c(p); module_eval(p); end
`;
    const r = await runAstPatterns(RUBY_AST_PATTERNS, "/tmp/a.rb", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rb-ast-001-eval-of-parameter");
      expect(hits.length).toBe(3);
    });
  });

  it("flags eval inside a class method, lambda, and block", async () => {
    _resetAstRunnerForTest();
    const code = `class A
  def m(p); eval(p); end
end
f = lambda { |p| eval(p) }
g = ->(p) { eval(p) }
`;
    const r = await runAstPatterns(RUBY_AST_PATTERNS, "/tmp/a.rb", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rb-ast-001-eval-of-parameter");
      expect(hits.length).toBe(3);
    });
  });

  it("does NOT flag eval(literal) or eval of internal local", async () => {
    _resetAstRunnerForTest();
    const code = `def a; eval("1+1"); end
def b; x = "code"; eval(x); end
`;
    const r = await runAstPatterns(RUBY_AST_PATTERNS, "/tmp/a.rb", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rb-ast-001-eval-of-parameter");
      expect(hits.length).toBe(0);
    });
  });
});

describe("rb-ast-002 shell-of-parameter", () => {
  it("flags system(p), exec(p), spawn(p)", async () => {
    _resetAstRunnerForTest();
    const code = `def a(p); system(p); end
def b(p); exec(p); end
def c(p); spawn(p); end
`;
    const r = await runAstPatterns(RUBY_AST_PATTERNS, "/tmp/a.rb", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rb-ast-002-shell-of-parameter");
      expect(hits.length).toBe(3);
    });
  });

  it("flags backtick `#{p}` form", async () => {
    _resetAstRunnerForTest();
    const code = `def f(cmd); \`#{cmd}\`; end\n`;
    const r = await runAstPatterns(RUBY_AST_PATTERNS, "/tmp/a.rb", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rb-ast-002-shell-of-parameter");
      expect(hits.length).toBe(1);
      expect(hits[0]!.matched_text).toBe("`#{cmd}`");
    });
  });

  it("does NOT flag system(literal)", async () => {
    _resetAstRunnerForTest();
    const code = `def f; system("ls"); end\n`;
    const r = await runAstPatterns(RUBY_AST_PATTERNS, "/tmp/a.rb", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rb-ast-002-shell-of-parameter");
      expect(hits.length).toBe(0);
    });
  });
});

describe("rb-ast-003 file-open-of-parameter", () => {
  it("flags File.open / File.read / File.delete / IO.read", async () => {
    _resetAstRunnerForTest();
    const code = `def a(p); File.open(p); end
def b(p); File.read(p); end
def c(p); File.delete(p); end
def d(p); IO.read(p); end
`;
    const r = await runAstPatterns(RUBY_AST_PATTERNS, "/tmp/a.rb", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rb-ast-003-file-open-of-parameter");
      expect(hits.length).toBe(4);
    });
  });

  it("does NOT flag File.open(literal)", async () => {
    _resetAstRunnerForTest();
    const code = `def f; File.open("/etc/hosts"); end\n`;
    const r = await runAstPatterns(RUBY_AST_PATTERNS, "/tmp/a.rb", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rb-ast-003-file-open-of-parameter");
      expect(hits.length).toBe(0);
    });
  });

  it("does NOT flag SomeOther.open(p) (non-File receiver)", async () => {
    _resetAstRunnerForTest();
    const code = `def f(p); Logger.open(p); end\n`;
    const r = await runAstPatterns(RUBY_AST_PATTERNS, "/tmp/a.rb", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rb-ast-003-file-open-of-parameter");
      expect(hits.length).toBe(0);
    });
  });
});

describe("ruby-patterns shape", () => {
  it("declares ids, severities, and CWEs", () => {
    const ids = RUBY_AST_PATTERNS.map((p) => p.id).sort();
    expect(ids).toEqual([
      "rb-ast-001-eval-of-parameter",
      "rb-ast-002-shell-of-parameter",
      "rb-ast-003-file-open-of-parameter",
    ]);
    const get = (id: string) => RUBY_AST_PATTERNS.find((p) => p.id === id);
    expect(get("rb-ast-001-eval-of-parameter")?.cwe).toBe("CWE-95");
    expect(get("rb-ast-002-shell-of-parameter")?.cwe).toBe("CWE-78");
    expect(get("rb-ast-003-file-open-of-parameter")?.cwe).toBe("CWE-22");
    for (const p of RUBY_AST_PATTERNS) {
      expect(p.languages).toEqual(["ruby"]);
    }
  });
});
