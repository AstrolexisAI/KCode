// KCode - Rust AST patterns tests (v2.10.348)

import { describe, expect, it } from "bun:test";
import { _resetAstRunnerForTest, runAstPatterns } from "./runner";
import { RUST_AST_PATTERNS } from "./rust-patterns";

function gateOnGrammar<T>(stats: { grammar_loaded: boolean }[], thunk: () => T): T | undefined {
  if (stats.every((s) => !s.grammar_loaded)) return undefined;
  return thunk();
}

describe("rust-ast-001 command-new-of-parameter", () => {
  it("flags Command::new(cmd) when cmd is a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `fn run(cmd: &str) { Command::new(cmd); }\n`;
    const r = await runAstPatterns(RUST_AST_PATTERNS, "/tmp/a.rs", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rust-ast-001-command-new-of-parameter");
      expect(hits.length).toBe(1);
      expect(hits[0]!.matched_text).toBe("Command::new(cmd)");
    });
  });

  it("flags std::process::Command::new(cmd) — fully-qualified path", async () => {
    _resetAstRunnerForTest();
    const code = `fn run(cmd: &str) { std::process::Command::new(cmd); }\n`;
    const r = await runAstPatterns(RUST_AST_PATTERNS, "/tmp/a.rs", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rust-ast-001-command-new-of-parameter");
      expect(hits.length).toBe(1);
    });
  });

  it("flags inside impl method, async fn, and closure", async () => {
    _resetAstRunnerForTest();
    const code = `impl Service { fn execute(&self, cmd: &str) { Command::new(cmd); } }
async fn run(cmd: String) { Command::new(cmd); }
fn outer() { let f = |cmd: &str| Command::new(cmd); }
`;
    const r = await runAstPatterns(RUST_AST_PATTERNS, "/tmp/a.rs", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rust-ast-001-command-new-of-parameter");
      expect(hits.length).toBe(3);
    });
  });

  it("does NOT flag Command::new(literal)", async () => {
    _resetAstRunnerForTest();
    const code = `fn run() { Command::new("ls"); }\n`;
    const r = await runAstPatterns(RUST_AST_PATTERNS, "/tmp/a.rs", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rust-ast-001-command-new-of-parameter");
      expect(hits.length).toBe(0);
    });
  });

  it("does NOT flag a non-Command method ending in ::new", async () => {
    _resetAstRunnerForTest();
    const code = `fn run(cmd: &str) { Box::new(cmd); }\n`;
    const r = await runAstPatterns(RUST_AST_PATTERNS, "/tmp/a.rs", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rust-ast-001-command-new-of-parameter");
      expect(hits.length).toBe(0);
    });
  });

  it("does NOT flag Command of an internal local", async () => {
    _resetAstRunnerForTest();
    const code = `fn run() { let cmd = "ls"; Command::new(cmd); }\n`;
    const r = await runAstPatterns(RUST_AST_PATTERNS, "/tmp/a.rs", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rust-ast-001-command-new-of-parameter");
      expect(hits.length).toBe(0);
    });
  });
});

describe("rust-ast-002 fs-path-of-parameter", () => {
  it("flags File::open(path) when path is a parameter", async () => {
    _resetAstRunnerForTest();
    const code = `fn f(path: &str) -> std::io::Result<File> { File::open(path) }\n`;
    const r = await runAstPatterns(RUST_AST_PATTERNS, "/tmp/a.rs", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rust-ast-002-fs-path-of-parameter");
      expect(hits.length).toBe(1);
      expect(hits[0]!.matched_text).toBe("File::open(path)");
    });
  });

  it("flags File::create / File::create_new", async () => {
    _resetAstRunnerForTest();
    const code = `fn a(p: &str) { File::create(p); }
fn b(p: &str) { File::create_new(p); }
`;
    const r = await runAstPatterns(RUST_AST_PATTERNS, "/tmp/a.rs", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rust-ast-002-fs-path-of-parameter");
      expect(hits.length).toBe(2);
    });
  });

  it("flags std::fs::read_to_string / write / remove_file / canonicalize", async () => {
    _resetAstRunnerForTest();
    const code = `fn a(p: String) { std::fs::read_to_string(p); }
fn b(p: &str) { fs::write(p, "data"); }
fn c(p: &str) { std::fs::remove_file(p); }
fn d(p: &str) { fs::canonicalize(p); }
`;
    const r = await runAstPatterns(RUST_AST_PATTERNS, "/tmp/a.rs", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rust-ast-002-fs-path-of-parameter");
      expect(hits.length).toBe(4);
    });
  });

  it("does NOT flag File::open(literal)", async () => {
    _resetAstRunnerForTest();
    const code = `fn f() { File::open("/etc/hosts"); }\n`;
    const r = await runAstPatterns(RUST_AST_PATTERNS, "/tmp/a.rs", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rust-ast-002-fs-path-of-parameter");
      expect(hits.length).toBe(0);
    });
  });

  it("does NOT flag a non-fs method (e.g. HashMap::new)", async () => {
    _resetAstRunnerForTest();
    const code = `fn f(p: &str) { HashMap::open(p); }\n`;
    const r = await runAstPatterns(RUST_AST_PATTERNS, "/tmp/a.rs", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rust-ast-002-fs-path-of-parameter");
      expect(hits.length).toBe(0);
    });
  });

  it("flags despite mut binding: fn f(mut path: String)", async () => {
    _resetAstRunnerForTest();
    const code = `fn f(mut path: String) { File::open(path); }\n`;
    const r = await runAstPatterns(RUST_AST_PATTERNS, "/tmp/a.rs", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "rust-ast-002-fs-path-of-parameter");
      expect(hits.length).toBe(1);
    });
  });
});

describe("rust-patterns shape", () => {
  it("declares ids, severities, and CWEs", () => {
    const ids = RUST_AST_PATTERNS.map((p) => p.id).sort();
    expect(ids).toEqual([
      "rust-ast-001-command-new-of-parameter",
      "rust-ast-002-fs-path-of-parameter",
    ]);
    const get = (id: string) => RUST_AST_PATTERNS.find((p) => p.id === id);
    expect(get("rust-ast-001-command-new-of-parameter")?.cwe).toBe("CWE-78");
    expect(get("rust-ast-002-fs-path-of-parameter")?.cwe).toBe("CWE-22");
    for (const p of RUST_AST_PATTERNS) {
      expect(p.languages).toEqual(["rust"]);
      expect(typeof p.match).toBe("function");
    }
  });
});
