// Pattern fixture regression harness.
//
// Walks tests/patterns/<pattern-id>/ and asserts:
//   - Every positive.<ext> file produces ≥1 candidate for <pattern-id>
//   - Every negative.<ext> file produces 0 candidates for <pattern-id>
//
// Covers the regex stage only. The verifier LLM stage is out of
// scope here (see tests/patterns/README.md). If a pattern's regex
// ever loses precision from a refactor, this harness fails at CI
// time — which is the whole point.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getPatternById } from "../src/core/audit-engine/patterns";
import { scanPatternAgainstContent } from "../src/core/audit-engine/scanner";

const FIXTURES_ROOT = join(import.meta.dir, "patterns");

/** List every <pattern-id> directory under tests/patterns/. */
function listPatternDirs(): string[] {
  return readdirSync(FIXTURES_ROOT)
    .filter((name) => {
      const full = join(FIXTURES_ROOT, name);
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** List fixture files in a pattern dir, separated by positive/negative. */
function listFixtures(patternDir: string): {
  positives: string[];
  negatives: string[];
} {
  const entries = readdirSync(join(FIXTURES_ROOT, patternDir));
  const positives: string[] = [];
  const negatives: string[] = [];
  for (const name of entries) {
    if (name.startsWith("positive")) positives.push(name);
    else if (name.startsWith("negative")) negatives.push(name);
  }
  return { positives, negatives };
}

describe("pattern fixture harness — all patterns have the required fixtures", () => {
  const dirs = listPatternDirs();

  test("discovers at least one pattern directory", () => {
    // Guard against the harness silently finding zero fixtures due
    // to a path issue and "passing" by accident.
    expect(dirs.length).toBeGreaterThan(0);
  });

  for (const patternId of dirs) {
    test(`${patternId}: directory name matches a registered pattern id`, () => {
      const pattern = getPatternById(patternId);
      expect(pattern).toBeDefined();
    });

    test(`${patternId}: has at least one positive and one negative fixture`, () => {
      const { positives, negatives } = listFixtures(patternId);
      expect(positives.length).toBeGreaterThan(0);
      expect(negatives.length).toBeGreaterThan(0);
    });
  }
});

describe("pattern fixture harness — regex-stage invariants", () => {
  for (const patternId of listPatternDirs()) {
    const pattern = getPatternById(patternId);
    if (!pattern) continue; // reported by the previous suite
    const { positives, negatives } = listFixtures(patternId);

    for (const fixture of positives) {
      test(`${patternId} · ${fixture} → MUST match regex`, () => {
        const content = readFileSync(
          join(FIXTURES_ROOT, patternId, fixture),
          "utf-8",
        );
        const candidates = scanPatternAgainstContent(
          pattern,
          join(FIXTURES_ROOT, patternId, fixture),
          content,
          { bypassPathFilters: true },
        );
        if (candidates.length === 0) {
          throw new Error(
            `Positive fixture ${patternId}/${fixture} did not match the pattern regex. ` +
              `Either the fixture needs to be updated to actually contain the bug, ` +
              `or the regex has regressed.`,
          );
        }
        // All candidates must be for THIS pattern id (can't leak into others)
        for (const c of candidates) {
          expect(c.pattern_id).toBe(patternId);
        }
      });
    }

    for (const fixture of negatives) {
      test(`${patternId} · ${fixture} → MUST NOT match regex`, () => {
        const content = readFileSync(
          join(FIXTURES_ROOT, patternId, fixture),
          "utf-8",
        );
        const candidates = scanPatternAgainstContent(
          pattern,
          join(FIXTURES_ROOT, patternId, fixture),
          content,
          { bypassPathFilters: true },
        );
        if (candidates.length > 0) {
          const snippets = candidates
            .map((c) => `  line ${c.line}: ${c.matched_text}`)
            .join("\n");
          throw new Error(
            `Negative fixture ${patternId}/${fixture} unexpectedly matched ${candidates.length} time(s):\n${snippets}\n` +
              `The regex has false-positive regressed, OR the fixture needs a safer construct.`,
          );
        }
      });
    }
  }
});
