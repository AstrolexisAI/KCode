// KCode - Tool-use fitness heuristic
//
// Quick, hardcoded score for "how good is this model at calling tools
// in a real session?" Used by the /model selector + `kcode models list`
// to warn users away from models that historically fail tool-use:
// refuse to run Bash, hallucinate file contents, or get stuck in
// "please paste the output" loops.
//
// Sources:
//   - Curly's 2026-05-08 macOS session: Gemma-4-26b refused tools 30+
//     turns in a row.
//   - General community signal as of 2026-05: tool-use fine-tuning is
//     gated on training-data quality, and most non-coder open models
//     under 30B struggle vs. frontier APIs.
//
// This is intentionally NOT data-driven. A real benchmark per model
// would be ideal but requires per-deploy infra. For now, a curated
// list of patterns gives most of the value with no infra cost. False
// negatives (a "weak" model that turns out to be fine) are recoverable
// — the user can ignore the warning. False positives (a "good" model
// flagged weak) get surfaced via Curly's testing.

export type ToolFitnessTier = "good" | "weak" | "unknown";

export interface ToolFitness {
  /** Coarse tier — drives badge color in the TUI. */
  tier: ToolFitnessTier;
  /** Optional one-line reason shown when the model is selected. */
  reason?: string;
}

interface FitnessRule {
  /** Substring or regex tested against the model name (lowercased). */
  match: RegExp;
  tier: ToolFitnessTier;
  reason?: string;
}

// Order matters: first match wins. Put more specific rules before
// broader ones (e.g. qwen3-coder before generic qwen).
const RULES: FitnessRule[] = [
  // ── Frontier cloud APIs — strong tool use ──
  { match: /^claude-/, tier: "good" },
  { match: /^gpt-(4|5|o1|o3)/, tier: "good" },
  { match: /^o(1|3)\b/, tier: "good" },
  { match: /^gemini-(1\.5|2)/, tier: "good" },
  { match: /^grok-(3|4)/, tier: "good" },

  // ── Coder-tuned open models — generally strong ──
  { match: /qwen3-coder/, tier: "good" },
  { match: /qwen2\.5-coder/, tier: "good" },
  { match: /deepseek-(coder|v[23])/, tier: "good" },
  { match: /codestral/, tier: "good" },

  // ── Generally OK at tools, large enough ──
  { match: /qwen3(?!\.5-4b)/, tier: "good" }, // Qwen3 8B+ — but 4B is weak
  { match: /llama-3\.1-(70b|405b)/, tier: "good" },
  { match: /llama-3\.3-70b/, tier: "good" },
  { match: /mistral-large/, tier: "good" },

  // ── Known-weak with tools ──
  {
    match: /gemma-?[234]/,
    tier: "weak",
    reason:
      "Gemma family historically refuses tools or hallucinates instead of calling Bash. Prefer Qwen3-Coder, Claude, or Grok for agentic work.",
  },
  {
    match: /llama-2-/,
    tier: "weak",
    reason: "Llama-2 predates the tool-use fine-tuning era; tool calls are unreliable.",
  },
  {
    match: /llama-3\.0-/,
    tier: "weak",
    reason: "Llama-3.0 small variants struggle with tool calls. Prefer Llama-3.1+ at 70B+.",
  },
  {
    match: /phi-(2|3)\b/,
    tier: "weak",
    reason: "Phi-2/3 are too small for reliable agentic tool use.",
  },
  {
    match: /qwen3\.5-4b/,
    tier: "weak",
    reason: "Qwen3.5-4B is below the threshold where tool-use fine-tuning is reliable.",
  },
  {
    match: /-(0\.5|1|1\.5|3)b\b/,
    tier: "weak",
    reason: "Models under ~7B parameters generally don't tool-call reliably regardless of family.",
  },
];

/**
 * Score a model name's tool-use fitness. Returns "unknown" when no
 * rule matches — UI should treat unknown as "no badge" rather than
 * implying anything.
 */
export function assessToolFitness(modelName: string): ToolFitness {
  if (!modelName) return { tier: "unknown" };
  const haystack = modelName.toLowerCase();
  for (const rule of RULES) {
    if (rule.match.test(haystack)) {
      return rule.reason ? { tier: rule.tier, reason: rule.reason } : { tier: rule.tier };
    }
  }
  return { tier: "unknown" };
}

/**
 * Short label for the badge column. Empty string for "good"/"unknown"
 * so the UI doesn't get visually noisy with the common case.
 */
export function fitnessBadge(tier: ToolFitnessTier): string {
  switch (tier) {
    case "weak":
      return "weak tools";
    case "good":
    case "unknown":
      return "";
  }
}
