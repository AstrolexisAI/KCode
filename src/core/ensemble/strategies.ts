// KCode - Ensemble Strategies
// Implements all ensemble strategies: best-of-n, majority-vote, merge, verify, specialize.

import { classifyTask } from "../router";
import type { Message } from "../types";
import { llmMerge, mergeSections } from "./merger";
import type {
  CandidateResponse,
  EnsembleConfig,
  EnsembleResult,
  ModelExecutor,
  SpecializeConfig,
} from "./types";
import { heuristicSelect, judgeSelect, majorityVote } from "./voter";

// ─── Parallel Execution with Timeout ────────────────────────────

/**
 * Execute a model request with a timeout.
 * Returns a CandidateResponse or throws on timeout/error.
 */
async function executeWithTimeout(
  model: string,
  messages: Message[],
  timeoutMs: number,
  executor: ModelExecutor,
): Promise<CandidateResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await Promise.race([
      executor.execute(model, messages, 4096),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new Error(`Model ${model} timed out after ${timeoutMs}ms`));
        });
      }),
    ]);

    return {
      model,
      response: result.content,
      tokensUsed: result.tokensUsed,
      durationMs: result.durationMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute multiple models in parallel, respecting maxParallel concurrency.
 * Returns all settled results (both fulfilled and rejected).
 */
async function executeParallel(
  models: string[],
  messages: Message[],
  config: EnsembleConfig,
  executor: ModelExecutor,
): Promise<CandidateResponse[]> {
  const results: CandidateResponse[] = [];
  const chunks: string[][] = [];

  // Split models into chunks of maxParallel
  for (let i = 0; i < models.length; i += config.maxParallel) {
    chunks.push(models.slice(i, i + config.maxParallel));
  }

  for (const chunk of chunks) {
    const settled = await Promise.allSettled(
      chunk.map((model) => executeWithTimeout(model, messages, config.timeout, executor)),
    );

    for (const result of settled) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      }
    }
  }

  return results;
}

// ─── Strategy: Best-of-N ────────────────────────────────────────

/**
 * Generate N responses in parallel, select the best one.
 *
 * Flow:
 * 1. Send the same query to N models in parallel
 * 2. Collect all responses
 * 3. If judgeModel: ask it to choose the best
 * 4. If no judgeModel: use heuristics (length, coherence, valid tool calls)
 */
export async function bestOfN(
  query: Message[],
  config: EnsembleConfig,
  executor: ModelExecutor,
): Promise<EnsembleResult> {
  const candidates = await executeParallel(config.models, query, config, executor);

  if (candidates.length < config.minResponses) {
    throw new Error(
      `Only ${candidates.length}/${config.minResponses} models responded successfully`,
    );
  }

  if (config.judgeModel) {
    return judgeSelect(candidates, config.judgeModel, query, executor);
  }

  return heuristicSelect(candidates);
}

// ─── Strategy: Majority Vote ────────────────────────────────────

/**
 * Run all models and select the most common response.
 * Best for discrete decisions (yes/no, category classification, etc.).
 */
export async function majorityVoteStrategy(
  query: Message[],
  config: EnsembleConfig,
  executor: ModelExecutor,
): Promise<EnsembleResult> {
  const candidates = await executeParallel(config.models, query, config, executor);

  if (candidates.length < config.minResponses) {
    throw new Error(
      `Only ${candidates.length}/${config.minResponses} models responded successfully`,
    );
  }

  return majorityVote(candidates);
}

// ─── Strategy: Merge ────────────────────────────────────────────

/**
 * Combine the best parts of multiple responses into one.
 * Uses section-based merging or LLM-based merging if a judge model is available.
 */
export async function mergeStrategy(
  query: Message[],
  config: EnsembleConfig,
  executor: ModelExecutor,
): Promise<EnsembleResult> {
  const candidates = await executeParallel(config.models, query, config, executor);

  if (candidates.length < config.minResponses) {
    throw new Error(
      `Only ${candidates.length}/${config.minResponses} models responded successfully`,
    );
  }

  if (config.judgeModel) {
    return llmMerge(candidates, query, config.judgeModel, executor);
  }

  return mergeSections(candidates);
}

// ─── Strategy: Verify ───────────────────────────────────────────

/**
 * One model generates the response, another verifies and corrects it.
 * Useful when you have a fast model (generator) and a more capable model (verifier).
 *
 * Flow:
 * 1. Model A generates response
 * 2. Model B receives the response + original query and verifies
 * 3. If B detects errors, it corrects them
 * 4. Final output is the verified/corrected version
 */
export async function verifyStrategy(
  query: Message[],
  config: EnsembleConfig,
  executor: ModelExecutor,
): Promise<EnsembleResult> {
  if (config.models.length < 2) {
    throw new Error("Verify strategy requires at least 2 models (generator + verifier)");
  }

  const [generatorModel, verifierModel] = config.models as [string, string];

  // 1. Generate
  const startGen = Date.now();
  const generated = await executor.execute(generatorModel!, query, 4096);
  const genDuration = Date.now() - startGen;

  // 2. Verify
  const lastUserMessage = query.filter((m) => m.role === "user").pop();
  const queryText = lastUserMessage
    ? typeof lastUserMessage.content === "string"
      ? lastUserMessage.content
      : JSON.stringify(lastUserMessage.content)
    : "";

  const verifyPrompt = [
    `Review this response to the user's question. If it is correct, respond "APPROVED" followed`,
    `by the original response without changes. If it has errors, respond "CORRECTED" followed by`,
    `the corrected version.`,
    ``,
    `QUESTION: ${queryText}`,
    ``,
    `RESPONSE TO REVIEW:`,
    generated.content,
  ]
    .join("\n")
    .trim();

  const startVer = Date.now();
  const verified = await executor.execute(
    verifierModel!,
    [{ role: "user", content: verifyPrompt }],
    4096,
  );
  const verDuration = Date.now() - startVer;

  const wasCorrected = verified.content.startsWith("CORRECTED");

  return {
    finalResponse: wasCorrected ? verified.content.replace(/^CORRECTED\s*/, "") : generated.content,
    strategy: "verify",
    candidates: [
      {
        model: generatorModel!,
        response: generated.content,
        tokensUsed: generated.tokensUsed,
        durationMs: genDuration,
        score: wasCorrected ? 0.0 : 1.0,
      },
      {
        model: verifierModel!,
        response: verified.content,
        tokensUsed: verified.tokensUsed,
        durationMs: verDuration,
        score: wasCorrected ? 1.0 : 0.5,
      },
    ],
    reasoning: wasCorrected ? "Verifier corrected the response" : "Verifier approved the original",
  };
}

// ─── Strategy: Specialize ───────────────────────────────────────

/**
 * Divide the task into sub-tasks and assign each to a specialized model.
 *
 * Flow:
 * 1. Classify the query to determine task type
 * 2. Find the best specialized model for that task
 * 3. Execute with the specialized model
 * 4. If no specialization matches, fall back to best-of-n
 */
export async function specializeStrategy(
  query: Message[],
  config: SpecializeConfig,
  executor: ModelExecutor,
): Promise<EnsembleResult> {
  // Classify the task using the router
  const lastUserMessage = query.filter((m) => m.role === "user").pop();
  const queryText = lastUserMessage
    ? typeof lastUserMessage.content === "string"
      ? lastUserMessage.content
      : ""
    : "";

  const taskType = classifyTask(queryText);

  // Find the best specialized model for this task type
  let selectedModel: string | undefined;
  let matchedSpec: string | undefined;

  for (const [name, spec] of Object.entries(config.specializations)) {
    if (spec.tasks.includes(taskType)) {
      selectedModel = spec.model;
      matchedSpec = name;
      break;
    }
  }

  if (!selectedModel) {
    // No specialization matches; fall back to best-of-n with all models
    return bestOfN(query, config, executor);
  }

  // Execute with the specialized model
  const start = Date.now();
  const result = await executor.execute(selectedModel, query, 4096);
  const duration = Date.now() - start;

  return {
    finalResponse: result.content,
    strategy: "specialize",
    candidates: [
      {
        model: selectedModel,
        response: result.content,
        tokensUsed: result.tokensUsed,
        durationMs: duration,
        score: 1.0,
      },
    ],
    reasoning: `Specialized model "${matchedSpec}" (${selectedModel}) selected for task type "${taskType}"`,
  };
}

// ─── Strategy Dispatcher ────────────────────────────────────────

/**
 * Execute the appropriate ensemble strategy based on config.
 */
export async function executeStrategy(
  query: Message[],
  config: EnsembleConfig,
  executor: ModelExecutor,
): Promise<EnsembleResult> {
  switch (config.strategy) {
    case "best-of-n":
      return bestOfN(query, config, executor);
    case "majority-vote":
      return majorityVoteStrategy(query, config, executor);
    case "merge":
      return mergeStrategy(query, config, executor);
    case "verify":
      return verifyStrategy(query, config, executor);
    case "specialize":
      return specializeStrategy(query, config as SpecializeConfig, executor);
    default:
      throw new Error(`Unknown ensemble strategy: ${config.strategy}`);
  }
}
