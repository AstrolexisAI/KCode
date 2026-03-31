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
  execute(model: string, messages: Message[], maxTokens: number): Promise<{
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
