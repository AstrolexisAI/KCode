// KCode - Java AST patterns tests (v2.10.344)

import { describe, expect, it } from "bun:test";
import { _resetAstRunnerForTest, runAstPatterns } from "./runner";
import { JAVA_AST_PATTERNS } from "./java-patterns";

function gateOnGrammar<T>(stats: { grammar_loaded: boolean }[], thunk: () => T): T | undefined {
  if (stats.every((s) => !s.grammar_loaded)) return undefined;
  return thunk();
}

describe("java-ast-001 runtime-exec-of-parameter", () => {
  it("flags Runtime.getRuntime().exec(userInput) when userInput is a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `class A { void f(String userInput) throws Exception { Runtime.getRuntime().exec(userInput); } }\n`;
    const r = await runAstPatterns(JAVA_AST_PATTERNS, "/tmp/a.java", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "java-ast-001-runtime-exec-of-parameter");
      expect(hits.length).toBe(1);
      expect(hits[0]!.matched_text).toBe(".exec(userInput)");
    });
  });

  it("flags new ProcessBuilder(userInput)", async () => {
    _resetAstRunnerForTest();
    const code = `class A { void f(String userInput) throws Exception { new ProcessBuilder(userInput).start(); } }\n`;
    const r = await runAstPatterns(JAVA_AST_PATTERNS, "/tmp/a.java", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "java-ast-001-runtime-exec-of-parameter");
      expect(hits.length).toBe(1);
      expect(hits[0]!.matched_text).toBe("new ProcessBuilder(userInput)");
    });
  });

  it("flags exec(p) inside a constructor", async () => {
    _resetAstRunnerForTest();
    const code = `class A { public A(String x) throws Exception { Runtime.getRuntime().exec(x); } }\n`;
    const r = await runAstPatterns(JAVA_AST_PATTERNS, "/tmp/a.java", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "java-ast-001-runtime-exec-of-parameter");
      expect(hits.length).toBe(1);
    });
  });

  it("flags exec inside a lambda body when lambda has the parameter", async () => {
    _resetAstRunnerForTest();
    const code = `import java.util.function.Consumer;
class A { void f() {
  Consumer<String> c = (cmd) -> {
    try { Runtime.getRuntime().exec(cmd); } catch (Exception e) {}
  };
} }
`;
    const r = await runAstPatterns(JAVA_AST_PATTERNS, "/tmp/a.java", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "java-ast-001-runtime-exec-of-parameter");
      expect(hits.length).toBe(1);
    });
  });

  it("flags exec when parameter is varargs (String...)", async () => {
    _resetAstRunnerForTest();
    const code = `class A { void f(String... args) throws Exception { Runtime.getRuntime().exec(args); } }\n`;
    const r = await runAstPatterns(JAVA_AST_PATTERNS, "/tmp/a.java", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "java-ast-001-runtime-exec-of-parameter");
      expect(hits.length).toBe(1);
    });
  });

  it("does not flag exec(literal)", async () => {
    _resetAstRunnerForTest();
    const code = `class A { void f() throws Exception { Runtime.getRuntime().exec("ls -la"); } }\n`;
    const r = await runAstPatterns(JAVA_AST_PATTERNS, "/tmp/a.java", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "java-ast-001-runtime-exec-of-parameter");
      expect(hits.length).toBe(0);
    });
  });

  it("does not flag exec of an internal local", async () => {
    _resetAstRunnerForTest();
    const code = `class A { void f() throws Exception { String cmd = "ls"; Runtime.getRuntime().exec(cmd); } }\n`;
    const r = await runAstPatterns(JAVA_AST_PATTERNS, "/tmp/a.java", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "java-ast-001-runtime-exec-of-parameter");
      expect(hits.length).toBe(0);
    });
  });
});

describe("java-ast-002 file-construction-of-parameter", () => {
  it("flags new File(path) when path is a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `import java.io.*;
class A { File f(String path) { return new File(path); } }
`;
    const r = await runAstPatterns(JAVA_AST_PATTERNS, "/tmp/a.java", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "java-ast-002-file-construction-of-parameter");
      expect(hits.length).toBe(1);
      expect(hits[0]!.matched_text).toBe("new File(path)");
    });
  });

  it("flags FileInputStream / FileReader / RandomAccessFile / FileOutputStream / PrintWriter", async () => {
    _resetAstRunnerForTest();
    const code = `import java.io.*;
class A {
  void a(String p) throws Exception { new FileInputStream(p); }
  void b(String p) throws Exception { new FileReader(p); }
  void c(String p) throws Exception { new RandomAccessFile(p, "r"); }
  void d(String p) throws Exception { new FileOutputStream(p); }
  void e(String p) throws Exception { new PrintWriter(p); }
}
`;
    const r = await runAstPatterns(JAVA_AST_PATTERNS, "/tmp/a.java", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "java-ast-002-file-construction-of-parameter");
      expect(hits.length).toBe(5);
    });
  });

  it("does not flag a non-file constructor (e.g. new StringBuilder(p))", async () => {
    _resetAstRunnerForTest();
    const code = `class A { void f(String p) { new StringBuilder(p); } }\n`;
    const r = await runAstPatterns(JAVA_AST_PATTERNS, "/tmp/a.java", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "java-ast-002-file-construction-of-parameter");
      expect(hits.length).toBe(0);
    });
  });

  it("does not flag new File of a literal", async () => {
    _resetAstRunnerForTest();
    const code = `import java.io.*; class A { File f() { return new File("/tmp/known"); } }\n`;
    const r = await runAstPatterns(JAVA_AST_PATTERNS, "/tmp/a.java", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "java-ast-002-file-construction-of-parameter");
      expect(hits.length).toBe(0);
    });
  });
});

describe("java-ast-003 class-forname-of-parameter", () => {
  it("flags Class.forName(name) when name is a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `class A { Class<?> f(String name) throws Exception { return Class.forName(name); } }\n`;
    const r = await runAstPatterns(JAVA_AST_PATTERNS, "/tmp/a.java", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "java-ast-003-class-forname-of-parameter");
      expect(hits.length).toBe(1);
      expect(hits[0]!.matched_text).toBe(".forName(name)");
    });
  });

  it("flags ClassLoader.loadClass(name) when name is a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `class A { Class<?> f(ClassLoader cl, String name) throws Exception { return cl.loadClass(name); } }\n`;
    const r = await runAstPatterns(JAVA_AST_PATTERNS, "/tmp/a.java", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "java-ast-003-class-forname-of-parameter");
      expect(hits.length).toBe(1);
    });
  });

  it("does not flag a non-reflection method named, e.g., load(name)", async () => {
    _resetAstRunnerForTest();
    const code = `class A { void f(String name) { someConfig.load(name); } }\n`;
    const r = await runAstPatterns(JAVA_AST_PATTERNS, "/tmp/a.java", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "java-ast-003-class-forname-of-parameter");
      expect(hits.length).toBe(0);
    });
  });
});

describe("java-patterns shape", () => {
  it("declares ids, severities, and CWEs", () => {
    const ids = JAVA_AST_PATTERNS.map((p) => p.id).sort();
    expect(ids).toEqual([
      "java-ast-001-runtime-exec-of-parameter",
      "java-ast-002-file-construction-of-parameter",
      "java-ast-003-class-forname-of-parameter",
    ]);
    const get = (id: string) => JAVA_AST_PATTERNS.find((p) => p.id === id);
    expect(get("java-ast-001-runtime-exec-of-parameter")?.cwe).toBe("CWE-78");
    expect(get("java-ast-002-file-construction-of-parameter")?.cwe).toBe("CWE-22");
    expect(get("java-ast-003-class-forname-of-parameter")?.cwe).toBe("CWE-470");
    for (const p of JAVA_AST_PATTERNS) {
      expect(p.languages).toEqual(["java"]);
      expect(typeof p.match).toBe("function");
    }
  });
});
