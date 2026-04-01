// KCode - Multi-Model Ensemble Types
// Types for running multiple models in parallel with consensus-based response selection.

import type { Message } from "../types";

// ─── Strategy Types ─────────────────────────────────────────────

export type EnsembleStrategy =
  | "best-of-n" // Generate N responses, select the best
  | "majority-vote" // For discrete decisions, majority wins
  | "merge" // Combine parts of multiple responses
  | "verify" // One model generates, another verifies/corrects
  | "specialize"; // Different models for different parts

export type EnsembleTrigger = "always" | "complex" | "manual";

// ─── Configuration ──────────────────────────────────────────────

export interface EnsembleConfig {
  /** Which ensemble strategy to use */
  strategy: EnsembleStrategy;
  /** Model names to use in the ensemble */
  models: string[];
  /** Model that evaluates/selects the best response (can be the largest) */
  judgeModel?: string;
  /** How many models to run in parallel */
  maxParallel: number;
  /** Timeout per model in milliseconds */
  timeout: number;
  /** Minimum successful responses before deciding */
  minResponses: number;
  /** When to trigger ensemble mode */
  triggerOn: EnsembleTrigger;
  /** Max estimated cost (USD) before skipping ensemble and using single model */
  maxCostUsd?: number;
  /** Whether to track inter-model agreement rates for adaptive triggering */
  trackAgreement?: boolean;
}

// ─── Candidate Response ─────────────────────────────────────────

export interface CandidateResponse {
  model: string;
  response: string;
  tokensUsed: number;
  durationMs: number;
  score?: number;
}

// ─── Result ─────────────────────────────────────────────────────

export interface EnsembleResult {
  /** The final selected/merged response */
  finalResponse: string;
  /** Which strategy was used */
  strategy: EnsembleStrategy;
  /** All candidate responses with metadata */
  candidates: CandidateResponse[];
  /** Explanation of why this response was selected */
  reasoning: string;
  /** Total estimated cost of this ensemble run (USD) */
  estimatedCostUsd?: number;
  /** Whether candidates agreed (for adaptive triggering) */
  candidatesAgreed?: boolean;
}

// ─── Cost Estimation ───────────────────────────────────────────

export interface ModelCostRate {
  /** Cost per 1K input tokens in USD */
  inputPer1k: number;
  /** Cost per 1K output tokens in USD */
  outputPer1k: number;
}

/** Default cost rates for common models (per 1K tokens) */
export const MODEL_COST_RATES: Record<string, ModelCostRate> = {
  // Anthropic
  "claude-sonnet-4-5-20250514": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "claude-haiku-3-5-20241022": { inputPer1k: 0.0008, outputPer1k: 0.004 },
  // OpenAI
  "gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01 },
  "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  // Gemini
  "gemini-2.5-flash": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  "gemini-2.5-pro": { inputPer1k: 0.00125, outputPer1k: 0.01 },
  // DeepSeek
  "deepseek-chat": { inputPer1k: 0.00014, outputPer1k: 0.00028 },
  // Local models — free
  default: { inputPer1k: 0, outputPer1k: 0 },
};

/** Estimate cost for a single model call */
export function estimateModelCost(
  model: string,
  inputTokens: number,
  estimatedOutputTokens: number,
): number {
  // Find cost rate: exact match, then prefix match, then default
  const rate =
    MODEL_COST_RATES[model] ??
    Object.entries(MODEL_COST_RATES).find(([k]) => model.startsWith(k))?.[1] ??
    MODEL_COST_RATES["default"]!;
  return (inputTokens / 1000) * rate.inputPer1k + (estimatedOutputTokens / 1000) * rate.outputPer1k;
}

/** Estimate total cost for an ensemble run */
export function estimateEnsembleCost(
  models: string[],
  inputTokens: number,
  estimatedOutputTokens: number,
): number {
  return models.reduce(
    (sum, model) => sum + estimateModelCost(model, inputTokens, estimatedOutputTokens),
    0,
  );
}

// ─── Specialization Config ──────────────────────────────────────

export interface SpecializationEntry {
  model: string;
  tasks: string[];
}

export interface SpecializeConfig extends EnsembleConfig {
  specializations: Record<string, SpecializationEntry>;
}

// ─── Model Executor ─────────────────────────────────────────────
// Abstraction for executing model requests (injectable for testing)

export interface ModelExecutor {
  execute(
    model: string,
    messages: Message[],
    maxTokens: number,
  ): Promise<{
    content: string;
    tokensUsed: number;
    durationMs: number;
  }>;
}

// ─── Default Ensemble Settings ──────────────────────────────────

export const DEFAULT_ENSEMBLE_CONFIG: EnsembleConfig = {
  strategy: "best-of-n",
  models: [],
  judgeModel: undefined,
  maxParallel: 3,
  timeout: 60_000,
  minResponses: 2,
  triggerOn: "complex",
};
