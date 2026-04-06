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
 * Checks in priority order:
 *   1. Claude Code OAuth bridge (sk-ant-oat01-*) → subscription billing, cheapest
 *   2. ANTHROPIC_API_KEY → per-token billing
 *   3. OPENAI_API_KEY → OpenAI
 */
export async function detectCloudFallback(currentApiBase?: string): Promise<CloudFallbackConfig> {
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

  // 1. Prefer OAuth bridge (subscription billing — user already pays, no extra cost)
  try {
    const { getClaudeCodeToken } = await import("../auth/claude-code-bridge.js");
    const oauthToken = await getClaudeCodeToken();
    if (oauthToken) {
      return {
        available: true,
        model: "claude-sonnet-4-20250514",
        apiBase: "https://api.anthropic.com/v1",
        apiKey: oauthToken,
        provider: "anthropic",
      };
    }
  } catch {
    /* bridge not available */
  }

  // 2. Check Anthropic API key
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

  // 3. Check OpenAI
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
export async function buildCloudFallbackCallback(
  currentApiBase?: string,
): Promise<((prompt: string) => Promise<string>) | null> {
  const config = await detectCloudFallback(currentApiBase);
  if (!config.available) return null;

  return makeAuditLlmCallback({
    model: config.model,
    apiBase: config.apiBase,
    apiKey: config.apiKey,
    temperature: 0.05,
  });
}

