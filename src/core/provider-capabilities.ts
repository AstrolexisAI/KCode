// KCode - Provider Capabilities Registry
// Central source of truth for per-provider API feature support.
// Replaces scattered if/else checks across request-builder.ts.

import type { ModelProvider } from "./models";

export interface ProviderCaps {
  /** Provider uses a standalone "system" (or "developer") role message. */
  usesSystemField: boolean;
  /** Reasoning model variants (o1/o3/o4) must use "developer" role instead of "system". */
  systemRoleForReasoning: "system" | "developer";
  /** Provider supports extended thinking / chain-of-thought tokens. */
  supportsThinking: boolean;
  /** Provider supports prompt caching (cache_control on message blocks). */
  supportsPromptCache: boolean;
  /**
   * Provider supports the reasoning_effort parameter.
   * "selective" means only some models support it (check per-model before sending).
   */
  supportsReasoningEffort: boolean | "selective";
  /** Wire format for tool definitions sent to this provider. */
  toolFormat: "anthropic" | "openai";
  /** SSE stream format emitted by this provider. */
  streamParser: "anthropic" | "openai";
}

export const PROVIDER_CAPABILITIES: Record<ModelProvider, ProviderCaps> = {
  anthropic: {
    usesSystemField: true,
    systemRoleForReasoning: "system",
    supportsThinking: true,
    supportsPromptCache: true,
    supportsReasoningEffort: false,
    toolFormat: "anthropic",
    streamParser: "anthropic",
  },
  openai: {
    usesSystemField: true,
    // o1/o3/o4 require "developer" role; all other OpenAI models use "system"
    systemRoleForReasoning: "developer",
    supportsThinking: false,
    supportsPromptCache: false,
    supportsReasoningEffort: true,
    toolFormat: "openai",
    streamParser: "openai",
  },
  xai: {
    usesSystemField: true,
    systemRoleForReasoning: "system",
    supportsThinking: false,
    supportsPromptCache: false,
    // grok-3-mini accepts reasoning_effort; grok-4.20-*-reasoning rejects it
    supportsReasoningEffort: "selective",
    toolFormat: "openai",
    streamParser: "openai",
  },
  google: {
    usesSystemField: true,
    systemRoleForReasoning: "system",
    supportsThinking: false,
    supportsPromptCache: false,
    supportsReasoningEffort: false,
    toolFormat: "openai",
    streamParser: "openai",
  },
  deepseek: {
    usesSystemField: true,
    systemRoleForReasoning: "system",
    supportsThinking: true,
    supportsPromptCache: false,
    supportsReasoningEffort: false,
    toolFormat: "openai",
    streamParser: "openai",
  },
  groq: {
    usesSystemField: true,
    systemRoleForReasoning: "system",
    supportsThinking: false,
    supportsPromptCache: false,
    supportsReasoningEffort: false,
    toolFormat: "openai",
    streamParser: "openai",
  },
  openrouter: {
    usesSystemField: true,
    systemRoleForReasoning: "system",
    supportsThinking: false,
    supportsPromptCache: false,
    supportsReasoningEffort: false,
    toolFormat: "openai",
    streamParser: "openai",
  },
  together: {
    usesSystemField: true,
    systemRoleForReasoning: "system",
    supportsThinking: false,
    supportsPromptCache: false,
    supportsReasoningEffort: false,
    toolFormat: "openai",
    streamParser: "openai",
  },
};

/** Look up capabilities for a provider, falling back to a safe OpenAI-compatible default. */
export function getProviderCaps(provider: ModelProvider): ProviderCaps {
  return PROVIDER_CAPABILITIES[provider] ?? PROVIDER_CAPABILITIES.openai;
}
