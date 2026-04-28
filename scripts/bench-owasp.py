#!/usr/bin/env python3
"""
KCode vs Semgrep OSS vs Semgrep Pro vs CodeQL on OWASP Benchmark v1.2.

OWASP Benchmark v1.2 is a publicly-curated corpus of 2,740 Java test
cases — 1,415 vulnerable, 1,325 safe — across 11 vulnerability categories.
Ground truth is in `expectedresults-1.2.csv`. Each test case is an
HttpServlet that compiles to a real Java class file, so all four tools
can analyze it without language-specific friction.

The corpus is at: https://github.com/OWASP-Benchmark/BenchmarkJava

Methodology:
  - For each test case BenchmarkTestNNNNN.java:
      ground_truth = was_vulnerable per CSV
      tool_says    = did the tool emit any finding in this file?
  - TP if tool_says=true && ground_truth=true
  - FN if tool_says=false && ground_truth=true
  - FP if tool_says=true && ground_truth=false
  - TN if tool_says=false && ground_truth=false

We use COARSE matching: any finding in the file counts. This is the
simpler "did the tool flag the right files?" question. The fancier
per-CWE matching (does the finding's CWE match the test case's CWE?)
is mentioned but not implemented — coarse matching is what most
SAST-vs-SAST academic papers report.

Usage:
  export OWASP_DIR=/tmp/BenchmarkJava
  python3 scripts/bench-owasp.py
  python3 scripts/bench-owasp.py --tools kcode,semgrep
  python3 scripts/bench-owasp.py --category sqli       # filter to one cat
"""

import argparse
import csv
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
KCODE = Path.home() / ".local" / "bin" / "kcode"
CODEQL = Path.home() / ".codeql" / "codeql" / "codeql"

OWASP_DIR_DEFAULT = "/tmp/BenchmarkJava"
SEMGREP_CONFIGS = ["p/security-audit", "p/owasp-top-ten", "p/cwe-top-25", "p/java"]


def parse_ground_truth(owasp_dir: Path) -> dict[str, dict]:
    """Parse expectedresults-1.2.csv → {testname: {category, vulnerable, cwe}}"""
    csv_path = owasp_dir / "expectedresults-1.2.csv"
    truth: dict[str, dict] = {}
    with csv_path.open() as f:
        reader = csv.reader(f)
        next(reader)  # skip header
        for row in reader:
            if len(row) < 4:
                continue
            name, category, vuln, cwe = row[0], row[1], row[2], row[3]
            truth[name] = {
                "category": category.strip(),
                "vulnerable": vuln.strip().lower() == "true",
                "cwe": cwe.strip(),
            }
    return truth


def testcase_from_path(path: str) -> str | None:
    """Extract BenchmarkTestNNNNN from a file path."""
    m = re.search(r"BenchmarkTest\d+", path)
    return m.group(0) if m else None


# ─── KCode ───────────────────────────────────────────────────────

def run_kcode(owasp_dir: Path) -> set[str]:
    """Run kcode audit on the source dir, return set of test names with findings."""
    src = owasp_dir / "src" / "main" / "java" / "org" / "owasp" / "benchmark" / "testcode"
    # KCode writes AUDIT_REPORT.json into the target directory, not the
    # invoking dir.
    json_path = src / "AUDIT_REPORT.json"
    md_path = src / "AUDIT_REPORT.md"
    json_path.unlink(missing_ok=True)
    md_path.unlink(missing_ok=True)

    print("  KCode: scanning…", file=sys.stderr)
    subprocess.run(
        [str(KCODE), "audit", str(src), "--skip-verify", "--json"],
        capture_output=True, text=True, timeout=600,
    )
    if not json_path.exists():
        return set()

    data = json.loads(json_path.read_text())
    flagged: set[str] = set()
    for f in data.get("findings", []):
        tc = testcase_from_path(f.get("file", ""))
        if tc:
            flagged.add(tc)

    json_path.unlink(missing_ok=True)
    md_path.unlink(missing_ok=True)
    return flagged


# ─── Semgrep ───────────────────────────────────────────────────────

def run_semgrep(owasp_dir: Path, pro: bool = False) -> set[str]:
    """Run semgrep against the testcode dir, return set of test names with findings."""
    src = owasp_dir / "src" / "main" / "java" / "org" / "owasp" / "benchmark" / "testcode"
    if not src.exists():
        return set()

    config_args = []
    for cfg in SEMGREP_CONFIGS:
        config_args += ["--config", cfg]

    cmd = [
        "docker", "run", "--rm",
        "-v", f"{src}:/src",
    ]
    semgrep_args = ["semgrep"]
    if pro:
        # Pro mode requires git tracking + auth token
        token = _read_semgrep_token()
        if not token:
            print("  Semgrep Pro: SEMGREP_APP_TOKEN missing — skipping", file=sys.stderr)
            return set()
        cmd += ["-e", f"SEMGREP_APP_TOKEN={token}", "-w", "/src"]
        semgrep_args += ["scan", "--pro"]
        # Need git init in src — copy to tmp and init
        with tempfile.TemporaryDirectory(prefix="owasp-semgrep-pro-") as tmpdir:
            print("  Semgrep Pro: copying corpus + git init…", file=sys.stderr)
            tmp_src = Path(tmpdir) / "src"
            shutil.copytree(src, tmp_src)
            subprocess.run(["git", "init", "-q"], cwd=tmp_src, check=True, timeout=30)
            subprocess.run(["git", "add", "."], cwd=tmp_src, check=True, timeout=120)
            subprocess.run(
                ["git", "-c", "user.email=bench@local", "-c", "user.name=bench",
                 "commit", "-q", "-m", "init"],
                cwd=tmp_src, check=True, timeout=60,
            )
            cmd_pro = [
                "docker", "run", "--rm",
                "-e", f"SEMGREP_APP_TOKEN={token}",
                "-v", f"{tmp_src}:/src", "-w", "/src",
                "returntocorp/semgrep", "semgrep", "scan", "--pro",
                *config_args, "--json", "--quiet", "--metrics=off", ".",
            ]
            print("  Semgrep Pro: scanning…", file=sys.stderr)
            proc = subprocess.run(cmd_pro, capture_output=True, text=True, timeout=3600)
    else:
        semgrep_args += [*config_args, "--json", "/src", "--quiet", "--metrics=off"]
        cmd += ["returntocorp/semgrep"] + semgrep_args
        print("  Semgrep OSS: scanning…", file=sys.stderr)
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)

    if proc.returncode != 0 and not proc.stdout.strip().startswith("{"):
        print(f"  Semgrep error: {proc.stderr[:200]}", file=sys.stderr)
        return set()

    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return set()

    flagged: set[str] = set()
    for r in data.get("results", []):
        tc = testcase_from_path(r.get("path", ""))
        if tc:
            flagged.add(tc)
    return flagged


def _read_semgrep_token() -> str | None:
    env_token = os.environ.get("SEMGREP_APP_TOKEN")
    if env_token:
        return env_token
    settings = Path.home() / ".semgrep" / "settings.yml"
    if not settings.exists():
        return None
    for line in settings.read_text().splitlines():
        if line.startswith("api_token:"):
            return line.split(":", 1)[1].strip()
    return None


# ─── CodeQL ───────────────────────────────────────────────────────

def run_codeql(owasp_dir: Path) -> set[str]:
    """Build a Java DB and run security-and-quality.qls. Returns flagged testcases.

    The OWASP Benchmark project is a Maven project; we let CodeQL invoke
    `mvn compile` via its autobuilder. This is slow on first run (~10 min)
    but enables CodeQL's full Java taint analysis.
    """
    with tempfile.TemporaryDirectory(prefix="owasp-codeql-") as tmpdir:
        db = Path(tmpdir) / "db"
        sarif = Path(tmpdir) / "out.sarif"

        print("  CodeQL: creating database (mvn compile)…", file=sys.stderr)
        proc = subprocess.run(
            [
                str(CODEQL), "database", "create", str(db),
                "--language=java",
                f"--source-root={owasp_dir}",
                f"--working-dir={owasp_dir}",
                # Use a user-owned local repo so we don't collide with root-owned ~/.m2
                # left behind by docker-based builds.
                "--command=mvn -B -DskipTests -Dmaven.repo.local=/tmp/m2-curly clean compile",
                "--overwrite",
            ],
            capture_output=True, text=True, timeout=1800,
        )
        if proc.returncode != 0:
            print(f"  CodeQL DB error: {proc.stderr[:300]}", file=sys.stderr)
            return set()

        print("  CodeQL: analyzing (java-security-extended.qls)…", file=sys.stderr)
        proc = subprocess.run(
            [
                str(CODEQL), "database", "analyze", str(db),
                "--format=sarif-latest", f"--output={sarif}",
                "--quiet", "java-security-extended.qls",
            ],
            capture_output=True, text=True, timeout=1800,
        )
        if not sarif.exists():
            print(f"  CodeQL analyze error: {proc.stderr[:300]}", file=sys.stderr)
            return set()

        try:
            data = json.loads(sarif.read_text())
        except json.JSONDecodeError:
            return set()

        flagged: set[str] = set()
        for run in data.get("runs", []):
            for r in run.get("results", []):
                for loc in r.get("locations", []):
                    uri = (
                        loc.get("physicalLocation", {})
                        .get("artifactLocation", {})
                        .get("uri", "")
                    )
                    tc = testcase_from_path(uri)
                    if tc:
                        flagged.add(tc)
        return flagged


# ─── Evaluation ───────────────────────────────────────────────────

def evaluate(truth: dict[str, dict], flagged: set[str], filter_cat: str | None = None) -> dict:
    tp = fn = tn = fp = 0
    for name, info in truth.items():
        if filter_cat and info["category"] != filter_cat:
            continue
        gt = info["vulnerable"]
        flagged_now = name in flagged
        if gt and flagged_now:
            tp += 1
        elif gt and not flagged_now:
            fn += 1
        elif not gt and flagged_now:
            fp += 1
        else:
            tn += 1
    return {"tp": tp, "fn": fn, "tn": tn, "fp": fp}


def print_table(results: dict[str, dict], total_cases: int) -> None:
    print()
    print("=" * 80)
    print(f"{'Tool':18} {'TP':>5} {'FN':>5} {'TN':>5} {'FP':>5}  "
          f"{'Recall':>8} {'Precision':>10} {'F1':>6}")
    print("-" * 80)
    for name, r in results.items():
        denom_recall = r["tp"] + r["fn"]
        denom_prec = r["tp"] + r["fp"]
        recall = r["tp"] / denom_recall if denom_recall else 0
        precision = r["tp"] / denom_prec if denom_prec else 0
        f1 = 2 * recall * precision / (recall + precision) if (recall + precision) else 0
        print(f"{name:18} {r['tp']:>5} {r['fn']:>5} {r['tn']:>5} {r['fp']:>5}  "
              f"{recall*100:>7.1f}% {precision*100:>9.1f}% {f1:>6.3f}")
    print()
    print(f"Corpus: {total_cases} test cases (OWASP Benchmark v1.2)")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--owasp", default=os.environ.get("OWASP_DIR", OWASP_DIR_DEFAULT))
    parser.add_argument("--tools", default="kcode,semgrep,semgrep-pro,codeql")
    parser.add_argument("--category", default="", help="Filter to one OWASP category (e.g., sqli, xss)")
    args = parser.parse_args()

    owasp_dir = Path(args.owasp)
    if not (owasp_dir / "expectedresults-1.2.csv").exists():
        print(f"OWASP Benchmark not found at {owasp_dir}.\n"
              f"Clone: git clone --depth 1 https://github.com/OWASP-Benchmark/BenchmarkJava /tmp/BenchmarkJava",
              file=sys.stderr)
        return 1

    truth = parse_ground_truth(owasp_dir)
    filter_cat = args.category or None
    if filter_cat:
        truth_filtered = {k: v for k, v in truth.items() if v["category"] == filter_cat}
        print(f"Filter: category={filter_cat} → {len(truth_filtered)} test cases", file=sys.stderr)
    else:
        truth_filtered = truth

    tools = args.tools.split(",")
    results: dict[str, dict] = {}
    flagged_by_tool: dict[str, set[str]] = {}

    if "kcode" in tools:
        print("=== KCode ===", file=sys.stderr)
        flagged_by_tool["KCode"] = run_kcode(owasp_dir)
        results["KCode"] = evaluate(truth, flagged_by_tool["KCode"], filter_cat)

    if "semgrep" in tools:
        print("=== Semgrep OSS ===", file=sys.stderr)
        flagged_by_tool["Semgrep OSS"] = run_semgrep(owasp_dir, pro=False)
        results["Semgrep OSS"] = evaluate(truth, flagged_by_tool["Semgrep OSS"], filter_cat)

    if "semgrep-pro" in tools:
        print("=== Semgrep Pro ===", file=sys.stderr)
        flagged_by_tool["Semgrep Pro"] = run_semgrep(owasp_dir, pro=True)
        results["Semgrep Pro"] = evaluate(truth, flagged_by_tool["Semgrep Pro"], filter_cat)

    if "codeql" in tools:
        if not CODEQL.exists():
            print(f"CodeQL not at {CODEQL} — skipping", file=sys.stderr)
        else:
            print("=== CodeQL ===", file=sys.stderr)
            flagged_by_tool["CodeQL"] = run_codeql(owasp_dir)
            results["CodeQL"] = evaluate(truth, flagged_by_tool["CodeQL"], filter_cat)

    print_table(results, len(truth_filtered))
    return 0


if __name__ == "__main__":
    sys.exit(main())
