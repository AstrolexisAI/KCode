// KCode - Model benchmark result store
//
// Persists benchmark results at ~/.kcode/benchmarks.json so the /model
// picker can mark tested models with a ✓ and new models with [NEW].
// Results don't expire — providers can re-run benchmarks on demand via
// `kcode benchmark <model>` or `/benchmark <model>`.

import { existsSync, readFileSync } from "node:fs";
import { kcodePath } from "./paths";
import { log } from "./logger";

export interface BenchmarkResult {
  /** Model name */
  model: string;
  /** When the benchmark was run (ISO 8601) */
  timestamp: string;
  /** Model version hash / etag when tested — if provider changes it, re-run */
  version?: string;
  /** Pass/fail per test */
  tests: Record<string, "pass" | "fail" | "error">;
  /** Aggregate score 0-4 */
  score: number;
  /** Tags confirmed by benchmarks (fast if T1 < 3s, reasoning if T3 pass, etc.) */
  confirmedTags: string[];
  /** Total tokens consumed by the benchmark run */
  totalTokens: number;
  /** Total elapsed ms */
  elapsedMs: number;
  /** Error message if the benchmark itself failed (not individual tests) */
  error?: string;
}

export interface BenchmarkStore {
  results: Record<string, BenchmarkResult>;
  /** Version of the test suite used — bump when adding/changing tests */
  suite_version: number;
}

const STORE_VERSION = 1;

function storePath(): string {
  return kcodePath("benchmarks.json");
}

export function loadBenchmarkStore(): BenchmarkStore {
  const path = storePath();
  if (!existsSync(path)) {
    return { results: {}, suite_version: STORE_VERSION };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (!raw || typeof raw !== "object") {
      return { results: {}, suite_version: STORE_VERSION };
    }
    return {
      results: raw.results && typeof raw.results === "object" ? raw.results : {},
      suite_version: typeof raw.suite_version === "number" ? raw.suite_version : 0,
    };
  } catch (err) {
    log.warn("benchmark", `Failed to load store: ${err}`);
    return { results: {}, suite_version: STORE_VERSION };
  }
}

export async function saveBenchmarkStore(store: BenchmarkStore): Promise<void> {
  try {
    await Bun.write(storePath(), JSON.stringify(store, null, 2));
  } catch (err) {
    log.warn("benchmark", `Failed to save store: ${err}`);
  }
}

export async function recordBenchmarkResult(result: BenchmarkResult): Promise<void> {
  const store = loadBenchmarkStore();
  store.results[result.model] = result;
  store.suite_version = STORE_VERSION;
  await saveBenchmarkStore(store);
}

export function isBenchmarked(modelName: string): boolean {
  const store = loadBenchmarkStore();
  const result = store.results[modelName];
  if (!result) return false;
  // Re-test if suite_version was bumped since last run
  if (store.suite_version < STORE_VERSION) return false;
  return true;
}

export function getBenchmarkResult(modelName: string): BenchmarkResult | null {
  const store = loadBenchmarkStore();
  return store.results[modelName] ?? null;
}

export const BENCHMARK_SUITE_VERSION = STORE_VERSION;
