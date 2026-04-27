// KCode - Tests for v2.10.328 fix_support classification (Sprint 3).

import { describe, expect, it } from "bun:test";
import { fixSupportFor, hasFixRecipe } from "./fixer";

describe("fixSupportFor", () => {
  it("returns 'rewrite' for SAFE bespoke fixers (mechanical, --safe-only eligible)", () => {
    // v2.10.389 (P1.2) — only the safe tier reports "rewrite". These
    // are mechanical transformations that preserve semantics modulo
    // the bug shape itself, OK to apply in CI under --safe-only.
    const safeBespokeIds = [
      "cpp-001-ptr-address-index",
      "cpp-003-unchecked-data-index",
      "fsw-005-buffer-getdata-unchecked",
      "fsw-010-cmd-arg-before-validate",
      "dart-005-setstate-after-dispose",
      "py-005-yaml-unsafe-load",
      "py-013-bare-except",
    ];
    for (const id of safeBespokeIds) {
      expect(fixSupportFor(id)).toBe("rewrite");
      expect(hasFixRecipe(id)).toBe(true);
    }
  });

  it("returns 'annotate' for HEURISTIC bespoke fixers (--all only, --safe-only excludes)", () => {
    // v2.10.389 (P1.2) — heuristic fixers were flagged by the
    // external audit as too context-dependent for --safe-only:
    //   - cpp-006: strncpy doesn't null-terminate
    //   - py-001: ast.literal_eval breaks code-style eval
    //   - py-002: shell=False needs list args
    //   - py-004: parameterized form is driver-specific
    //   - py-008: assert disappears under python -O
    // hasFixRecipe() still returns true (the bespoke is wired for
    // --all), but fix_support reports "annotate" so --safe-only
    // doesn't promise a rewrite.
    const heuristicBespokeIds = [
      "cpp-006-strcpy-family",
      "py-001-eval-exec",
      "py-002-shell-injection",
      "py-004-sql-injection",
      "py-008-path-traversal",
    ];
    for (const id of heuristicBespokeIds) {
      expect(fixSupportFor(id)).toBe("annotate");
      expect(hasFixRecipe(id)).toBe(true);
    }
  });

  it("returns 'annotate' for patterns with PATTERN_RECIPES entries (no bespoke)", () => {
    // These are in PATTERN_RECIPES but not in BESPOKE_PATTERN_IDS.
    const annotated = [
      "crypto-001-rand-for-key-material",
      "inj-001-sql-string-concat",
      "des-001-pickle-loads",
      "fsw-003-assert-as-validation",
    ];
    for (const id of annotated) {
      expect(fixSupportFor(id)).toBe("annotate");
      expect(hasFixRecipe(id)).toBe(true);
    }
  });

  it("returns 'manual' for unknown / unregistered pattern ids", () => {
    expect(fixSupportFor("not-a-real-pattern-xyz")).toBe("manual");
    expect(fixSupportFor("cpp-9999-future-thing")).toBe("manual");
    expect(hasFixRecipe("not-a-real-pattern-xyz")).toBe(false);
  });

  it("output is exactly one of rewrite|annotate|manual", () => {
    const tier = fixSupportFor("anything");
    expect(["rewrite", "annotate", "manual"]).toContain(tier);
  });
});
