// KCode - PHP AST patterns tests (v2.10.349)

import { describe, expect, it } from "bun:test";
import { _resetAstRunnerForTest, runAstPatterns } from "./runner";
import { PHP_AST_PATTERNS } from "./php-patterns";

function gateOnGrammar<T>(stats: { grammar_loaded: boolean }[], thunk: () => T): T | undefined {
  if (stats.every((s) => !s.grammar_loaded)) return undefined;
  return thunk();
}

describe("php-ast-001 eval-of-parameter", () => {
  it("flags eval($p) when $p is a parameter", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(PHP_AST_PATTERNS, "/tmp/a.php", `<?php function f($p) { eval($p); }`);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "php-ast-001-eval-of-parameter");
      expect(hits.length).toBe(1);
      expect(hits[0]!.matched_text).toBe("eval($p)");
    });
  });

  it("flags assert($p) (string-form RCE in PHP <8)", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(PHP_AST_PATTERNS, "/tmp/a.php", `<?php function f($p) { assert($p); }`);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "php-ast-001-eval-of-parameter");
      expect(hits.length).toBe(1);
    });
  });

  it("flags eval inside a class method, anonymous fn, arrow fn", async () => {
    _resetAstRunnerForTest();
    const code = `<?php
class A { public function m($p) { eval($p); } }
$f = function($p) { eval($p); };
$g = fn($p) => eval($p);
`;
    const r = await runAstPatterns(PHP_AST_PATTERNS, "/tmp/a.php", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "php-ast-001-eval-of-parameter");
      expect(hits.length).toBe(3);
    });
  });

  it("does NOT flag eval(literal) or internal local", async () => {
    _resetAstRunnerForTest();
    const code = `<?php
function a() { eval("1+1"); }
function b() { $x = "code"; eval($x); }
`;
    const r = await runAstPatterns(PHP_AST_PATTERNS, "/tmp/a.php", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "php-ast-001-eval-of-parameter");
      expect(hits.length).toBe(0);
    });
  });
});

describe("php-ast-002 shell-of-parameter", () => {
  it("flags system / shell_exec / exec / passthru / popen / proc_open / pcntl_exec", async () => {
    _resetAstRunnerForTest();
    const code = `<?php
function a($p) { system($p); }
function b($p) { shell_exec($p); }
function c($p) { exec($p); }
function d($p) { passthru($p); }
function e($p) { popen($p, "r"); }
function g($p) { proc_open($p, [], $pipes); }
function h($p) { pcntl_exec($p); }
`;
    const r = await runAstPatterns(PHP_AST_PATTERNS, "/tmp/a.php", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "php-ast-002-shell-of-parameter");
      expect(hits.length).toBe(7);
    });
  });

  it("does NOT flag system(literal)", async () => {
    _resetAstRunnerForTest();
    const r = await runAstPatterns(PHP_AST_PATTERNS, "/tmp/a.php", `<?php function f() { system("ls"); }`);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "php-ast-002-shell-of-parameter");
      expect(hits.length).toBe(0);
    });
  });
});

describe("php-ast-003 include-of-parameter", () => {
  it("flags include / require / include_once / require_once with a param", async () => {
    _resetAstRunnerForTest();
    const code = `<?php
function a($p) { include $p; }
function b($p) { include_once $p; }
function c($p) { require $p; }
function d($p) { require_once $p; }
`;
    const r = await runAstPatterns(PHP_AST_PATTERNS, "/tmp/a.php", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "php-ast-003-include-of-parameter");
      expect(hits.length).toBe(4);
    });
  });

  it("flags file_get_contents / fopen / readfile / parse_ini_file", async () => {
    _resetAstRunnerForTest();
    const code = `<?php
function a($p) { file_get_contents($p); }
function b($p) { fopen($p, "r"); }
function c($p) { readfile($p); }
function d($p) { parse_ini_file($p); }
`;
    const r = await runAstPatterns(PHP_AST_PATTERNS, "/tmp/a.php", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "php-ast-003-include-of-parameter");
      expect(hits.length).toBe(4);
    });
  });

  it("does NOT flag include of a literal or hardcoded path", async () => {
    _resetAstRunnerForTest();
    const code = `<?php
function a() { include "config.php"; }
function b() { $path = "/etc/known"; include $path; }
`;
    const r = await runAstPatterns(PHP_AST_PATTERNS, "/tmp/a.php", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "php-ast-003-include-of-parameter");
      expect(hits.length).toBe(0);
    });
  });

  it("does NOT flag a non-file callee that takes a path-shaped name", async () => {
    _resetAstRunnerForTest();
    const code = `<?php function f($p) { my_handler($p); }`;
    const r = await runAstPatterns(PHP_AST_PATTERNS, "/tmp/a.php", code);
    gateOnGrammar(r.stats, () => {
      const hits = r.candidates.filter((c) => c.pattern_id === "php-ast-003-include-of-parameter");
      expect(hits.length).toBe(0);
    });
  });
});

describe("php-patterns shape", () => {
  it("declares ids, severities, and CWEs", () => {
    const ids = PHP_AST_PATTERNS.map((p) => p.id).sort();
    expect(ids).toEqual([
      "php-ast-001-eval-of-parameter",
      "php-ast-002-shell-of-parameter",
      "php-ast-003-include-of-parameter",
    ]);
    const get = (id: string) => PHP_AST_PATTERNS.find((p) => p.id === id);
    expect(get("php-ast-001-eval-of-parameter")?.cwe).toBe("CWE-95");
    expect(get("php-ast-002-shell-of-parameter")?.cwe).toBe("CWE-78");
    expect(get("php-ast-003-include-of-parameter")?.cwe).toBe("CWE-98");
    for (const p of PHP_AST_PATTERNS) {
      expect(p.languages).toEqual(["php"]);
    }
  });
});
