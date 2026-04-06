// KCode - Cloud Fallback Detection
//
// Auto-detects if a cloud LLM is available for fallback verification.
// When a local model is the primary, this finds a cloud model to
// escalate ambiguous candidates to.

import { makeAuditLlmCallback } from "./llm-callback";

export interface CloudFallbackConfig {
  available: boolean;
  model: string;
  apiBase: string;
  apiKey: string;
  provider: "anthropic" | "openai" | "none";
}

/**
 * Detect if a cloud LLM is configured and available.
 * Checks env vars and config in priority order:
 *   1. ANTHROPIC_API_KEY → Anthropic Claude
 *   2. OPENAI_API_KEY → OpenAI
 *   3. KCODE_API_KEY + cloud-like API base → whatever provider
 */
export function detectCloudFallback(currentApiBase?: string): CloudFallbackConfig {
  const none: CloudFallbackConfig = {
    available: false,
    model: "",
    apiBase: "",
    apiKey: "",
    provider: "none",
  };

  // If current model is ALREADY cloud, no fallback needed
  if (
    currentApiBase?.includes("anthropic.com") ||
    currentApiBase?.includes("openai.com") ||
    currentApiBase?.includes("api.groq.com")
  ) {
    return none;
  }

  // Check Anthropic
  const anthropicKey =
    process.env.ANTHROPIC_API_KEY ?? process.env.KCODE_ANTHROPIC_KEY ?? "";
  if (anthropicKey) {
    return {
      available: true,
      model: "claude-sonnet-4-20250514",
      apiBase: "https://api.anthropic.com/v1",
      apiKey: anthropicKey,
      provider: "anthropic",
    };
  }

  // Check OpenAI
  const openaiKey = process.env.OPENAI_API_KEY ?? "";
  if (openaiKey) {
    return {
      available: true,
      model: "gpt-4o",
      apiBase: "https://api.openai.com/v1",
      apiKey: openaiKey,
      provider: "openai",
    };
  }

  return none;
}

/**
 * Build a cloud fallback LLM callback if one is available.
 * Returns null if no cloud provider is configured.
 */
export function buildCloudFallbackCallback(
  currentApiBase?: string,
): ((prompt: string) => Promise<string>) | null {
  const config = detectCloudFallback(currentApiBase);
  if (!config.available) return null;

  return makeAuditLlmCallback({
    model: config.model,
    apiBase: config.apiBase,
    apiKey: config.apiKey,
    temperature: 0.05, // very low temp for verification
  });
}
