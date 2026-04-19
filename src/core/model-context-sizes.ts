// KCode — Model context-size registry
//
// Central lookup for per-model context window sizes. Used by:
//
//   1. The setup wizard (cloud-setup.ts / setup-wizard.ts) when
//      registering a newly-picked cloud model in models.json. Before
//      this existed, addModel() was called without a contextSize
//      field, so models.ts → getModelContextSize() → undefined, so
//      config.ts → effectiveContextSize defaulted to 32_000 for
//      every cloud model. Claude Sonnet's real 200k window was
//      being clamped to 32k at the KCode layer, triggering
//      aggressive auto-compaction and "empty response" errors
//      when the provider saw mismatched context sizes.
//
//   2. A one-time migration that runs at startup (see
//      migrations/009_backfill_context_sizes.ts). Any existing
//      models.json entry that's missing a contextSize gets one
//      filled in based on its name, so users who ran `kcode setup`
//      before this module existed don't have to re-run it.
//
// Values are the advertised / observed stable context sizes, not
// the absolute per-request caps documented in provider fine print
// (some providers advertise "1M context" but cap to 131k on the
// endpoint the chat completions client hits). When in doubt we
// lean conservative so auto-compaction fires slightly earlier
// rather than later.

/** Known context sizes by exact model id.
 *
 * Anthropic's current Claude 4.x family supports 1M-token context via
 * the `context-1m-2025-08-07` beta header — KCode's Anthropic client
 * sets that header automatically, so we use the 1M figure as the
 * effective ceiling. If the beta ever gets revoked we fall back
 * gracefully because the provider caps the request server-side.
 */
const EXACT: Record<string, number> = {
  // ── Anthropic (1M with beta header; client sends it) ──────────
  "claude-sonnet-4-6": 1_000_000,
  "claude-sonnet-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-haiku-4-5": 1_000_000,
  "claude-sonnet-3-7": 200_000,
  "claude-opus-3": 200_000,

  // ── OpenAI ────────────────────────────────────────────────────
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_192,
  "gpt-3.5-turbo": 16_385,
  o3: 200_000,
  "o3-mini": 200_000,
  o1: 128_000,
  "o1-mini": 128_000,
  "o4-mini": 200_000,

  // ── Groq (Llama / Mixtral / Qwen) ─────────────────────────────
  "llama-3.3-70b-versatile": 131_072,
  "llama-3.1-70b-versatile": 131_072,
  "llama-3.1-8b-instant": 131_072,
  "mixtral-8x7b-32768": 32_768,
  "gemma2-9b-it": 8_192,
  "qwen-2.5-coder-32b": 131_072,

  // ── DeepSeek ──────────────────────────────────────────────────
  "deepseek-chat": 64_000,
  "deepseek-v3": 64_000,
  "deepseek-r1": 65_536,
  "deepseek-reasoner": 65_536,
  "deepseek-coder-v2": 128_000,

  // ── xAI (Grok-4 advertises 2M context) ────────────────────────
  "grok-4": 2_000_000,
  "grok-3": 131_072,
  "grok-3-mini": 131_072,
  "grok-code-fast-1": 256_000,
  "grok-beta": 131_072,
  "grok-2": 131_072,

  // ── Google Gemini ─────────────────────────────────────────────
  "gemini-2.5-pro": 2_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.0-flash": 1_000_000,
  "gemini-1.5-pro": 2_000_000,
  "gemini-1.5-flash": 1_000_000,
};

/**
 * Prefix rules applied when no exact match. Order matters — first
 * hit wins. Cheaper than enumerating every quantization variant.
 */
const PREFIXES: Array<{ prefix: string; size: number }> = [
  // Anthropic 4.x family gets the 1M beta; older prefixes go to 200k.
  { prefix: "claude-sonnet-4", size: 1_000_000 },
  { prefix: "claude-opus-4", size: 1_000_000 },
  { prefix: "claude-haiku-4", size: 1_000_000 },
  { prefix: "claude-", size: 200_000 },
  // OpenAI reasoning family
  { prefix: "o3", size: 200_000 },
  { prefix: "o4", size: 200_000 },
  // OpenAI flagship
  { prefix: "gpt-4", size: 128_000 },
  // Grok family — any unknown grok-4-* variant gets the 2M ceiling.
  { prefix: "grok-4", size: 2_000_000 },
  { prefix: "grok-code", size: 256_000 },
  { prefix: "grok-", size: 131_072 },
  // DeepSeek family
  { prefix: "deepseek-r", size: 65_536 },
  { prefix: "deepseek-", size: 64_000 },
  // Gemini family
  { prefix: "gemini-2", size: 1_000_000 },
  { prefix: "gemini-1.5", size: 2_000_000 },
  // Llama family (Together / Groq most common quant)
  { prefix: "llama-3", size: 131_072 },
  { prefix: "llama-4", size: 131_072 },
  { prefix: "meta-llama/Llama-3", size: 131_072 },
  { prefix: "meta-llama/Llama-4", size: 131_072 },
  // Mixtral family
  { prefix: "mixtral-", size: 32_768 },
  // Qwen
  { prefix: "qwen-", size: 131_072 },
  { prefix: "Qwen/", size: 131_072 },
];

/**
 * Best-effort guess for a model's context window.
 * Returns undefined when there's no exact or prefix match — the
 * caller can decide whether to use a default or prompt the user.
 */
export function guessContextSize(modelName: string): number | undefined {
  if (!modelName) return undefined;
  const exact = EXACT[modelName];
  if (exact) return exact;
  for (const { prefix, size } of PREFIXES) {
    if (modelName.startsWith(prefix)) return size;
  }
  return undefined;
}

/** Convenience export for callers that want the mapping for tests. */
export const KNOWN_EXACT_CONTEXT_SIZES = EXACT;
