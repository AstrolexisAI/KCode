# KCode Audit Benchmark

Public, reproducible benchmark for KCode's audit pipeline. Measures
how the static analyzer performs against a curated set of fixtures
covering the common web/RCE vulnerability classes.

## Goals

- Honest precision/recall/F1 numbers we can publish and improve
  against — not marketing copy.
- Locked as a regression test (`audit-benchmark.test.ts`) so any
  pattern change that drops the metrics fails CI.
- Default mode is **deterministic** (`--skip-verify`): just regex +
  AST, no LLM. Same number every run, on every machine.

## Running

```bash
# Default — static-only, prints Markdown summary to stdout
bun run benchmarks/audit/run.ts

# Emit JSON summary alongside Markdown
bun run benchmarks/audit/run.ts --json

# Use the LLM verifier (needs a configured model endpoint)
bun run benchmarks/audit/run.ts --with-verifier
```

## Fixture layout

Each subdirectory under `vulnerable-apps/` is one fixture: source
file(s) plus a `meta.json` describing what the audit should produce.

```
vulnerable-apps/
  eval-js/
    server.js     # the source under audit
    meta.json     # expected findings
  shell-js/
    runner.js
    meta.json
  ...
```

`meta.json` shape:

```json
{
  "kind": "positive" | "negative" | "ambiguous",
  "cwe": "CWE-95",
  "description": "short prose description of the bug",
  "expected": [
    {
      "pattern_id": "js-001-eval",
      "file": "server.js",
      "line": 7,
      "verdict": "confirmed" | "any" | "needs_context"
    }
  ]
}
```

- **positive** — a real vulnerability is present; KCode should flag it.
- **negative** — no vulnerability; KCode should produce zero findings.
- **ambiguous** — depends on context the static pass can't resolve;
  any verdict counts (so recall isn't penalized for "needs more
  context" runs).

## How the metric is computed

Each finding is matched against `expected` by **(file basename, line)**,
not by `pattern_id`. KCode ships overlapping rules (e.g. `js-001-eval`
AND `des-003-eval-user-input` both flag the same eval), and the
benchmark measures *"did we catch the bug at line X?"*, not *"did we
use rule R?"*. Multiple findings at the same site collapse to one TP.

- **TP** — at least one finding lands on a coordinate the fixture marked confirmed.
- **FP** — a finding lands at a coordinate the fixture didn't list.
- **FN** — a `verdict: confirmed` expected entry has no finding at its coordinate.

Aggregate: precision = TP / (TP + FP), recall = TP / (TP + FN),
F1 = 2·P·R / (P + R).

## Current baseline (v2.10.364, static-only)

```
Precision : 100.0%  (7 TP / 7)
Recall    :  63.6%  (7 TP / 11)
F1        :  0.778
Mean scan :  ~9 ms / fixture
Fixtures  :  10 (6 positive, 3 negative, 1 ambiguous)
```

The 4 false negatives surface real product gaps:

1. **Per-file pattern dedupe (3 of 4)** — when a single fixture has
   two `innerHTML = …`, two `pickle.loads(…)`, or two `cursor.execute(…)`
   in the same file, the scanner currently collapses them into one
   finding. F4 (audit-pro mode with site-level findings) closes this.
2. **Pattern coverage hole (1 of 4)** — the `py-008-path-traversal`
   regex requires an f-string / concat / `.format(` in the `open(...)`
   argument. A bare-variable form like `open(filename)` is missed.

The locked thresholds in `audit-benchmark.test.ts`:

```
precision ≥ 0.95
recall    ≥ 0.55
f1        ≥ 0.70
```

are a few points below the baseline so micro-tunings don't fail CI,
but any structural drop will.

## Output

`run.ts` writes the Markdown table to stdout. With `--json`, a JSON
summary lands at `benchmarks/audit/results/run-<timestamp>.json`.

`results/baseline-v2.10.364.json` is the locked baseline kept under
version control so reviewers can see numeric drift on every PR.
