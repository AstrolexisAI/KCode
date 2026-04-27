// KCode - Model Pricing Registry
// Per-model cost calculation for remote API providers

export interface ModelPricing {
  inputPer1M: number; // USD per 1M input tokens
  outputPer1M: number; // USD per 1M output tokens
  name?: string; // Display name
}

// Known provider pricing (as of 2026)
const KNOWN_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  "claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-opus-4-6": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-haiku-4-5": { inputPer1M: 0.8, outputPer1M: 4.0 },
  // OpenAI
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0 },
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  o3: { inputPer1M: 10.0, outputPer1M: 40.0 },
  "o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
  // Google
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10.0 },
  "gemini-2.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5 },
  "gemini-2.5-flash-lite": { inputPer1M: 0.1, outputPer1M: 0.4 },
  // DeepSeek
  "deepseek-chat": { inputPer1M: 0.27, outputPer1M: 1.1 },
  "deepseek-reasoner": { inputPer1M: 0.55, outputPer1M: 2.19 },
  // xAI (Grok) — fetched from https://api.x.ai/v1/language-models
  // Prices are per 1M tokens. xAI API reports them as USD ticks where
  // 1 USD = 100,000,000 ticks; 1 ticks-per-token × 1M tokens = $0.01,
  // so API "prompt_text_token_price: 20000" = $2/1M input.
  "grok-4": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "grok-4-latest": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "grok-4-0709": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "grok-4.20": { inputPer1M: 2.0, outputPer1M: 6.0 },
  "grok-4.20-reasoning": { inputPer1M: 2.0, outputPer1M: 6.0 },
  "grok-4.20-0309-reasoning": { inputPer1M: 2.0, outputPer1M: 6.0 },
  "grok-4.20-non-reasoning": { inputPer1M: 2.0, outputPer1M: 6.0 },
  "grok-4.20-0309-non-reasoning": { inputPer1M: 2.0, outputPer1M: 6.0 },
  "grok-4.20-multi-agent": { inputPer1M: 2.0, outputPer1M: 6.0 },
  "grok-4.20-multi-agent-0309": { inputPer1M: 2.0, outputPer1M: 6.0 },
  "grok-4-fast-reasoning": { inputPer1M: 0.2, outputPer1M: 0.5 },
  "grok-4-fast-non-reasoning": { inputPer1M: 0.2, outputPer1M: 0.5 },
  "grok-4-1-fast-reasoning": { inputPer1M: 0.2, outputPer1M: 0.5 },
  "grok-4-1-fast-non-reasoning": { inputPer1M: 0.2, outputPer1M: 0.5 },
  "grok-code-fast": { inputPer1M: 0.2, outputPer1M: 1.5 },
  "grok-code-fast-1": { inputPer1M: 0.2, outputPer1M: 1.5 },
  "grok-3": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "grok-3-mini": { inputPer1M: 0.3, outputPer1M: 0.5 },
};

// Custom pricing from ~/.kcode/pricing.json
let customPricing: Record<string, ModelPricing> = {};
let customLoaded = false;

async function loadCustomPricing(): Promise<void> {
  if (customLoaded) return;
  customLoaded = true;
  try {
    const { kcodePath } = await import("./paths");
    const file = Bun.file(kcodePath("pricing.json"));
    if (await file.exists()) {
      customPricing = await file.json();
    }
  } catch {
    /* ignore */
  }
}

/**
 * Get pricing for a model. Returns null for local/unknown models (= free).
 */
export async function getModelPricing(modelName: string): Promise<ModelPricing | null> {
  await loadCustomPricing();

  // Check custom pricing first (user overrides)
  if (customPricing[modelName]) return customPricing[modelName];

  // Check known pricing (exact match)
  if (KNOWN_PRICING[modelName]) return KNOWN_PRICING[modelName];

  // Fuzzy match: check if model name contains a known key
  for (const [key, pricing] of Object.entries(KNOWN_PRICING)) {
    if (modelName.includes(key) || key.includes(modelName)) {
      return pricing;
    }
  }

  return null; // Local model = free
}

/**
 * Calculate cost for given token counts.
 */
export function calculateCost(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M
  );
}

/**
 * Format cost as USD string.
 */
export function formatCost(cost: number): string {
  if (cost === 0) return "$0.00 (local inference)";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}
