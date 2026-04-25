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

Current coverage: **51 patterns out of 311** in the library
(as of v2.10.330). This is the authoritative count — not a stale
target — and it lives next to the runner so the number can't drift
without someone editing this file.

Aspirational: 80+ within the next two sprints, prioritized at
high-CVE-volume verticals (crypto, injection, deserialization) and
the flight-software differential pack.

Expand incrementally — one extra fixture per PR is better than a
250-file batch once. Run `ls tests/patterns/ | wc -l` to confirm
this number after adding new ones.

### Verticals (security packs added in v2.10.314)

#### Crypto misuse
- `crypto-001-rand-for-key-material` (weak RNG for tokens)
- `crypto-003-md5-sha1-for-auth` (broken hashes for security)
- `crypto-007-tls-verify-off` (cert validation disabled)
- `crypto-009-ecb-mode` (AES-ECB, structural leak)

#### Injection
- `inj-001-sql-string-concat`
- `inj-002-subprocess-shell-true`
- `inj-005-path-traversal`

#### Deserialization
- `des-001-pickle-loads`
- `des-002-yaml-full-load`

#### Flight software (fprime / cFS framework-aware)
- `fsw-001-port-handler-no-check`
- `fsw-005-buffer-getdata-unchecked`
- `fsw-010-cmd-arg-before-validate`

### C / C++
- `cpp-001-ptr-address-index` (NASA IDF pointer bug)
- `cpp-006-strcpy-family` (unbounded string primitives)
- `cpp-008-memcpy-untrusted-len` (attacker-controlled length)
- `cpp-010-malloc-mul-overflow` (integer overflow in size calc)
- `cpp-011-signed-unsigned-cmp`

### Python
- `py-001-eval-exec`
- `py-002-shell-injection`
- `py-003-pickle-deserialize`
- `py-004-sql-injection`
- `py-005-yaml-unsafe-load`
- `py-008-path-traversal`
- `py-009-pickle-untrusted`
- `py-015-os-system-user-input`

### JavaScript / TypeScript
- `js-001-eval`
- `js-002-innerhtml`
- `js-003-prototype-pollution`
- `js-004-nosql-injection`
- `js-005-regex-dos`
- `js-007-command-injection`
- `js-008-prototype-pollution-bracket`
- `js-009-redos-nested-quantifier`

### Go
- `go-001-sql-injection`
- `go-002-unsafe-pointer`
- `go-003-command-injection`

### Java
- `java-001-sql-injection`
- `java-002-deserialization`
- `java-003-xxe`
- `java-004-path-traversal`
- `java-010-hardcoded-creds`

## Out of scope (for now)

The LLM verifier stage (`verify_prompt` confirmation) is **not**
exercised here — that's Phase 3b. These fixtures test the regex
stage only: syntactic matching, no semantic judgment.
