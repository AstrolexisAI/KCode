// KCode - Pattern fixture regression harness
//
// Every pattern in ALL_PATTERNS must ship with a directory under
// `tests/patterns/<pattern-id>/` containing:
//
//   - positive.<ext>            → the pattern MUST fire at least once
//   - negative.<ext>             → the pattern MUST NOT fire
//   - negative-<suffix>.<ext>    → optional extra negatives for
//                                  edge cases (in-comment, placeholder
//                                  strings, flag variants, etc.)
//
// This file discovers every pattern dir, looks up the pattern by its
// directory name, and asserts both directions. Adding a new pattern
// is then a three-step ritual:
//
//   1. Add the pattern to the appropriate src/core/audit-engine/patterns/<lang>.ts
//   2. Create tests/patterns/<pattern-id>/{positive,negative}.<ext>
//   3. Run `bun test fixture-harness.test.ts` and watch it pass
//
// The harness is the reason KCode can add patterns aggressively —
// a regex that slips past human review still has to match the
// fixture or CI goes red.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALL_PATTERNS, getPatternById } from "./patterns";
import { scanPatternAgainstContent } from "./scanner";
import type { BugPattern } from "./types";

const FIXTURES_ROOT = join(import.meta.dir, "../../..", "tests", "patterns");

function listFixtureDirs(): string[] {
  try {
    return readdirSync(FIXTURES_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function listFilesMatching(dir: string, kind: "positive" | "negative"): string[] {
  const full = join(FIXTURES_ROOT, dir);
  try {
    return readdirSync(full)
      .filter((f) => {
        const base = f.split(".")[0] ?? "";
        if (kind === "positive") return base === "positive";
        return base === "negative" || base.startsWith("negative-");
      })
      .map((f) => join(full, f));
  } catch {
    return [];
  }
}

const fixtureDirs = listFixtureDirs();

// Catch the most common setup bug: a new pattern without fixtures or
// a fixture dir without a registered pattern. Fails fast with the
// offending ID so the author sees exactly what's missing.
describe("fixture harness — coverage", () => {
  test("every fixture directory corresponds to a registered pattern ID", () => {
    const patternIds = new Set(ALL_PATTERNS.map((p) => p.id));
    const orphans = fixtureDirs.filter((d) => !patternIds.has(d));
    expect(orphans, `orphan fixture dirs (no matching pattern): ${orphans.join(", ")}`).toEqual([]);
  });

  test("fixture root is discoverable and non-empty", () => {
    expect(fixtureDirs.length).toBeGreaterThan(0);
    // Sanity: the dir exists and we actually read entries
    expect(() => statSync(FIXTURES_ROOT)).not.toThrow();
  });
});

// One describe block per pattern dir. Each block runs one test per
// fixture file inside it. This gives a readable failure like:
//
//   (fail) fixtures: cpp-001-ptr-address-index > negative.c (must NOT fire)
//
// instead of a single aggregate test that just says "something broke".
for (const dir of fixtureDirs) {
  describe(`fixtures: ${dir}`, () => {
    // v2.10.351 — getPatternById's return type widened to
    // LookupPattern (a structural subset of BugPattern that AST
    // patterns also satisfy). The fixture harness iterates only
    // regex pattern ids (filtered via ALL_PATTERNS at line 65), so
    // every result here is a real BugPattern. The cast is safe and
    // narrow.
    const lookup = getPatternById(dir);
    const pattern = lookup as BugPattern | undefined;

    test(`pattern "${dir}" is registered`, () => {
      expect(
        pattern,
        `No pattern with id=${dir}. Did you add the fixture dir before the pattern?`,
      ).toBeDefined();
    });

    if (!pattern) return;

    // ── Positive cases — MUST fire ─────────────────────────────
    const positives = listFilesMatching(dir, "positive");
    test(`${dir} has at least one positive fixture`, () => {
      expect(positives.length, `no positive.* found in tests/patterns/${dir}/`).toBeGreaterThan(0);
    });

    for (const file of positives) {
      const name = file.split("/").pop()!;
      test(`${name} (must fire)`, () => {
        const content = readFileSync(file, "utf-8");
        const hits = scanPatternAgainstContent(pattern, file, content, {
          bypassPathFilters: true,
        });
        expect(
          hits.length,
          `pattern ${dir} should match ${name} but returned 0 candidates. ` +
            `Either the regex is wrong or the fixture no longer exercises the bug.`,
        ).toBeGreaterThan(0);
      });
    }

    // ── Negative cases — MUST NOT fire ─────────────────────────
    const negatives = listFilesMatching(dir, "negative");
    for (const file of negatives) {
      const name = file.split("/").pop()!;
      test(`${name} (must NOT fire)`, () => {
        const content = readFileSync(file, "utf-8");
        const hits = scanPatternAgainstContent(pattern, file, content, {
          bypassPathFilters: true,
        });
        expect(
          hits.length,
          `pattern ${dir} should NOT match ${name} but returned ${hits.length} candidate(s): ` +
            hits
              .slice(0, 3)
              .map((h) => `line ${h.line}: "${h.matched_text.slice(0, 60)}"`)
              .join("; "),
        ).toBe(0);
      });
    }
  });
}
