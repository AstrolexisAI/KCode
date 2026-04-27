// Map model names to billing providers. Local (llama.cpp, Ollama,
// mnemo:*) is intentionally `null` — we don't bill local inference.

export type BillingProvider =
  | "anthropic"
  | "openai"
  | "xai"
  | "google"
  | "deepseek"
  | "groq"
  | "openrouter"
  | "kimi";

export const KNOWN_PROVIDERS: readonly BillingProvider[] = [
  "anthropic",
  "openai",
  "xai",
  "google",
  "deepseek",
  "groq",
  "openrouter",
  "kimi",
] as const;

/**
 * Derive the billing provider from a model name (and optionally a base
 * URL if the caller has it). Returns null for local / unrecognized.
 *
 * The match is prefix-based against conventional model-name schemes:
 *   claude-*            → anthropic
 *   gpt-*, o1-*, o3-*, o4-*, chatgpt-*  → openai
 *   grok-*              → xai
 *   gemini-*            → google
 *   deepseek-*          → deepseek
 *   llama-*-groq, *-groq → groq  (rare; usually via OpenRouter)
 *   openrouter/*        → openrouter
 */
export function providerFromModel(model: string, baseUrl?: string): BillingProvider | null {
  const m = model.toLowerCase();
  const url = (baseUrl ?? "").toLowerCase();

  if (url.includes("openrouter.ai") || m.startsWith("openrouter/")) return "openrouter";
  if (url.includes("api.anthropic.com") || m.startsWith("claude-")) return "anthropic";
  if (url.includes("api.x.ai") || m.startsWith("grok-")) return "xai";
  if (url.includes("api.groq.com")) return "groq";
  if (
    url.includes("api.openai.com") ||
    m.startsWith("gpt-") ||
    m.startsWith("o1-") ||
    m.startsWith("o3-") ||
    m.startsWith("o4-") ||
    m.startsWith("chatgpt-") ||
    m === "o1" ||
    m === "o3" ||
    m === "o4-mini"
  ) {
    return "openai";
  }
  if (m.startsWith("gemini-")) return "google";
  if (m.startsWith("deepseek-")) return "deepseek";
  if (url.includes("api.moonshot.cn") || m.startsWith("kimi-") || m.startsWith("moonshot-"))
    return "kimi";

  return null;
}

/** Human-friendly label, e.g. "xAI (Grok)". */
export function providerLabel(p: BillingProvider): string {
  switch (p) {
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "xai":
      return "xAI (Grok)";
    case "google":
      return "Google";
    case "deepseek":
      return "DeepSeek";
    case "groq":
      return "Groq";
    case "openrouter":
      return "OpenRouter";
    case "kimi":
      return "Kimi (Moonshot)";
  }
}
