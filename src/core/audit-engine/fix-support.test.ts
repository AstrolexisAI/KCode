// KCode - Tests for v2.10.328 fix_support classification (Sprint 3).

import { describe, expect, it } from "bun:test";
import { fixSupportFor, hasFixRecipe } from "./fixer";

describe("fixSupportFor", () => {
  it("returns 'rewrite' for patterns with bespoke fixers", () => {
    // From BESPOKE_PATTERN_IDS at the bottom of fixer.ts.
    const bespokeIds = [
      "cpp-001-ptr-address-index",
      "cpp-003-unchecked-data-index",
      "cpp-006-strcpy-family",
      "fsw-005-buffer-getdata-unchecked",
      "fsw-010-cmd-arg-before-validate",
      "py-001-eval-exec",
      "dart-005-setstate-after-dispose",
    ];
    for (const id of bespokeIds) {
      expect(fixSupportFor(id)).toBe("rewrite");
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
