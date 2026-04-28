#!/usr/bin/env python3
"""
KCode vs Semgrep vs CodeQL — head-to-head benchmark on the fixture corpus.

Each fixture directory tests/patterns/<id>/ has positive.* (vulnerable) and
negative.* (safe). For each tool:
  - True positive  (TP): tool flags positive.*
  - False negative (FN): tool misses positive.*
  - True negative  (TN): tool clean on negative.*
  - False positive (FP): tool flags negative.*

Then we compute precision = TP/(TP+FP) and recall = TP/(TP+FN) per tool, and
print a side-by-side table.

Tools:
  - KCode  (local CLI)              --tools kcode
  - Semgrep OSS (docker, free)      --tools semgrep
  - CodeQL (local CLI, free)        --tools codeql

Default: all three.

Note on CodeQL: it is taint-flow based, so synthetic fixtures without an
explicit taint source (e.g., bare `eval(arg)` with no `request.args` /
`input()` upstream) won't fire CodeQL queries even when KCode/Semgrep do.
This is a feature of CodeQL's design, not a fairness gap in the harness.
Languages that need a CodeQL build step (Java, Go, C++) are skipped.

Usage:
  python3 scripts/bench-sast.py
  python3 scripts/bench-sast.py --pattern py
  python3 scripts/bench-sast.py --tools kcode,semgrep
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FIXTURES = REPO / "tests" / "patterns"
KCODE = Path.home() / ".local" / "bin" / "kcode"
CODEQL = Path.home() / ".codeql" / "codeql" / "codeql"

SEMGREP_CONFIGS = ["p/security-audit", "p/owasp-top-ten", "p/cwe-top-25"]

EXT_TO_CODEQL_LANG = {
    ".py": "python",
    ".js": "javascript",
    ".ts": "javascript",
    ".java": "java",
    ".go": "go",
    ".cpp": "cpp",
    ".rb": "ruby",
}

# CodeQL queries to run per language. Languages that need a build step
# (Java/Go/C++) are listed in CODEQL_NEEDS_BUILD; we skip those because
# our fixtures aren't buildable standalone projects.
CODEQL_SUITES = {
    "python": "python-security-and-quality.qls",
    "javascript": "javascript-security-and-quality.qls",
    "ruby": "ruby-security-and-quality.qls",
}
CODEQL_NEEDS_BUILD = {"java", "go", "cpp"}


def run_kcode(fixture_dir: Path) -> dict[str, set[str]]:
    """Returns {file_basename: {pattern_ids}} for files KCode flagged."""
    json_path = fixture_dir / "AUDIT_REPORT.json"
    md_path = fixture_dir / "AUDIT_REPORT.md"
    json_path.unlink(missing_ok=True)
    md_path.unlink(missing_ok=True)

    subprocess.run(
        [str(KCODE), "audit", str(fixture_dir), "--skip-verify", "--json"],
        capture_output=True,
        text=True,
        timeout=60,
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
    config_args: list[str] = []
    for cfg in SEMGREP_CONFIGS:
        config_args += ["--config", cfg]

    proc = subprocess.run(
        [
            "docker", "run", "--rm", "-v", f"{fixture_dir}:/src",
            "returntocorp/semgrep", "semgrep", *config_args, "--json", "/src",
            "--quiet", "--metrics=off",
        ],
        capture_output=True,
        text=True,
        timeout=180,
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


def codeql_lang_for_fixture(fixture_dir: Path) -> str | None:
    """Detect the CodeQL language from positive.* extension. None if unsupported."""
    pos_files = list(fixture_dir.glob("positive.*"))
    if not pos_files:
        return None
    ext = pos_files[0].suffix
    return EXT_TO_CODEQL_LANG.get(ext)


def run_codeql(fixture_dir: Path) -> dict[str, set[str]] | None:
    """Returns {file_basename: {rule_ids}} for files CodeQL flagged.

    Returns None when the fixture is skipped (unsupported language or
    build-required language). The harness uses None to count as 'skipped'
    rather than 'tool ran but found nothing'.
    """
    lang = codeql_lang_for_fixture(fixture_dir)
    if lang is None:
        return None  # Unknown language → skip
    if lang in CODEQL_NEEDS_BUILD:
        return None  # Build-required language → skip
    if lang not in CODEQL_SUITES:
        return None  # No suite available → skip

    with tempfile.TemporaryDirectory(prefix="codeql-") as tmpdir:
        db = Path(tmpdir) / "db"
        sarif = Path(tmpdir) / "out.sarif"

        proc = subprocess.run(
            [
                str(CODEQL), "database", "create", str(db),
                f"--language={lang}", f"--source-root={fixture_dir}",
                "--overwrite",
            ],
            capture_output=True,
            text=True,
            timeout=300,
        )
        if proc.returncode != 0:
            return {}

        proc = subprocess.run(
            [
                str(CODEQL), "database", "analyze", str(db),
                "--format=sarif-latest", f"--output={sarif}",
                "--quiet", CODEQL_SUITES[lang],
            ],
            capture_output=True,
            text=True,
            timeout=300,
        )
        if not sarif.exists():
            return {}

        try:
            data = json.loads(sarif.read_text())
        except json.JSONDecodeError:
            return {}

        flagged: dict[str, set[str]] = {}
        for run in data.get("runs", []):
            for r in run.get("results", []):
                locs = r.get("locations", [])
                if not locs:
                    continue
                uri = (
                    locs[0]
                    .get("physicalLocation", {})
                    .get("artifactLocation", {})
                    .get("uri", "")
                )
                fname = Path(uri).name
                flagged.setdefault(fname, set()).add(r.get("ruleId", ""))
        return flagged


def evaluate_tool(fixtures: list[Path], tool_name: str, runner) -> dict:
    """Run `runner` against each fixture, return TP/FN/TN/FP counts."""
    tp = fn = tn = fp = skipped = 0
    per_fixture: list[tuple[str, str, str]] = []

    for f in fixtures:
        pos_files = list(f.glob("positive.*"))
        neg_files = list(f.glob("negative.*"))
        if not pos_files or not neg_files:
            continue
        pos_file = pos_files[0]
        neg_file = neg_files[0]

        flagged = runner(f)

        # None signals "skipped" (e.g., language CodeQL doesn't analyze
        # without a build). Empty dict means "ran but found nothing" —
        # that counts as FN/TN.
        if flagged is None:
            skipped += 1
            sys.stderr.write(
                f"  [{tool_name}] {f.name:40s}  SKIP (lang/build)\n"
            )
            continue

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
        sys.stderr.write(
            f"  [{tool_name}] {f.name:40s}  pos={pos_status}  neg={neg_status}\n"
        )

    return {
        "tp": tp,
        "fn": fn,
        "tn": tn,
        "fp": fp,
        "skipped": skipped,
        "per_fixture": per_fixture,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pattern", default="", help="Filter fixtures by name prefix")
    parser.add_argument(
        "--tools",
        default="kcode,semgrep,codeql",
        help="Comma-separated: kcode,semgrep,codeql",
    )
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

    if "codeql" in tools:
        if not CODEQL.exists():
            print(
                f"CodeQL not found at {CODEQL} — skipping.\n"
                f"Install from https://github.com/github/codeql-action/releases",
                file=sys.stderr,
            )
        else:
            print("=== CodeQL ===", file=sys.stderr)
            results["CodeQL"] = evaluate_tool(fixtures, "codeql", run_codeql)

    # Summary table
    print()
    print("=" * 80)
    print(
        f"{'Tool':14} {'TP':>5} {'FN':>5} {'TN':>5} {'FP':>5} {'Skip':>5}  "
        f"{'Recall':>8} {'Precision':>10} {'F1':>6}"
    )
    print("-" * 80)

    for name, r in results.items():
        denom_recall = r["tp"] + r["fn"]
        denom_prec = r["tp"] + r["fp"]
        recall = r["tp"] / denom_recall if denom_recall else 0
        precision = r["tp"] / denom_prec if denom_prec else 0
        f1 = (
            2 * recall * precision / (recall + precision)
            if (recall + precision)
            else 0
        )
        print(
            f"{name:14} {r['tp']:>5} {r['fn']:>5} {r['tn']:>5} {r['fp']:>5} "
            f"{r.get('skipped', 0):>5}  "
            f"{recall*100:>7.1f}% {precision*100:>9.1f}% {f1:>6.3f}"
        )

    print()
    print(f"Corpus: {len(fixtures)} fixtures (positive.* + negative.* per fixture)")
    print(f"Tools tested: {', '.join(results.keys())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
