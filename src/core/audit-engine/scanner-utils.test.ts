// KCode - Scanner utility tests
//
// Direct coverage for the primitives the pattern scanner is built
// on: comment-range computation, in-comment detection, language
// detection, and (indirectly) the comment-aware scan path. The
// fixture-harness file covers the happy path per pattern; this
// file covers the load-bearing helpers that every pattern depends
// on.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeCommentRanges,
  detectLanguages,
  findSourceFiles,
  isInsideComment,
  scanPatternAgainstContent,
} from "./scanner";
import type { BugPattern } from "./types";

// ─── computeCommentRanges ─────────────────────────────────────────

describe("computeCommentRanges — C-style languages", () => {
  test("single-line // comment", () => {
    const src = "int x = 1;\n// this is a comment\nint y = 2;\n";
    const ranges = computeCommentRanges(src, "c");
    expect(ranges).toHaveLength(1);
    const [start, end] = ranges[0]!;
    expect(src.slice(start, end)).toBe("// this is a comment");
  });

  test("block comment /* ... */", () => {
    const src = "int x = 1;/* multi\nline\nblock */int y;";
    const ranges = computeCommentRanges(src, "cpp");
    expect(ranges).toHaveLength(1);
    const [start, end] = ranges[0]!;
    expect(src.slice(start, end)).toBe("/* multi\nline\nblock */");
  });

  test("unterminated block comment runs to EOF", () => {
    const src = "x = 1;/* never closes";
    const ranges = computeCommentRanges(src, "c");
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.[1]).toBe(src.length);
  });

  test("multiple comments interleaved with code", () => {
    const src = "a();\n// one\nb();\n/* two */\nc(); // three";
    const ranges = computeCommentRanges(src, "javascript");
    expect(ranges).toHaveLength(3);
  });

  test("applies to typescript, go, rust, java, swift, php", () => {
    for (const lang of ["typescript", "go", "rust", "java", "swift", "php"] as const) {
      const ranges = computeCommentRanges("x = 1; // ignored", lang);
      expect(ranges.length).toBeGreaterThan(0);
    }
  });
});

describe("computeCommentRanges — hash-style languages", () => {
  test("# line comment in Python", () => {
    const src = "x = 1  # trailing\nY = 2\n# whole-line\n";
    const ranges = computeCommentRanges(src, "python");
    expect(ranges).toHaveLength(2);
  });

  test("applies to ruby and bash too", () => {
    for (const lang of ["ruby", "bash"] as const) {
      const ranges = computeCommentRanges("cmd # comment", lang);
      expect(ranges).toHaveLength(1);
    }
  });

  test("does NOT treat # inside code as a comment when language lacks hash support", () => {
    // JavaScript doesn't have # line comments (ignoring private-field #foo).
    const src = "const p = '#not-a-comment';";
    const ranges = computeCommentRanges(src, "javascript");
    expect(ranges).toHaveLength(0);
  });
});

describe("computeCommentRanges — language without comment support", () => {
  test("returns empty for SQL (not in either set)", () => {
    const src = "SELECT * FROM users -- this is a SQL comment";
    const ranges = computeCommentRanges(src, "sql");
    // First-pass scanner doesn't model SQL --, so nothing is
    // suppressed. Documented limitation.
    expect(ranges).toEqual([]);
  });
});

// ─── isInsideComment ──────────────────────────────────────────────

describe("isInsideComment", () => {
  const ranges: Array<[number, number]> = [
    [10, 20],
    [50, 80],
  ];

  test("index inside first range", () => {
    expect(isInsideComment(ranges, 15)).toBe(true);
  });
  test("index inside second range", () => {
    expect(isInsideComment(ranges, 65)).toBe(true);
  });
  test("index before any range", () => {
    expect(isInsideComment(ranges, 5)).toBe(false);
  });
  test("index between ranges", () => {
    expect(isInsideComment(ranges, 30)).toBe(false);
  });
  test("index after all ranges", () => {
    expect(isInsideComment(ranges, 100)).toBe(false);
  });
  test("exact-end is NOT inside (half-open interval)", () => {
    expect(isInsideComment(ranges, 20)).toBe(false);
  });
  test("exact-start IS inside", () => {
    expect(isInsideComment(ranges, 10)).toBe(true);
  });
  test("empty range list always returns false", () => {
    expect(isInsideComment([], 42)).toBe(false);
  });
});

// ─── scanPatternAgainstContent comment suppression ────────────────
// End-to-end check: a pattern whose regex matches text inside a
// comment must return zero candidates. Proves the scanner wires
// computeCommentRanges into applyPattern correctly. Regression for
// the whole class of "eval( appears inside a /* ... */ docblock"
// false positives.

describe("scanPatternAgainstContent — comment suppression", () => {
  const evalPattern: BugPattern = {
    id: "test-js-eval",
    title: "eval() call",
    severity: "high",
    languages: ["javascript"],
    regex: /\beval\s*\(/g,
    explanation: "test",
    verify_prompt: "test",
    cwd: undefined as never,
  } as unknown as BugPattern;

  test("matches real eval() call", () => {
    const src = "const x = eval('1+1');";
    const hits = scanPatternAgainstContent(evalPattern, "/tmp/a.js", src, {
      bypassPathFilters: true,
    });
    expect(hits.length).toBe(1);
  });

  test("suppresses eval( inside a // line comment", () => {
    const src = "// TODO: don't use eval(userInput)\nconst x = 1;";
    const hits = scanPatternAgainstContent(evalPattern, "/tmp/a.js", src, {
      bypassPathFilters: true,
    });
    expect(hits.length).toBe(0);
  });

  test("suppresses eval( inside a /* block */ comment", () => {
    const src = "/* historical note: we used eval('x') */\nconst x = 1;";
    const hits = scanPatternAgainstContent(evalPattern, "/tmp/a.js", src, {
      bypassPathFilters: true,
    });
    expect(hits.length).toBe(0);
  });

  test("catches eval( on code even when a sibling comment also has eval(", () => {
    const src = "// don't: eval('a')\nconst x = eval('b');";
    const hits = scanPatternAgainstContent(evalPattern, "/tmp/a.js", src, {
      bypassPathFilters: true,
    });
    expect(hits.length).toBe(1);
  });

  test("returns [] when pattern's languages list excludes the file's language", () => {
    const hits = scanPatternAgainstContent(evalPattern, "/tmp/a.py", "eval('1+1')", {
      bypassPathFilters: true,
    });
    expect(hits).toEqual([]);
  });
});

// ─── detectLanguages ──────────────────────────────────────────────

describe("detectLanguages", () => {
  test("maps common extensions correctly", () => {
    const langs = detectLanguages([
      "/a.c",
      "/a.cpp",
      "/a.py",
      "/a.ts",
      "/a.js",
      "/a.go",
      "/a.rs",
      "/a.java",
    ]);
    // Order isn't guaranteed; check membership.
    expect(new Set(langs)).toEqual(
      new Set(["c", "cpp", "python", "typescript", "javascript", "go", "rust", "java"]),
    );
  });

  test("ignores unknown extensions", () => {
    const langs = detectLanguages(["/a.xyz", "/b.docx"]);
    expect(langs).toEqual([]);
  });

  test("deduplicates when multiple files share a language", () => {
    const langs = detectLanguages(["/a.c", "/b.c", "/c.c"]);
    expect(langs).toEqual(["c"]);
  });
});

// ─── findSourceFiles ──────────────────────────────────────────────

describe("findSourceFiles", () => {
  test("discovers supported extensions in a flat tree", () => {
    const root = mkdtempSync(join(tmpdir(), "kcode-scan-"));
    try {
      writeFileSync(join(root, "a.c"), "int main(){}");
      writeFileSync(join(root, "b.py"), "x = 1");
      writeFileSync(join(root, "README"), "not source");
      const files = findSourceFiles(root);
      const names = files.map((f) => f.split("/").pop()!).sort();
      expect(names).toEqual(["a.c", "b.py"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips node_modules / build / 3rdParty", () => {
    const root = mkdtempSync(join(tmpdir(), "kcode-scan-"));
    try {
      for (const skip of ["node_modules", "build", "3rdParty", ".git"]) {
        mkdirSync(join(root, skip));
        writeFileSync(join(root, skip, "a.c"), "int main(){}");
      }
      writeFileSync(join(root, "real.c"), "int main(){}");
      const files = findSourceFiles(root);
      expect(files).toHaveLength(1);
      expect(files[0]).toContain("real.c");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not follow symlinks that escape the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "kcode-scan-"));
    const escapee = mkdtempSync(join(tmpdir(), "kcode-outside-"));
    try {
      writeFileSync(join(escapee, "secret.c"), "int main(){}");
      writeFileSync(join(root, "own.c"), "int main(){}");
      symlinkSync(escapee, join(root, "linked"));
      const files = findSourceFiles(root);
      // We only expect the real file; the symlink that escapes root
      // must not leak files from outside.
      expect(files.some((f) => f.endsWith("own.c"))).toBe(true);
      expect(files.some((f) => f.includes("secret.c"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(escapee, { recursive: true, force: true });
    }
  });

  test("respects maxFiles cap", () => {
    const root = mkdtempSync(join(tmpdir(), "kcode-scan-"));
    try {
      for (let i = 0; i < 20; i++) {
        writeFileSync(join(root, `f${i}.c`), "int main(){}");
      }
      const files = findSourceFiles(root, 5);
      expect(files.length).toBeLessThanOrEqual(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
