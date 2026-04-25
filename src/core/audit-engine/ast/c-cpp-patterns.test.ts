// KCode - C/C++ AST patterns tests (v2.10.346)

import { describe, expect, it } from "bun:test";
import { _resetAstRunnerForTest, runAstPatterns } from "./runner";
import { C_CPP_AST_PATTERNS } from "./c-cpp-patterns";

function gateOnGrammar<T>(stats: { grammar_loaded: boolean }[], thunk: () => T): T | undefined {
  if (stats.every((s) => !s.grammar_loaded)) return undefined;
  return thunk();
}

describe("cpp-ast-001 system-of-parameter", () => {
  it("flags system(cmd) in C when cmd is a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `void run(const char *cmd) { system(cmd); }\n`;
    const r = await runAstPatterns(C_CPP_AST_PATTERNS, "/tmp/x.c", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "cpp-ast-001-system-of-parameter");
      expect(hits.length).toBe(1);
      expect(hits[0]!.matched_text).toBe("system(cmd)");
    });
  });

  it("flags popen / execv / execlp / execve", async () => {
    _resetAstRunnerForTest();
    const code = `void a(char *p) { popen(p, "r"); }
void b(char *p) { execv(p, NULL); }
void c(char *p) { execlp(p); }
void d(char *p) { execve(p, NULL, NULL); }
`;
    const r = await runAstPatterns(C_CPP_AST_PATTERNS, "/tmp/x.c", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "cpp-ast-001-system-of-parameter");
      expect(hits.length).toBe(4);
    });
  });

  it("flags system(p) inside a C++ class method", async () => {
    _resetAstRunnerForTest();
    const code = `class A { public: void run(const char *cmd) { system(cmd); } };\n`;
    const r = await runAstPatterns(C_CPP_AST_PATTERNS, "/tmp/x.cpp", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "cpp-ast-001-system-of-parameter");
      expect(hits.length).toBe(1);
    });
  });

  it("flags inside a C++ template function", async () => {
    _resetAstRunnerForTest();
    const code = `template<typename T> void run(T cmd) { system(cmd); }\n`;
    const r = await runAstPatterns(C_CPP_AST_PATTERNS, "/tmp/x.cpp", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "cpp-ast-001-system-of-parameter");
      expect(hits.length).toBe(1);
    });
  });

  it("flags inside a C++ lambda", async () => {
    _resetAstRunnerForTest();
    const code = `int main() { auto h = [](const char *p) { system(p); }; return 0; }\n`;
    const r = await runAstPatterns(C_CPP_AST_PATTERNS, "/tmp/x.cpp", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "cpp-ast-001-system-of-parameter");
      expect(hits.length).toBe(1);
    });
  });

  it("flags inside a C++ namespace", async () => {
    _resetAstRunnerForTest();
    const code = `namespace ns { void f(const char *p) { system(p); } }\n`;
    const r = await runAstPatterns(C_CPP_AST_PATTERNS, "/tmp/x.cpp", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "cpp-ast-001-system-of-parameter");
      expect(hits.length).toBe(1);
    });
  });

  it("does NOT flag system(literal)", async () => {
    _resetAstRunnerForTest();
    const code = `void run(void) { system("/bin/ls"); }\n`;
    const r = await runAstPatterns(C_CPP_AST_PATTERNS, "/tmp/x.c", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "cpp-ast-001-system-of-parameter");
      expect(hits.length).toBe(0);
    });
  });

  it("does NOT flag system of a local non-parameter", async () => {
    _resetAstRunnerForTest();
    const code = `void run(void) { const char *cmd = "ls"; system(cmd); }\n`;
    const r = await runAstPatterns(C_CPP_AST_PATTERNS, "/tmp/x.c", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "cpp-ast-001-system-of-parameter");
      expect(hits.length).toBe(0);
    });
  });

  it("does NOT flag a method called my_system", async () => {
    _resetAstRunnerForTest();
    const code = `void run(const char *p) { my_system(p); }\n`;
    const r = await runAstPatterns(C_CPP_AST_PATTERNS, "/tmp/x.c", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "cpp-ast-001-system-of-parameter");
      expect(hits.length).toBe(0);
    });
  });
});

describe("cpp-ast-002 strcpy-of-parameter", () => {
  it("flags strcpy(dst, src) when src is a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `void f(char *dst, const char *src) { strcpy(dst, src); }\n`;
    const r = await runAstPatterns(C_CPP_AST_PATTERNS, "/tmp/x.c", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "cpp-ast-002-strcpy-of-parameter");
      // Both dst and src are parameters; no-anchor query produces
      // two matches for the same call.
      expect(hits.length).toBe(2);
    });
  });

  it("flags strcat / strncpy / sprintf with a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `void a(char *dst, const char *src) { strcat(dst, src); }
void b(char *dst, const char *src, int n) { strncpy(dst, src, n); }
void c(char *buf, const char *fmt) { sprintf(buf, fmt); }
`;
    const r = await runAstPatterns(C_CPP_AST_PATTERNS, "/tmp/x.c", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "cpp-ast-002-strcpy-of-parameter");
      // strcat: 2 (dst, src), strncpy: 3 (dst, src, n — n is also a
      // parameter so the no-anchor query catches it), sprintf: 2
      // (buf, fmt) → 7 total. The n-param hit is technically a FP
      // (n is a length, not a buffer), but the verifier prompt
      // handles the demotion.
      expect(hits.length).toBe(7);
    });
  });

  it("does NOT flag a non-strcpy callee (e.g. memcpy)", async () => {
    _resetAstRunnerForTest();
    const code = `void f(char *dst, const char *src) { memcpy(dst, src, 10); }\n`;
    const r = await runAstPatterns(C_CPP_AST_PATTERNS, "/tmp/x.c", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "cpp-ast-002-strcpy-of-parameter");
      // memcpy is intentionally not in the dangerous-callees set —
      // it doesn't unbound-copy. Bounded-copy variants are in the
      // set (strncpy is included because the n itself can be
      // caller-controlled), but memcpy alone is too noisy to flag.
      expect(hits.length).toBe(0);
    });
  });
});

describe("cpp-ast-003 printf-format-of-parameter", () => {
  it("flags printf(fmt) when fmt is a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `int log(const char *fmt) { return printf(fmt); }\n`;
    const r = await runAstPatterns(C_CPP_AST_PATTERNS, "/tmp/x.c", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "cpp-ast-003-printf-format-of-parameter");
      expect(hits.length).toBe(1);
      expect(hits[0]!.matched_text).toBe("printf(fmt)");
    });
  });

  it("does NOT flag printf with a literal format and a parameter argument", async () => {
    _resetAstRunnerForTest();
    const code = `int log(const char *p) { return printf("%s\\n", p); }\n`;
    const r = await runAstPatterns(C_CPP_AST_PATTERNS, "/tmp/x.c", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "cpp-ast-003-printf-format-of-parameter");
      expect(hits.length).toBe(0);
    });
  });

  it("flags wprintf and puts the same way", async () => {
    _resetAstRunnerForTest();
    const code = `void a(const wchar_t *fmt) { wprintf(fmt); }\nint b(const char *s) { return puts(s); }\n`;
    const r = await runAstPatterns(C_CPP_AST_PATTERNS, "/tmp/x.c", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "cpp-ast-003-printf-format-of-parameter");
      expect(hits.length).toBe(2);
    });
  });
});

describe("c-cpp-patterns shape", () => {
  it("declares ids, severities, and CWEs", () => {
    const ids = C_CPP_AST_PATTERNS.map((p) => p.id).sort();
    expect(ids).toEqual([
      "cpp-ast-001-system-of-parameter",
      "cpp-ast-002-strcpy-of-parameter",
      "cpp-ast-003-printf-format-of-parameter",
    ]);
    const get = (id: string) => C_CPP_AST_PATTERNS.find((p) => p.id === id);
    expect(get("cpp-ast-001-system-of-parameter")?.cwe).toBe("CWE-78");
    expect(get("cpp-ast-002-strcpy-of-parameter")?.cwe).toBe("CWE-120");
    expect(get("cpp-ast-003-printf-format-of-parameter")?.cwe).toBe("CWE-134");
    for (const p of C_CPP_AST_PATTERNS) {
      expect(p.languages).toEqual(["c", "cpp"]);
      expect(typeof p.match).toBe("function");
    }
  });
});
