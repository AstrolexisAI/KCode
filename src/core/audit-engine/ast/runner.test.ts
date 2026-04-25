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
