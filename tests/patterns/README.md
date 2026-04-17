# Pattern fixture harness

Regression tests for the audit engine's pattern library
(`src/core/audit-engine/patterns.ts`). Each pattern that's covered
here has a dedicated directory named after its `id`, containing:

- `positive.<ext>` — code that **must** match the pattern's regex.
  If the regex loses precision (a refactor breaks a case), CI turns
  red instead of silently letting false negatives into production.
- `negative.<ext>` — code that **must not** match the pattern's
  regex. Pins false-positive fixes (e.g. the word-boundary guard
  in `js-001-eval` that lets `evaluated = x` through unscathed).

## Runner

`tests/pattern-fixtures.test.ts` walks this directory, loads each
pattern by id, and asserts the positive/negative invariants using
`scanPatternAgainstContent()` from `src/core/audit-engine/scanner.ts`.

This is Phase 3 of the enterprise-maturity refactor — the first
stage that makes the pattern library a **verifiable asset** rather
than a 4,380-line file that nobody double-checks when they edit it.

## Adding a new pattern

1. Create `tests/patterns/<pattern-id>/`.
2. Drop at least one positive and one negative fixture with the
   right extension for the pattern's language (`.c`, `.py`, `.js`,
   `.ts`, etc.) so `getLanguageForFile()` resolves correctly.
3. Run `bun test tests/pattern-fixtures.test.ts` — both assertions
   should pass.

## Coverage status

Initial coverage: 7 patterns (out of 257 in the library). Expand
incrementally — one extra fixture per PR is better than a 250-file
batch once.

- `cpp-001-ptr-address-index`
- `py-001-eval-exec`
- `py-002-shell-injection`
- `py-003-pickle-deserialize`
- `js-001-eval`
- `js-002-innerhtml`
- `js-008-prototype-pollution-bracket`

## Out of scope (for now)

The LLM verifier stage (`verify_prompt` confirmation) is **not**
exercised here — that's Phase 3b. These fixtures test the regex
stage only: syntactic matching, no semantic judgment.
