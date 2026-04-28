#!/usr/bin/env python3
"""
Diagnose which KCode patterns produce the most false positives on OWASP
Benchmark Java. Used to prioritize which patterns get sanitizer-aware
fixes first.

Reads:
  - /tmp/BenchmarkJava/src/main/java/.../testcode/AUDIT_REPORT.json
    (run kcode audit there first)
  - /tmp/BenchmarkJava/expectedresults-1.2.csv (ground truth)

Outputs ranked patterns: pattern_id | FPs | TPs | FP-rate.
"""

import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

OWASP_DIR = Path("/tmp/BenchmarkJava")
JSON_PATH = OWASP_DIR / "src/main/java/org/owasp/benchmark/testcode/AUDIT_REPORT.json"


def main():
    if not JSON_PATH.exists():
        print(f"Run KCode first: kcode audit {JSON_PATH.parent} --skip-verify --json")
        return 1

    # Ground truth: testname -> (category, is_vulnerable, cwe)
    truth = {}
    with (OWASP_DIR / "expectedresults-1.2.csv").open() as f:
        reader = csv.reader(f)
        next(reader)
        for row in reader:
            if len(row) >= 4:
                truth[row[0]] = (row[1], row[2].strip().lower() == "true", row[3])

    # Per-pattern stats
    pattern_stats: dict[str, dict[str, int]] = defaultdict(
        lambda: {"tp_findings": 0, "fp_findings": 0, "tp_files": set(), "fp_files": set()}
    )

    data = json.loads(JSON_PATH.read_text())
    findings = data.get("findings", [])

    for f in findings:
        pid = f.get("pattern_id", "")
        path = f.get("file", "")
        m = re.search(r"BenchmarkTest\d+", path)
        if not m:
            continue
        tc = m.group(0)
        info = truth.get(tc)
        if not info:
            continue

        category, vulnerable, cwe = info
        if vulnerable:
            pattern_stats[pid]["tp_findings"] += 1
            pattern_stats[pid]["tp_files"].add(tc)
        else:
            pattern_stats[pid]["fp_findings"] += 1
            pattern_stats[pid]["fp_files"].add(tc)

    # Convert sets → counts and sort by FP volume
    rows = []
    for pid, stats in pattern_stats.items():
        rows.append({
            "pattern": pid,
            "tp_files": len(stats["tp_files"]),
            "fp_files": len(stats["fp_files"]),
            "tp_findings": stats["tp_findings"],
            "fp_findings": stats["fp_findings"],
        })
    rows.sort(key=lambda r: r["fp_files"], reverse=True)

    # Print
    total_fp_files = sum(r["fp_files"] for r in rows)
    print(f"Total findings:    {len(findings)}")
    print(f"Distinct patterns: {len(rows)}")
    print(f"Total FP-files:    {total_fp_files} (sum across patterns; same file can be flagged by N patterns)")
    print()
    print(f"{'Pattern':45} {'TPfiles':>8} {'FPfiles':>8} {'FPrate':>7} {'Categories'}")
    print("-" * 100)

    for r in rows[:25]:
        if r["fp_files"] == 0 and r["tp_files"] == 0:
            continue
        denom = r["tp_files"] + r["fp_files"]
        fp_rate = r["fp_files"] / denom if denom else 0
        # What categories does this pattern fire on?
        cats = set()
        for tc in (truth.get(t, ("?",))[0] for t in []):  # placeholder
            cats.add(tc)
        # Better: rebuild category set from truth where this pattern fired
        cats = set()
        for finding in findings:
            if finding.get("pattern_id") != r["pattern"]:
                continue
            tc_match = re.search(r"BenchmarkTest\d+", finding.get("file", ""))
            if tc_match:
                info = truth.get(tc_match.group(0))
                if info:
                    cats.add(info[0])

        print(f"{r['pattern']:45} {r['tp_files']:>8} {r['fp_files']:>8} {fp_rate*100:>6.1f}% {','.join(sorted(cats))}")

    print()
    print("=== Top 5 patterns to fix (highest FP volume) ===")
    for r in rows[:5]:
        if r["fp_files"] > 50:
            print(f"  {r['pattern']:40s}  {r['fp_files']} FPs across files")

    return 0


if __name__ == "__main__":
    sys.exit(main())
