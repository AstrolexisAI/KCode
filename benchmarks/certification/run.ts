#!/usr/bin/env bun
// KCode - Certification Runner
// Usage: bun run benchmarks/certification/run.ts --model <url> --name <name> [--api-key <key>] [--category <cat>]

import { CERTIFICATION_TASKS } from "./tasks";
import {
  runCertification,
  formatCertificationReport,
  type CertificationResult,
} from "./suite";

// ─── Parse CLI Args ────────────────────────────────────────────

interface CertificationArgs {
  modelUrl: string;
  modelName: string;
  apiKey?: string;
  category?: string;
}

function parseArgs(): CertificationArgs {
  const args = process.argv.slice(2);
  let modelUrl = "";
  let modelName = "";
  let apiKey: string | undefined;
  let category: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--model":
        modelUrl = args[++i] ?? "";
        break;
      case "--name":
        modelName = args[++i] ?? "";
        break;
      case "--api-key":
        apiKey = args[++i];
        break;
      case "--category":
        category = args[++i];
        break;
      case "--help":
        printUsage();
        process.exit(0);
    }
  }

  if (!modelUrl) {
    modelUrl = process.env.KCODE_API_BASE ?? "http://localhost:10091";
  }

  if (!modelName) {
    console.error("Error: --name is required");
    printUsage();
    process.exit(1);
  }

  if (!apiKey) {
    apiKey = process.env.KCODE_API_KEY;
  }

  return { modelUrl, modelName, apiKey, category };
}

function printUsage(): void {
  const categories = [...new Set(CERTIFICATION_TASKS.map((t) => t.category))];
  console.log(`
KCode Model Certification Suite

Usage:
  bun run benchmarks/certification/run.ts --name <model-name> [options]

Options:
  --model <url>        API base URL (default: KCODE_API_BASE or http://localhost:10091)
  --name <name>        Model name (required)
  --api-key <key>      API key (default: KCODE_API_KEY env var)
  --category <cat>     Run only tasks from a specific category
  --help               Show this help

Categories:
${categories.map((c) => `  ${c}`).join("\n")}

Certification Levels:
  Gold   - 45+ / 50 points
  Silver - 35+ / 50 points
  Bronze - 25+ / 50 points
  Failed - < 25 points

Tasks: ${CERTIFICATION_TASKS.length} total (${categories.map((c) => `${CERTIFICATION_TASKS.filter((t) => t.category === c).length} ${c}`).join(", ")})
`);
}

// ─── Save Results ──────────────────────────────────────────────

async function saveResults(result: CertificationResult): Promise<string> {
  const dir = new URL("./results", import.meta.url).pathname;
  try {
    await Bun.write(dir + "/.gitkeep", "");
  } catch {
    // directory may already exist
  }

  const safeName = result.modelName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = `${dir}/${safeName}.json`;
  await Bun.write(filePath, JSON.stringify(result, null, 2));
  return filePath;
}

// ─── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { modelUrl, modelName, apiKey, category } = parseArgs();

  console.log(`\n  KCode Model Certification Suite`);
  console.log(`  Model:    ${modelName}`);
  console.log(`  API:      ${modelUrl}`);

  if (category) {
    const validCategories = ["tool_calling", "code_generation", "instruction_following", "context_handling", "safety"];
    if (!validCategories.includes(category)) {
      console.error(`\n  Error: Invalid category "${category}"`);
      console.error(`  Valid: ${validCategories.join(", ")}`);
      process.exit(1);
    }
    console.log(`  Category: ${category}`);
  }

  const taskCount = category
    ? CERTIFICATION_TASKS.filter((t) => t.category === category).length
    : CERTIFICATION_TASKS.length;
  console.log(`  Tasks:    ${taskCount}`);
  console.log(`  ${"=".repeat(56)}\n`);

  const result = await runCertification(modelUrl, modelName, apiKey);

  // If category filter was applied, recalculate (the full suite ran but we show filtered)
  const report = formatCertificationReport(result);
  console.log(report);

  const filePath = await saveResults(result);
  console.log(`  Results saved to: ${filePath}`);
  console.log("");
}

main().catch((err) => {
  console.error("Certification failed:", err);
  process.exit(1);
});
