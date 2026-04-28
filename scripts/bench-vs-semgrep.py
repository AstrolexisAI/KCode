#!/usr/bin/env python3
"""
KCode vs Semgrep — head-to-head benchmark on the fixture corpus.

Each fixture directory tests/patterns/<id>/ has positive.py (vulnerable) and
negative.py (safe). For each tool:
  - True positive  (TP): tool flags positive.py
  - False negative (FN): tool misses positive.py
  - True negative  (TN): tool clean on negative.py
  - False positive (FP): tool flags negative.py

Then we compute precision = TP/(TP+FP) and recall = TP/(TP+FN) per tool, and
print a side-by-side table.

Usage:
  python3 scripts/bench-vs-semgrep.py
  python3 scripts/bench-vs-semgrep.py --pattern py        # filter to py-* fixtures
  python3 scripts/bench-vs-semgrep.py --tools kcode       # KCode only (skip Semgrep)
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FIXTURES = REPO / "tests" / "patterns"
KCODE = Path.home() / ".local" / "bin" / "kcode"

# Map fixture-name suffix → Semgrep ruleset to use.
# Multiple rulesets get merged for stronger comparison.
SEMGREP_CONFIGS = ["p/security-audit", "p/owasp-top-ten", "p/cwe-top-25"]


def run_kcode(fixture_dir: Path) -> dict[str, set[str]]:
    """Returns {file_basename: {pattern_ids}} for files KCode flagged."""
    json_path = fixture_dir / "AUDIT_REPORT.json"
    md_path = fixture_dir / "AUDIT_REPORT.md"
    json_path.unlink(missing_ok=True)
    md_path.unlink(missing_ok=True)

    proc = subprocess.run(
        [str(KCODE), "audit", str(fixture_dir), "--skip-verify", "--json"],
        capture_output=True, text=True, timeout=60,
    )
    if not json_path.exists():
        return {}

    data = json.loads(json_path.read_text())
    flagged: dict[str, set[str]] = {}
    for f in data.get("findings", []):
        fname = Path(f["file"]).name
        flagged.setdefault(fname, set()).add(f.get("pattern_id", ""))

    json_path.unlink(missing_ok=True)
    md_path.unlink(missing_ok=True)
    return flagged


def run_semgrep(fixture_dir: Path) -> dict[str, set[str]]:
    """Returns {file_basename: {rule_ids}} for files Semgrep flagged."""
    config_args = []
    for cfg in SEMGREP_CONFIGS:
        config_args += ["--config", cfg]

    proc = subprocess.run(
        ["docker", "run", "--rm", "-v", f"{fixture_dir}:/src",
         "returntocorp/semgrep", "semgrep", *config_args, "--json", "/src",
         "--quiet", "--metrics=off"],
        capture_output=True, text=True, timeout=120,
    )
    if proc.returncode != 0 and not proc.stdout.strip().startswith("{"):
        return {}

    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {}

    flagged: dict[str, set[str]] = {}
    for r in data.get("results", []):
        fname = Path(r["path"]).name
        flagged.setdefault(fname, set()).add(r.get("check_id", ""))
    return flagged


def evaluate_tool(fixtures: list[Path], tool_name: str, runner) -> dict[str, int]:
    """Run `runner` against each fixture, return TP/FN/TN/FP counts."""
    tp = fn = tn = fp = 0
    per_fixture: list[tuple[str, str, str]] = []  # (id, pos_result, neg_result)

    for f in fixtures:
        pos_file = f / "positive.py"
        neg_file = f / "negative.py"
        # Try language alternatives
        if not pos_file.exists():
            for ext in (".js", ".ts", ".java", ".go", ".cpp", ".rb", ".php"):
                candidate = f / f"positive{ext}"
                if candidate.exists():
                    pos_file = candidate
                    neg_file = f / f"negative{ext}"
                    break
        if not pos_file.exists():
            continue

        flagged = runner(f)
        pos_flagged = pos_file.name in flagged
        neg_flagged = neg_file.name in flagged

        if pos_flagged:
            tp += 1
            pos_status = "TP"
        else:
            fn += 1
            pos_status = "FN"

        if neg_flagged:
            fp += 1
            neg_status = "FP"
        else:
            tn += 1
            neg_status = "TN"

        per_fixture.append((f.name, pos_status, neg_status))
        sys.stderr.write(f"  [{tool_name}] {f.name:40s}  pos={pos_status}  neg={neg_status}\n")

    return {"tp": tp, "fn": fn, "tn": tn, "fp": fp, "per_fixture": per_fixture}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pattern", default="", help="Filter fixtures by name prefix")
    parser.add_argument("--tools", default="kcode,semgrep", help="Comma-separated: kcode,semgrep")
    args = parser.parse_args()

    fixtures = sorted(p for p in FIXTURES.iterdir() if p.is_dir())
    if args.pattern:
        fixtures = [f for f in fixtures if f.name.startswith(args.pattern)]

    print(f"Corpus: {len(fixtures)} fixture pairs")
    print()

    tools = args.tools.split(",")
    results: dict[str, dict] = {}

    if "kcode" in tools:
        print("=== KCode ===", file=sys.stderr)
        results["KCode"] = evaluate_tool(fixtures, "kcode", run_kcode)

    if "semgrep" in tools:
        print("=== Semgrep ===", file=sys.stderr)
        results["Semgrep"] = evaluate_tool(fixtures, "semgrep", run_semgrep)

    # Summary table
    print()
    print("=" * 70)
    print(f"{'Tool':12} {'TP':>5} {'FN':>5} {'TN':>5} {'FP':>5}  {'Recall':>8} {'Precision':>10} {'F1':>6}")
    print("-" * 70)

    for name, r in results.items():
        recall = r["tp"] / (r["tp"] + r["fn"]) if (r["tp"] + r["fn"]) else 0
        precision = r["tp"] / (r["tp"] + r["fp"]) if (r["tp"] + r["fp"]) else 0
        f1 = 2 * recall * precision / (recall + precision) if (recall + precision) else 0
        print(f"{name:12} {r['tp']:>5} {r['fn']:>5} {r['tn']:>5} {r['fp']:>5}  "
              f"{recall*100:>7.1f}% {precision*100:>9.1f}% {f1:>6.3f}")

    print()
    print(f"Corpus: {len(fixtures)} fixtures (positive.* + negative.* per fixture)")
    print(f"Tools tested: {', '.join(results.keys())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
