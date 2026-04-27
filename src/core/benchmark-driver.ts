// KCode - Benchmark driver
//
// Orchestrates benchmarking across multiple models:
//   - runBenchmarksForNewModels(): finds un-benchmarked cloud models with
//     valid API keys and runs the suite on each (sequential + throttled
//     to avoid rate limits).
//   - runBenchmarkForModel(): benchmark a specific model by name.
//   - Auto-discovery hook: kicks off a background benchmark run after
//     listModels registers new entries.

import { benchmarkModel, minimalReadTool } from "./benchmark-runner";
import { isBenchmarked } from "./benchmark-store";
import { log } from "./logger";
import { listModels } from "./models";

const LOCAL_PATTERNS = /localhost|127\.0\.0\.1/;
// Throttle between benchmark calls (same provider often rate-limits)
const INTER_MODEL_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function providerFromBaseUrl(baseUrl: string): "openai" | "anthropic" {
  return baseUrl.toLowerCase().includes("anthropic.com") ? "anthropic" : "openai";
}

async function resolveApiKeyForModel(baseUrl: string): Promise<string> {
  const { loadUserSettingsRaw } = await import("./config.js");
  const settings = await loadUserSettingsRaw();
  const url = baseUrl.toLowerCase();
  if (url.includes("anthropic.com"))
    return String(settings.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? "");
  if (url.includes("x.ai")) return String(settings.xaiApiKey ?? process.env.XAI_API_KEY ?? "");
  if (url.includes("openai.com"))
    return String(settings.apiKey ?? process.env.OPENAI_API_KEY ?? "");
  if (url.includes("moonshot"))
    return String(settings.kimiApiKey ?? process.env.MOONSHOT_API_KEY ?? "");
  if (url.includes("groq.com"))
    return String(settings.groqApiKey ?? process.env.GROQ_API_KEY ?? "");
  if (url.includes("deepseek.com"))
    return String(settings.deepseekApiKey ?? process.env.DEEPSEEK_API_KEY ?? "");
  if (url.includes("together.xyz"))
    return String(settings.togetherApiKey ?? process.env.TOGETHER_API_KEY ?? "");
  if (url.includes("google") || url.includes("generativelanguage"))
    return String(settings.geminiApiKey ?? process.env.GEMINI_API_KEY ?? "");
  return "";
}

export interface BenchmarkBatchProgress {
  model: string;
  done: number;
  total: number;
  score?: number;
  error?: string;
}

/** Skip models that are obviously not chat-capable (image / audio / TTS / embeddings). */
const NON_CHAT_PATTERNS = [
  /^dall-e/i,
  /^whisper/i,
  /^tts-/i,
  /^text-embedding/i,
  /-vision-/i,
  /^gpt-4o-realtime/i,
  /^gpt-4o-audio/i,
  /^gpt-4o-mini-realtime/i,
  /^gpt-4o-mini-audio/i,
  /^gpt-4o-tts/i,
  /^gpt-4o-transcribe/i,
  /^omni-moderation/i,
  /-codex$/i,
  /-search-api/i,
  /^o1-pro/i,
  /^gpt-image/i,
  /^chatgpt-image/i,
  /^sora/i,
  /^babbage/i,
  /^davinci/i,
];

function shouldSkipModel(modelName: string): boolean {
  return NON_CHAT_PATTERNS.some((p) => p.test(modelName));
}

/**
 * Run the benchmark suite on every un-benchmarked cloud model that has a
 * valid API key. Yields progress for each model completed.
 */
export async function* runBenchmarksForNewModels(
  options: { force?: boolean; only?: string[] } = {},
): AsyncGenerator<BenchmarkBatchProgress, void> {
  const models = await listModels();
  const candidates = models.filter((m) => {
    if (LOCAL_PATTERNS.test(m.baseUrl)) return false; // Skip local
    if (shouldSkipModel(m.name)) return false;
    if (options.only && !options.only.includes(m.name)) return false;
    if (!options.force && isBenchmarked(m.name)) return false;
    return true;
  });

  const total = candidates.length;
  let done = 0;
  log.info("benchmark/batch", `Starting benchmark for ${total} model(s)`);

  for (const m of candidates) {
    const apiKey = await resolveApiKeyForModel(m.baseUrl);
    if (!apiKey) {
      log.debug("benchmark/batch", `Skipping ${m.name} — no API key`);
      done++;
      yield { model: m.name, done, total, error: "no API key" };
      continue;
    }

    const provider = providerFromBaseUrl(m.baseUrl);
    const tools = [minimalReadTool(provider)];
    try {
      const result = await benchmarkModel(m.name, m.baseUrl, apiKey, tools);
      done++;
      yield { model: m.name, done, total, score: result.score };
    } catch (err) {
      done++;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("benchmark/batch", `${m.name} failed: ${msg}`);
      yield { model: m.name, done, total, error: msg };
    }

    await sleep(INTER_MODEL_DELAY_MS);
  }

  log.info("benchmark/batch", `Benchmark batch complete: ${done}/${total}`);
}

/** Benchmark a single model by name. */
export async function runBenchmarkForModel(modelName: string): Promise<BenchmarkBatchProgress> {
  const models = await listModels();
  const model = models.find((m) => m.name === modelName);
  if (!model) return { model: modelName, done: 0, total: 0, error: "model not found" };
  if (LOCAL_PATTERNS.test(model.baseUrl)) {
    return { model: modelName, done: 0, total: 0, error: "local models not benchmarked" };
  }
  const apiKey = await resolveApiKeyForModel(model.baseUrl);
  if (!apiKey) return { model: modelName, done: 0, total: 0, error: "no API key" };

  const provider = providerFromBaseUrl(model.baseUrl);
  const tools = [minimalReadTool(provider)];
  try {
    const result = await benchmarkModel(model.name, model.baseUrl, apiKey, tools);
    return { model: modelName, done: 1, total: 1, score: result.score };
  } catch (err) {
    return {
      model: modelName,
      done: 0,
      total: 1,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fire a non-blocking background benchmark for un-tested models.
 * Called after model-discovery registers new models. Safe to call on
 * every startup — already-benchmarked models are skipped automatically.
 */
export function scheduleBackgroundBenchmark(): void {
  // Don't block — run in background
  (async () => {
    try {
      const gen = runBenchmarksForNewModels();
      for await (const _progress of gen) {
        // Drain silently — progress is logged by the runner
      }
    } catch (err) {
      log.debug("benchmark/bg", `Background benchmark failed: ${err}`);
    }
  })();
}
