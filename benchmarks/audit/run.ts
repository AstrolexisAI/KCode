#!/usr/bin/env bun
// KCode - Audit Benchmark Runner (F8 of audit product plan).
//
// Iterates over benchmarks/audit/vulnerable-apps/*, runs `runAudit`
// on each fixture, compares findings to the fixture's `meta.json`,
// and emits precision/recall/F1/FP-rate/scan-time as both Markdown
// and JSON. Default mode is --skip-verify so the metric is
// deterministic and CI-runnable without a local model.
//
// Usage:
//   bun run benchmarks/audit/run.ts                # static-only (default)
//   bun run benchmarks/audit/run.ts --with-verifier # full pipeline (needs LLM endpoint)
//   bun run benchmarks/audit/run.ts --json         # emit JSON summary alongside MD
//
// Output:
//   stdout — Markdown summary table
//   benchmarks/audit/results/run-<timestamp>.json (when --json passed)

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runAudit } from "../../src/core/audit-engine/audit-engine";
import type { AuditResult } from "../../src/core/audit-engine/types";

const FIXTURES_ROOT = join(import.meta.dir, "vulnerable-apps");
const RESULTS_DIR = join(import.meta.dir, "results");

interface ExpectedFinding {
  pattern_id: string;
  file: string;
  line: number;
  /** "confirmed" | "false_positive" | "needs_context" | "any" */
  verdict: "confirmed" | "false_positive" | "needs_context" | "any";
}

interface FixtureMeta {
  kind: "positive" | "negative" | "ambiguous";
  cwe?: string;
  description: string;
  expected: ExpectedFinding[];
}

interface FixtureRun {
  name: string;
  meta: FixtureMeta;
  result: AuditResult;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  durationMs: number;
}

function loadFixtures(): Array<{ name: string; dir: string; meta: FixtureMeta }> {
  const out: Array<{ name: string; dir: string; meta: FixtureMeta }> = [];
  for (const name of readdirSync(FIXTURES_ROOT).sort()) {
    const dir = join(FIXTURES_ROOT, name);
    if (!statSync(dir).isDirectory()) continue;
    const metaPath = join(dir, "meta.json");
    if (!existsSync(metaPath)) {
      console.warn(`  skipping ${name} — no meta.json`);
      continue;
    }
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as FixtureMeta;
    out.push({ name, dir, meta });
  }
  return out;
}

/**
 * For each finding the audit produced, decide whether it matches one
 * of the fixture's expected entries. A match is by (file basename,
 * line) — we deliberately don't require pattern_id equality because
 * KCode ships overlapping rules (e.g. `js-001-eval` AND
 * `des-003-eval-user-input` both cover the same eval vulnerability
 * from different angles). The benchmark measures "did we catch the
 * bug at line X?", not "did we use rule R?".
 *
 * Multiple findings at the same (file, line) all count as one TP
 * (the first one). Additional findings on the same line are counted
 * as duplicates, not separate TPs or FPs — they're the same vuln.
 *
 * Findings at unrelated (file, line) coordinates count as FPs.
 * Negative-fixture findings (where expected is empty) are all FPs.
 */
function classifyFindings(
  result: AuditResult,
  expected: ExpectedFinding[],
): { tp: number; fp: number; fn: number } {
  const matchedExpected = new Set<number>();
  // Track which (file, line) tuples we've already credited as TP so
  // overlapping patterns at the same site collapse into one match.
  const creditedSites = new Set<string>();
  let tp = 0;
  let fp = 0;

  for (const f of result.findings) {
    const fileBase = f.file.split("/").pop() ?? f.file;
    const siteKey = `${fileBase}:${f.line}`;

    const expIdx = expected.findIndex(
      (e, i) => !matchedExpected.has(i) && e.file === fileBase && e.line === f.line,
    );

    if (expIdx !== -1) {
      // Hit expected coordinates. Credit one TP per unique site so
      // duplicate-rule overlap doesn't inflate the metric.
      if (!creditedSites.has(siteKey)) {
        tp += 1;
        creditedSites.add(siteKey);
      }
      matchedExpected.add(expIdx);
    } else if (!creditedSites.has(siteKey)) {
      // Off-coordinate finding — count once per (file, line).
      fp += 1;
      creditedSites.add(siteKey);
    }
  }

  // Expected items count as missed when their verdict was "confirmed"
  // (we promised a hit) and no finding landed at their coordinates.
  // "any" and "needs_context" expectations are coverage-not-required.
  const fn = expected.filter(
    (e, i) => !matchedExpected.has(i) && e.verdict === "confirmed",
  ).length;

  return { tp, fp, fn };
}

async function runFixture(
  fixture: { name: string; dir: string; meta: FixtureMeta },
  withVerifier: boolean,
): Promise<FixtureRun> {
  const start = Date.now();

  // Default LLM callback for static-only mode — produces a JSON
  // verdict so the verifier path stays type-correct even though we
  // skip via skipVerification: true.
  const staticLlm = async () =>
    JSON.stringify({
      verdict: "confirmed",
      reasoning: "static-only benchmark mode",
      evidence: { sink: "static-only bypass" },
    });

  const result = await runAudit({
    projectRoot: fixture.dir,
    llmCallback: staticLlm,
    skipVerification: !withVerifier,
  });

  const { tp, fp, fn } = classifyFindings(result, fixture.meta.expected);
  return {
    name: fixture.name,
    meta: fixture.meta,
    result,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    durationMs: Date.now() - start,
  };
}

function formatMetrics(runs: FixtureRun[]): {
  precision: number;
  recall: number;
  f1: number;
  totalTp: number;
  totalFp: number;
  totalFn: number;
  meanScanMs: number;
} {
  const totalTp = runs.reduce((a, r) => a + r.truePositives, 0);
  const totalFp = runs.reduce((a, r) => a + r.falsePositives, 0);
  const totalFn = runs.reduce((a, r) => a + r.falseNegatives, 0);
  const precision = totalTp + totalFp > 0 ? totalTp / (totalTp + totalFp) : 1;
  const recall = totalTp + totalFn > 0 ? totalTp / (totalTp + totalFn) : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const meanScanMs =
    runs.length > 0 ? Math.round(runs.reduce((a, r) => a + r.durationMs, 0) / runs.length) : 0;
  return { precision, recall, f1, totalTp, totalFp, totalFn, meanScanMs };
}

function emitMarkdown(runs: FixtureRun[], withVerifier: boolean): string {
  const m = formatMetrics(runs);
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push("# KCode Audit Benchmark");
  lines.push("");
  lines.push(`**Mode:** ${withVerifier ? "verifier (LLM)" : "static-only (regex + AST, deterministic)"}`);
  lines.push(`**Fixtures:** ${runs.length}`);
  lines.push(`**Date:** ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Aggregate metrics");
  lines.push("");
  lines.push(`- **Precision:** ${pct(m.precision)} (${m.totalTp} TP / ${m.totalTp + m.totalFp})`);
  lines.push(`- **Recall:** ${pct(m.recall)} (${m.totalTp} TP / ${m.totalTp + m.totalFn})`);
  lines.push(`- **F1:** ${m.f1.toFixed(3)}`);
  lines.push(`- **Mean scan time:** ${m.meanScanMs} ms / fixture`);
  lines.push("");
  lines.push("## Per-fixture results");
  lines.push("");
  lines.push("| Fixture | Kind | TP | FP | FN | Time (ms) |");
  lines.push("|---------|------|----|----|----|-----------|");
  for (const r of runs) {
    lines.push(
      `| ${r.name} | ${r.meta.kind} | ${r.truePositives} | ${r.falsePositives} | ${r.falseNegatives} | ${r.durationMs} |`,
    );
  }
  return lines.join("\n");
}

interface JsonSummary {
  schema_version: 1;
  mode: "static-only" | "verifier";
  date: string;
  metrics: {
    precision: number;
    recall: number;
    f1: number;
    true_positives: number;
    false_positives: number;
    false_negatives: number;
    mean_scan_ms: number;
  };
  fixtures: Array<{
    name: string;
    kind: string;
    true_positives: number;
    false_positives: number;
    false_negatives: number;
    duration_ms: number;
    findings_count: number;
  }>;
}

function emitJson(runs: FixtureRun[], withVerifier: boolean): JsonSummary {
  const m = formatMetrics(runs);
  return {
    schema_version: 1,
    mode: withVerifier ? "verifier" : "static-only",
    date: new Date().toISOString(),
    metrics: {
      precision: Number(m.precision.toFixed(4)),
      recall: Number(m.recall.toFixed(4)),
      f1: Number(m.f1.toFixed(4)),
      true_positives: m.totalTp,
      false_positives: m.totalFp,
      false_negatives: m.totalFn,
      mean_scan_ms: m.meanScanMs,
    },
    fixtures: runs.map((r) => ({
      name: r.name,
      kind: r.meta.kind,
      true_positives: r.truePositives,
      false_positives: r.falsePositives,
      false_negatives: r.falseNegatives,
      duration_ms: r.durationMs,
      findings_count: r.result.findings.length,
    })),
  };
}

export interface BenchmarkOpts {
  withVerifier?: boolean;
}

export interface BenchmarkOutput {
  markdown: string;
  json: JsonSummary;
}

export async function runBenchmark(opts: BenchmarkOpts = {}): Promise<BenchmarkOutput> {
  const fixtures = loadFixtures();
  const runs: FixtureRun[] = [];
  for (const f of fixtures) {
    runs.push(await runFixture(f, !!opts.withVerifier));
  }
  return {
    markdown: emitMarkdown(runs, !!opts.withVerifier),
    json: emitJson(runs, !!opts.withVerifier),
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const withVerifier = args.has("--with-verifier");
  const writeJson = args.has("--json");

  const out = await runBenchmark({ withVerifier });
  console.log(out.markdown);

  if (writeJson) {
    if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath = join(RESULTS_DIR, `run-${stamp}.json`);
    writeFileSync(jsonPath, JSON.stringify(out.json, null, 2));
    console.log(`\n[json written: ${jsonPath}]`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
}
