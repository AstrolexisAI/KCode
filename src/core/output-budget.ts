// KCode - Output Budget Manager
// Estimates if a prompt will likely produce a response that exceeds
// the model's output token limit, and suggests strategies to avoid truncation.

import { CHARS_PER_TOKEN } from "./token-budget";

export type BudgetStrategy = "normal" | "summarize" | "sectioned" | "warn";

export interface OutputBudgetDecision {
  strategy: BudgetStrategy;
  estimatedOutputTokens: number;
  maxAllowedTokens: number;
  reason?: string;
  /** System message to inject before generation. */
  systemHint?: string;
}

// CHARS_PER_TOKEN imported from token-budget.ts

/**
 * Signals in the prompt that suggest the response will be very long.
 */
const LONG_RESPONSE_SIGNALS = [
  // N words ≈ N*5 chars ≈ N*5/3.5 tokens ≈ N*1.4 tokens
  { pattern: /\b(\d{3,})\s*(words?|palabras)\b/i, multiplier: (m: RegExpMatchArray) => Math.round(parseInt(m[1]!) * 1.4) },
  { pattern: /\bextens[oa]?\b|\bexhaustiv/i, multiplier: () => 2000 },
  { pattern: /\bcada\s+década\b|\beach\s+decade\b/i, multiplier: () => 1500 },
  { pattern: /\bhistoria\s+completa\b|\bcomplete\s+history\b/i, multiplier: () => 2000 },
  { pattern: /\btodos?\s+los\s+(?:cálculos|pasos|detalles)\b|\ball\s+(?:calculations|steps|details)\b/i, multiplier: () => 1500 },
  { pattern: /\bmostrá?\s+(?:todos?|cada)\b|\bshow\s+(?:all|every)\b/i, multiplier: () => 1200 },
  { pattern: /\b(5|6|7|8|9|10)\s*(?:partes?|parts?|secciones?|sections?)\b/i, multiplier: (m: RegExpMatchArray) => parseInt(m[1]!) * 400 },
];

/**
 * Evaluate whether the prompt is likely to produce a response that
 * exceeds the output budget. Returns a strategy recommendation.
 *
 * @param prompt The user's prompt
 * @param maxOutputTokens The model's max output tokens
 * @param contextUsagePercent How much of the context window is already used (0-100)
 */
export function evaluateOutputBudget(
  prompt: string,
  maxOutputTokens: number,
  contextUsagePercent: number = 0,
): OutputBudgetDecision {
  let estimatedTokens = 0;

  // Check for explicit long-response signals
  for (const signal of LONG_RESPONSE_SIGNALS) {
    const match = prompt.match(signal.pattern);
    if (match) {
      const tokens = signal.multiplier(match);
      estimatedTokens = Math.max(estimatedTokens, tokens);
    }
  }

  // Heuristic: structured prompts with many sections tend to produce long responses
  const sectionCount = (prompt.match(/^#{1,4}\s+/gm) ?? []).length;
  const bulletCount = (prompt.match(/^\s*[-*]\s+/gm) ?? []).length;
  if (sectionCount >= 3 && bulletCount >= 5) {
    estimatedTokens = Math.max(estimatedTokens, sectionCount * 300 + bulletCount * 100);
  }

  // If no signals detected, use a conservative estimate based on prompt length
  if (estimatedTokens === 0) {
    // Rough: response is typically 2-5x the prompt length for analytical tasks
    const promptTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
    estimatedTokens = promptTokens * 2;
  }

  // Determine strategy
  const budget = maxOutputTokens * 0.9; // Leave 10% margin
  const effectiveBudget = contextUsagePercent > 80 ? budget * 0.5 : budget;

  if (estimatedTokens <= effectiveBudget) {
    return { strategy: "normal", estimatedOutputTokens: estimatedTokens, maxAllowedTokens: maxOutputTokens };
  }

  if (estimatedTokens <= effectiveBudget * 2) {
    return {
      strategy: "summarize",
      estimatedOutputTokens: estimatedTokens,
      maxAllowedTokens: maxOutputTokens,
      reason: `Response may exceed output limit (~${Math.round(estimatedTokens)} tokens estimated, ${maxOutputTokens} max)`,
      systemHint: "[SYSTEM] This prompt may require a long response. Be concise and prioritize key points. If you need more space, structure your answer in sections and indicate which section you're on.",
    };
  }

  if (estimatedTokens <= effectiveBudget * 4) {
    return {
      strategy: "sectioned",
      estimatedOutputTokens: estimatedTokens,
      maxAllowedTokens: maxOutputTokens,
      reason: `Response will likely exceed output limit (~${Math.round(estimatedTokens)} tokens, ${maxOutputTokens} max)`,
      systemHint: "[SYSTEM] This prompt requires a very long response that will exceed your output limit. Respond in a structured, compact format. Focus on the most important points first. Use bullet points and tables instead of long paragraphs. If you must truncate, end at a natural section boundary.",
    };
  }

  return {
    strategy: "warn",
    estimatedOutputTokens: estimatedTokens,
    maxAllowedTokens: maxOutputTokens,
    reason: `Response will far exceed output limit (~${Math.round(estimatedTokens)} tokens, ${maxOutputTokens} max)`,
    systemHint: "[SYSTEM] WARNING: This prompt asks for far more content than can fit in one response. Provide a condensed version covering the key points. Use sections with headers so the user can ask for expansion on specific parts. Do NOT attempt to write everything — it will be truncated.",
  };
}
