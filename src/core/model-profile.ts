// KCode - Model Profiles
// Adjusts KCode behavior based on model size/capability.
// Small models get fewer tools, shorter prompts, tighter limits.

import { MODEL_CATALOG } from "./model-catalog";

export type ModelSize = "tiny" | "small" | "medium" | "large";

export interface ModelProfile {
  size: ModelSize;
  maxTokens: number;
  maxAgentTurns: number;
  compactThreshold: number;
  /** Tool names to include. "all" = no filtering. */
  tools: string[] | "all";
  /** System prompt mode. */
  promptMode: "lite" | "standard" | "full";
  /** Temperature override (null = use default). */
  temperature: number | null;
  /** Max continuations for truncation recovery. */
  maxContinuations: number;
}

const PROFILES: Record<ModelSize, ModelProfile> = {
  tiny: {
    size: "tiny",
    maxTokens: 2048,
    maxAgentTurns: 3,
    compactThreshold: 0.6,
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    promptMode: "lite",
    temperature: 0.3,
    maxContinuations: 1,
  },
  small: {
    size: "small",
    maxTokens: 4096,
    maxAgentTurns: 8,
    compactThreshold: 0.65,
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "LS", "GitCommit", "GitStatus"],
    promptMode: "standard",
    temperature: 0.4,
    maxContinuations: 1,
  },
  medium: {
    size: "medium",
    maxTokens: 8192,
    maxAgentTurns: 15,
    compactThreshold: 0.75,
    tools: "all",
    promptMode: "full",
    temperature: null,
    maxContinuations: 2,
  },
  large: {
    size: "large",
    maxTokens: 16384,
    maxAgentTurns: 25,
    compactThreshold: 0.8,
    tools: "all",
    promptMode: "full",
    temperature: null,
    maxContinuations: 2,
  },
};

/**
 * Determine model size from parameter count or model name.
 */
export function detectModelSize(modelName: string): ModelSize {
  // Check catalog first by codename or mlxRepo (so MLX-served users
  // get the right profile too — e.g. "mlx-community/GLM-4.7-Flash-4bit"
  // resolves to the mark5-mini entry's 32B paramBillions).
  const entry = MODEL_CATALOG.find((m) => m.codename === modelName || m.mlxRepo === modelName);
  if (entry) {
    if (entry.paramBillions <= 4) return "tiny";
    if (entry.paramBillions <= 10) return "small";
    if (entry.paramBillions <= 35) return "medium";
    return "large";
  }

  // Heuristic from model name. Strip quantization/format suffixes and
  // version numbers FIRST — without this "GLM-4.7-Flash-4bit" matched
  // "4b" in "4bit" and got misclassified as a 4B tiny model, which
  // truncated maxTokens to 2048 and made the model hang on real
  // analysis prompts (verified 2026-05-09 with a 7-min timeout on Mac).
  const stripped = modelName
    .toLowerCase()
    .replace(/-?\b(?:[248]bit|q[238][_a-z0-9]+|fp16|bf16|gptq|awq|gguf|mlx|dwq)\b/g, "")
    .replace(/-?\b\d{1,2}\.\d+\b/g, ""); // drop version numbers like "4.7"
  if (/\b(?:pico|tiny|1b|2b|3b|4b)\b/.test(stripped)) return "tiny";
  if (/\b(?:nano|small|7b|8b)\b/.test(stripped)) return "small";
  if (/\b(?:mini|mid|14b|27b|30b|32b)\b/.test(stripped)) return "medium";
  if (/\b(?:max|80b|70b|235b)\b|claude|gpt-4|opus|sonnet/.test(stripped)) return "large";

  // Cloud models are always "large"
  if (/anthropic|openai|gemini|groq|deepseek|together/.test(stripped)) return "large";

  // Default: medium (safe middle ground)
  return "medium";
}

/**
 * Get the profile for a model.
 */
export function getModelProfile(modelName: string): ModelProfile {
  const size = detectModelSize(modelName);
  const profile = { ...PROFILES[size] };

  return profile;
}

/**
 * Check if a tool should be available for this model profile.
 */
export function isToolAllowedForProfile(toolName: string, profile: ModelProfile): boolean {
  if (profile.tools === "all") return true;
  return profile.tools.includes(toolName);
}
