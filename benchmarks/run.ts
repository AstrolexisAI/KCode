#!/usr/bin/env bun
// KCode - Benchmark Runner
// Usage: bun run benchmarks/run.ts --model <model> --api-base <url> [--api-key <key>] [--task <id>]

import { BENCHMARK_TASKS } from "./tasks";
import { runBenchmark, formatBenchmarkReport, type BenchmarkConfig, type BenchmarkResult } from "./suite";

// ─── Parse CLI Args ────────────────────────────────────────────

function parseArgs(): BenchmarkConfig & { taskId?: string } {
  const args = process.argv.slice(2);
  let model = "";
  let apiBase = "";
  let apiKey: string | undefined;
  let taskId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--model":
        model = args[++i] ?? "";
        break;
      case "--api-base":
        apiBase = args[++i] ?? "";
        break;
      case "--api-key":
        apiKey = args[++i];
        break;
      case "--task":
        taskId = args[++i];
        break;
      case "--help":
        printUsage();
        process.exit(0);
    }
  }

  if (!model) {
    console.error("Error: --model is required");
    printUsage();
    process.exit(1);
  }

  if (!apiBase) {
    apiBase = process.env.KCODE_API_BASE ?? "http://localhost:10091";
  }

  if (!apiKey) {
    apiKey = process.env.KCODE_API_KEY;
  }

  return { model, apiBase, apiKey, taskId };
}

function printUsage(): void {
  console.log(`
KCode Benchmark Suite

Usage:
  bun run benchmarks/run.ts --model <model> --api-base <url> [options]

Options:
  --model <name>      Model name (required)
  --api-base <url>    API base URL (default: KCODE_API_BASE or http://localhost:10091)
  --api-key <key>     API key (default: KCODE_API_KEY env var)
  --task <id>         Run a specific task by ID
  --help              Show this help

Available tasks:
${BENCHMARK_TASKS.map((t) => `  ${t.id.padEnd(25)} ${t.name} [${t.category}]`).join("\n")}
`);
}

// ─── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { model, apiBase, apiKey, taskId } = parseArgs();
  const config: BenchmarkConfig = { model, apiBase, apiKey };

  const tasks = taskId
    ? BENCHMARK_TASKS.filter((t) => t.id === taskId)
    : BENCHMARK_TASKS;

  if (tasks.length === 0) {
    console.error(`No task found with id: ${taskId}`);
    console.error(`Available: ${BENCHMARK_TASKS.map((t) => t.id).join(", ")}`);
    process.exit(1);
  }

  console.log(`\n  KCode Benchmark Suite`);
  console.log(`  Model: ${model}`);
  console.log(`  API:   ${apiBase}`);
  console.log(`  Tasks: ${tasks.length}`);
  console.log(`  ${"=".repeat(50)}\n`);

  const results: BenchmarkResult[] = [];

  for (const task of tasks) {
    process.stdout.write(`  Running: ${task.name}...`);
    const result = await runBenchmark(task, config);
    results.push(result);

    const status = result.passed ? "PASS" : "FAIL";
    console.log(` ${status} (${result.timeMs}ms)`);

    if (result.error) {
      console.log(`    Error: ${result.error.slice(0, 120)}`);
    }
  }

  console.log("\n");
  console.log(formatBenchmarkReport(results));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
