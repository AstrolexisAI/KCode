// KCode - Go AST patterns tests (v2.10.340)
//
// Same skip-when-grammar-missing predicate as the python and JS
// pattern tests so the suite stays green on hosts without the
// bundled wasm.

import { describe, expect, it } from "bun:test";
import { _resetAstRunnerForTest, runAstPatterns } from "./runner";
import { GO_AST_PATTERNS } from "./go-patterns";

function gateOnGrammar<T>(stats: { grammar_loaded: boolean }[], thunk: () => T): T | undefined {
  if (stats.every((s) => !s.grammar_loaded)) return undefined;
  return thunk();
}

describe("go-ast-001 exec.Command-of-parameter", () => {
  it("flags exec.Command(x) when x is a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `package main
import "os/exec"
func handler(userInput string) { exec.Command(userInput) }
`;
    const r = await runAstPatterns(GO_AST_PATTERNS, "/tmp/a.go", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "go-ast-001-exec-command-of-parameter");
      expect(hits.length).toBe(1);
      expect(hits[0]!.matched_text).toBe("exec.Command(userInput)");
    });
  });

  it("does NOT flag exec.CommandContext(ctx, x) — Command-only by design", async () => {
    // CommandContext takes (ctx, name, ...args); the binary is
    // argument 1, not 0. The anchored query in go-ast-001 matches
    // argument 0 only, so CommandContext doesn't fire. The regex
    // pattern go-007 covers the string-level match.
    _resetAstRunnerForTest();
    const code = `package main
import (
  "context"
  "os/exec"
)
func handler(ctx context.Context, x string) { exec.CommandContext(ctx, x) }
`;
    const r = await runAstPatterns(GO_AST_PATTERNS, "/tmp/a.go", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "go-ast-001-exec-command-of-parameter");
      expect(hits.length).toBe(0);
    });
  });

  it("does not flag exec.Command(literal)", async () => {
    _resetAstRunnerForTest();
    const code = `package main
import "os/exec"
func f() { exec.Command("ls") }
`;
    const r = await runAstPatterns(GO_AST_PATTERNS, "/tmp/a.go", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "go-ast-001-exec-command-of-parameter");
      expect(hits.length).toBe(0);
    });
  });

  it("does not flag exec.Command of an internal local", async () => {
    _resetAstRunnerForTest();
    const code = `package main
import "os/exec"
func f() {
  cmd := "ls"
  exec.Command(cmd)
}
`;
    const r = await runAstPatterns(GO_AST_PATTERNS, "/tmp/a.go", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "go-ast-001-exec-command-of-parameter");
      expect(hits.length).toBe(0);
    });
  });

  it("flags exec.Command(x) on a method receiver — receiver name is in scope but not used as arg", async () => {
    _resetAstRunnerForTest();
    const code = `package main
import "os/exec"
type S struct{}
func (s *S) Run(cmd string) { exec.Command(cmd) }
`;
    const r = await runAstPatterns(GO_AST_PATTERNS, "/tmp/a.go", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "go-ast-001-exec-command-of-parameter");
      expect(hits.length).toBe(1);
      expect(hits[0]!.matched_text).toBe("exec.Command(cmd)");
    });
  });

  it("flags exec.Command(x) inside a func literal that is itself inside another function", async () => {
    _resetAstRunnerForTest();
    const code = `package main
import "os/exec"
func outer() {
  f := func(inner string) { exec.Command(inner) }
  _ = f
}
`;
    const r = await runAstPatterns(GO_AST_PATTERNS, "/tmp/a.go", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "go-ast-001-exec-command-of-parameter");
      expect(hits.length).toBe(1);
      expect(hits[0]!.matched_text).toBe("exec.Command(inner)");
    });
  });

  it("does not flag a non-exec package: cmd.Command(x)", async () => {
    _resetAstRunnerForTest();
    const code = `package main
type Cmd struct{}
func (c *Cmd) Command(x string) {}
func handler(input string) { var cmd Cmd; cmd.Command(input) }
`;
    const r = await runAstPatterns(GO_AST_PATTERNS, "/tmp/a.go", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "go-ast-001-exec-command-of-parameter");
      expect(hits.length).toBe(0);
    });
  });
});

describe("go-ast-002 os.Open-of-parameter", () => {
  it("flags os.Open(x) when x is a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `package main
import "os"
func handler(path string) { os.Open(path) }
`;
    const r = await runAstPatterns(GO_AST_PATTERNS, "/tmp/a.go", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "go-ast-002-os-open-of-parameter");
      expect(hits.length).toBe(1);
      expect(hits[0]!.matched_text).toBe("os.Open(path)");
    });
  });

  it("flags os.ReadFile / os.OpenFile / os.Remove of parameter", async () => {
    _resetAstRunnerForTest();
    const code = `package main
import "os"
func a(p string) { os.ReadFile(p) }
func b(p string) { os.OpenFile(p) }
func c(p string) { os.Remove(p) }
`;
    const r = await runAstPatterns(GO_AST_PATTERNS, "/tmp/a.go", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "go-ast-002-os-open-of-parameter");
      expect(hits.length).toBe(3);
    });
  });

  it("flags ioutil.ReadFile(x) when x is a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `package main
import "io/ioutil"
func handler(p string) { ioutil.ReadFile(p) }
`;
    const r = await runAstPatterns(GO_AST_PATTERNS, "/tmp/a.go", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "go-ast-002-os-open-of-parameter");
      expect(hits.length).toBe(1);
    });
  });

  it("does not flag os.Open of a literal", async () => {
    _resetAstRunnerForTest();
    const code = `package main
import "os"
func f() { os.Open("/etc/hosts") }
`;
    const r = await runAstPatterns(GO_AST_PATTERNS, "/tmp/a.go", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "go-ast-002-os-open-of-parameter");
      expect(hits.length).toBe(0);
    });
  });
});

describe("go-patterns shape", () => {
  it("declares ids and CWE", () => {
    const ids = GO_AST_PATTERNS.map((p) => p.id).sort();
    expect(ids).toEqual([
      "go-ast-001-exec-command-of-parameter",
      "go-ast-002-os-open-of-parameter",
    ]);
    expect(GO_AST_PATTERNS.find((p) => p.id === "go-ast-001-exec-command-of-parameter")!.cwe).toBe("CWE-78");
    expect(GO_AST_PATTERNS.find((p) => p.id === "go-ast-002-os-open-of-parameter")!.cwe).toBe("CWE-22");
    for (const p of GO_AST_PATTERNS) {
      expect(p.languages).toContain("go");
      expect(typeof p.match).toBe("function");
      expect(typeof p.query).toBe("string");
    }
  });
});
