// KCode - AST runner tests (v2.10.336).
//
// The runner is designed to gracefully degrade when web-tree-sitter
// isn't installed and when grammars aren't bundled. These tests
// validate that contract — no exceptions, no hangs, structured stats
// in every "missing dep" path. Real query execution is exercised by
// the python-patterns tests when the grammar IS available; we don't
// assert end-to-end here so the suite stays runnable on a fresh
// checkout.

import { describe, expect, it } from "bun:test";
import { runAstPatterns, _resetAstRunnerForTest } from "./runner";
import { PYTHON_AST_PATTERNS } from "./python-patterns";

describe("runAstPatterns — graceful degradation", () => {
  it("returns empty candidates and structured stats with no patterns", async () => {
    _resetAstRunnerForTest();
    const result = await runAstPatterns([], "/tmp/x.py", "x = 1\n");
    expect(result.candidates).toEqual([]);
    expect(result.stats).toEqual([]);
  });

  it("does not throw when web-tree-sitter is absent (it currently is)", async () => {
    _resetAstRunnerForTest();
    const result = await runAstPatterns(
      PYTHON_AST_PATTERNS,
      "/tmp/x.py",
      "def f(x):\n    eval(x)\n",
    );
    // Either: tree-sitter is installed and the grammar IS not, OR
    // tree-sitter is missing entirely. Both surface as
    // grammar_loaded: false and zero candidates — never an exception.
    expect(result.candidates.length).toBeGreaterThanOrEqual(0);
    expect(result.stats.length).toBeGreaterThan(0);
    for (const s of result.stats) {
      expect(typeof s.pattern_id).toBe("string");
      expect(typeof s.raw_matches).toBe("number");
      expect(typeof s.candidates).toBe("number");
      expect(typeof s.grammar_loaded).toBe("boolean");
      // When grammar is missing we should have a load_error.
      if (!s.grammar_loaded) {
        expect(typeof s.load_error).toBe("string");
        expect((s.load_error ?? "").length).toBeGreaterThan(0);
      }
    }
  });
});

describe("python-patterns shape", () => {
  it("py-ast-001 declares the fields the runner expects", () => {
    const p = PYTHON_AST_PATTERNS.find((q) => q.id === "py-ast-001-eval-of-parameter");
    expect(p).toBeDefined();
    if (!p) return;
    expect(p.languages).toContain("python");
    expect(typeof p.query).toBe("string");
    expect(p.query.length).toBeGreaterThan(20);
    expect(typeof p.match).toBe("function");
    expect(p.severity).toBe("critical");
    expect(p.cwe).toBe("CWE-95");
  });
});

describe("py-ast-001 end-to-end (requires bundled grammar)", () => {
  it("flags eval(parameter), leaves eval(literal) alone", async () => {
    _resetAstRunnerForTest();
    const code = `def safe(): eval("1 + 1")
def evil(x): eval(x)
def also_evil(payload): exec(payload)
`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/test.py", code);
    // If the bundled grammar isn't loadable on this platform, the
    // runner returns grammar_loaded:false and zero candidates. The
    // earlier "graceful degradation" test covers that path; here we
    // assert the happy path when the grammar is bundled.
    if (r.stats.every((s) => !s.grammar_loaded)) {
      expect(r.candidates.length).toBe(0);
      return;
    }
    expect(r.candidates.length).toBe(2);
    const lines = r.candidates.map((c) => c.line).sort((a, b) => a - b);
    expect(lines).toEqual([2, 3]);
    const matched = r.candidates.map((c) => c.matched_text).sort();
    expect(matched).toEqual(["eval(x)", "exec(payload)"]);
  });

  it("does not flag eval() of an internal local variable that's not a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `def f():
    x = "1 + 1"
    eval(x)
`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/local.py", code);
    if (r.stats.every((s) => !s.grammar_loaded)) return;
    expect(r.candidates.length).toBe(0);
  });

  it("respects parameter scope: outer-function param should not bleed into nested function", async () => {
    _resetAstRunnerForTest();
    const code = `def outer(user_input):
    def inner():
        # user_input is captured by closure but NOT a parameter of inner
        eval("safe")
    inner()
    eval(user_input)
`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/scope.py", code);
    if (r.stats.every((s) => !s.grammar_loaded)) return;
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0]!.matched_text).toBe("eval(user_input)");
  });

  // v2.10.338 audit fix — these were silent gaps in v337.
  it("flags lambda parameters: lambda x: eval(x)", async () => {
    _resetAstRunnerForTest();
    const code = `f = lambda x: eval(x)\n`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/lam.py", code);
    if (r.stats.every((s) => !s.grammar_loaded)) return;
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0]!.matched_text).toBe("eval(x)");
  });

  it("flags *args: def f(*args): eval(args)", async () => {
    _resetAstRunnerForTest();
    const code = `def f(*args):\n    eval(args)\n`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/splat.py", code);
    if (r.stats.every((s) => !s.grammar_loaded)) return;
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0]!.matched_text).toBe("eval(args)");
  });

  it("flags **kwargs: def f(**kw): eval(kw)", async () => {
    _resetAstRunnerForTest();
    const code = `def f(**kw):\n    eval(kw)\n`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/dict-splat.py", code);
    if (r.stats.every((s) => !s.grammar_loaded)) return;
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0]!.matched_text).toBe("eval(kw)");
  });

  it("flags typed and default-valued parameters", async () => {
    _resetAstRunnerForTest();
    const code = `def f(x: str = "safe"):\n    eval(x)\n`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/typed.py", code);
    if (r.stats.every((s) => !s.grammar_loaded)) return;
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0]!.matched_text).toBe("eval(x)");
  });
});

// v2.10.343 — second wave of Python AST patterns
describe("py-ast-002 deserialization-of-parameter", () => {
  it("flags pickle.loads(p) when p is a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `import pickle\ndef f(p):\n    pickle.loads(p)\n`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/x.py", code);
    if (r.stats.every((s) => !s.grammar_loaded)) return;
    const hits = r.candidates.filter((c) => c.pattern_id === "py-ast-002-deserialization-of-parameter");
    expect(hits.length).toBe(1);
    expect(hits[0]!.matched_text).toBe("pickle.loads(p)");
  });

  it("flags yaml.load(p) but NOT yaml.safe_load(p)", async () => {
    _resetAstRunnerForTest();
    const code = `import yaml\ndef a(p): yaml.load(p)\ndef b(p): yaml.safe_load(p)\n`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/x.py", code);
    if (r.stats.every((s) => !s.grammar_loaded)) return;
    const hits = r.candidates.filter((c) => c.pattern_id === "py-ast-002-deserialization-of-parameter");
    expect(hits.length).toBe(1);
    expect(hits[0]!.matched_text).toBe("yaml.load(p)");
  });

  it("flags marshal / dill / cPickle / yaml.unsafe_load / yaml.full_load", async () => {
    _resetAstRunnerForTest();
    const code = `def a(p): marshal.loads(p)
def b(p): dill.loads(p)
def c(p): cPickle.loads(p)
def d(p): yaml.unsafe_load(p)
def e(p): yaml.full_load(p)
`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/x.py", code);
    if (r.stats.every((s) => !s.grammar_loaded)) return;
    const hits = r.candidates.filter((c) => c.pattern_id === "py-ast-002-deserialization-of-parameter");
    expect(hits.length).toBe(5);
  });

  it("does not flag json.loads / pickle.loads of a literal", async () => {
    _resetAstRunnerForTest();
    const code = `def a(p): json.loads(p)
def b(): pickle.loads(b"safe")
`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/x.py", code);
    if (r.stats.every((s) => !s.grammar_loaded)) return;
    const hits = r.candidates.filter((c) => c.pattern_id === "py-ast-002-deserialization-of-parameter");
    expect(hits.length).toBe(0);
  });
});

describe("py-ast-003 subprocess-of-parameter", () => {
  it("flags subprocess.run(p) and subprocess.Popen(p) and subprocess.check_call(p)", async () => {
    _resetAstRunnerForTest();
    const code = `def a(p): subprocess.run(p)
def b(p): subprocess.Popen(p)
def c(p): subprocess.check_call(p)
def d(p): subprocess.check_output(p)
`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/x.py", code);
    if (r.stats.every((s) => !s.grammar_loaded)) return;
    const hits = r.candidates.filter((c) => c.pattern_id === "py-ast-003-subprocess-of-parameter");
    expect(hits.length).toBe(4);
  });

  it("flags os.system, os.popen, os.execv, os.spawnv", async () => {
    _resetAstRunnerForTest();
    const code = `def a(p): os.system(p)
def b(p): os.popen(p)
def c(p): os.execv(p)
def d(p): os.spawnv(p)
`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/x.py", code);
    if (r.stats.every((s) => !s.grammar_loaded)) return;
    const hits = r.candidates.filter((c) => c.pattern_id === "py-ast-003-subprocess-of-parameter");
    expect(hits.length).toBe(4);
  });

  it("does not flag a non-shell module: foo.run(p)", async () => {
    _resetAstRunnerForTest();
    const code = `def f(p): foo.run(p)\n`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/x.py", code);
    if (r.stats.every((s) => !s.grammar_loaded)) return;
    const hits = r.candidates.filter((c) => c.pattern_id === "py-ast-003-subprocess-of-parameter");
    expect(hits.length).toBe(0);
  });

  it("does not flag os.system of a literal", async () => {
    _resetAstRunnerForTest();
    const code = `def f(): os.system("ls -la")\n`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/x.py", code);
    if (r.stats.every((s) => !s.grammar_loaded)) return;
    const hits = r.candidates.filter((c) => c.pattern_id === "py-ast-003-subprocess-of-parameter");
    expect(hits.length).toBe(0);
  });
});

describe("py-ast-004 open-of-parameter", () => {
  it("flags open(p) when p is a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `def f(p): open(p)\n`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/x.py", code);
    if (r.stats.every((s) => !s.grammar_loaded)) return;
    const hits = r.candidates.filter((c) => c.pattern_id === "py-ast-004-open-of-parameter");
    expect(hits.length).toBe(1);
    expect(hits[0]!.matched_text).toBe("open(p)");
  });

  it("flags open(p, 'r') — second arg (mode) doesn't disqualify", async () => {
    _resetAstRunnerForTest();
    const code = `def f(p): open(p, "r")\n`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/x.py", code);
    if (r.stats.every((s) => !s.grammar_loaded)) return;
    const hits = r.candidates.filter((c) => c.pattern_id === "py-ast-004-open-of-parameter");
    expect(hits.length).toBe(1);
  });

  it("does not flag open of a literal", async () => {
    _resetAstRunnerForTest();
    const code = `def f(): open("/etc/hosts")\n`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/x.py", code);
    if (r.stats.every((s) => !s.grammar_loaded)) return;
    const hits = r.candidates.filter((c) => c.pattern_id === "py-ast-004-open-of-parameter");
    expect(hits.length).toBe(0);
  });

  it("does not flag open of an internal local variable", async () => {
    _resetAstRunnerForTest();
    const code = `def f():\n    path = "/tmp/x"\n    open(path)\n`;
    const r = await runAstPatterns(PYTHON_AST_PATTERNS, "/tmp/x.py", code);
    if (r.stats.every((s) => !s.grammar_loaded)) return;
    const hits = r.candidates.filter((c) => c.pattern_id === "py-ast-004-open-of-parameter");
    expect(hits.length).toBe(0);
  });
});

describe("python-patterns: shape declarations for the v343 wave", () => {
  it("declares CWE for each new pattern", () => {
    const get = (id: string) => PYTHON_AST_PATTERNS.find((p) => p.id === id);
    expect(get("py-ast-002-deserialization-of-parameter")?.cwe).toBe("CWE-502");
    expect(get("py-ast-003-subprocess-of-parameter")?.cwe).toBe("CWE-78");
    expect(get("py-ast-004-open-of-parameter")?.cwe).toBe("CWE-22");
  });
});
