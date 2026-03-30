// KCode - Request Builder
// Extracted from conversation.ts — handles API request construction for LLM providers

import type { KCodeConfig, Message } from "./types";
import type { ModelProvider } from "./models";
import { getModelBaseUrl, getModelProvider } from "./models";
import { type SSEChunk, parseSSEStream, parseAnthropicSSEStream } from "./sse-parser";
import {
  convertToOpenAIMessages,
  convertToOpenAITools,
  convertToAnthropicMessages,
  convertToAnthropicTools,
} from "./message-converters";
import type { ToolRegistry } from "./tool-registry";
import { log } from "./logger";
import { readFileSync } from "node:fs";
import { getDebugTracer } from "./debug-tracer";

// ─── Types ───────────────────────────────────────────────────────

export interface ModelRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  provider: ModelProvider;
  parser: (response: Response) => AsyncGenerator<SSEChunk>;
}

export interface BuildRequestOptions {
  maxTokens?: number;
  includeTools?: boolean;
  effortLevel?: string;
}

// ─── Tool Token Estimation ───────────────────────────────────────

import { CHARS_PER_TOKEN } from "./token-budget";

/**
 * Estimate how many tokens the tool definitions will consume in the request body.
 * This accounts for name, description, and JSON schema of each tool.
 */
export function estimateToolDefinitionTokens(
  tools: ToolRegistry,
  profileFilter?: (name: string) => boolean,
): number {
  let defs = tools.getDefinitions();
  if (profileFilter) defs = defs.filter(d => profileFilter(d.name));
  if (defs.length === 0) return 0;
  const totalChars = defs.reduce((sum, d) => {
    return sum + d.name.length + (d.description?.length ?? 0)
      + JSON.stringify(d.input_schema ?? {}).length + 50; // 50 chars overhead per tool (keys, formatting)
  }, 0);
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

// ─── API Key Resolution ──────────────────────────────────────────

/**
 * Resolve the API key for a model based on its name/baseUrl.
 * Checks provider-specific env vars first, then falls back to config.apiKey.
 */
export function resolveApiKey(modelName: string, baseUrl: string, config: KCodeConfig): string | undefined {
  // Provider-specific env vars (checked in priority order)
  const lower = modelName.toLowerCase();
  const urlLower = baseUrl.toLowerCase();

  if (lower.startsWith("gpt-") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4") || urlLower.includes("openai.com")) {
    return process.env.OPENAI_API_KEY ?? config.apiKey;
  }
  if (lower.startsWith("gemini") || urlLower.includes("googleapis.com") || urlLower.includes("generativelanguage")) {
    return process.env.GEMINI_API_KEY ?? config.apiKey;
  }
  if (urlLower.includes("groq.com")) {
    return process.env.GROQ_API_KEY ?? config.apiKey;
  }
  if (lower.startsWith("deepseek") || urlLower.includes("deepseek.com")) {
    return process.env.DEEPSEEK_API_KEY ?? config.apiKey;
  }
  if (urlLower.includes("together.xyz")) {
    return process.env.TOGETHER_API_KEY ?? config.apiKey;
  }

  return config.apiKey;
}

// ─── Request Building ────────────────────────────────────────────

/**
 * Build a complete API request (URL, headers, body, provider) for a given model.
 * Handles both OpenAI and Anthropic formats.
 */
export async function buildRequestForModel(
  modelName: string,
  config: KCodeConfig,
  systemPrompt: string,
  messages: Message[],
  tools: ToolRegistry,
  opts?: BuildRequestOptions,
): Promise<ModelRequest> {
  const provider = await getModelProvider(modelName);
  const apiBase = await getModelBaseUrl(modelName, config.apiBase);
  const maxTokens = opts?.maxTokens ?? config.maxTokens;
  const includeTools = opts?.includeTools ?? true;
  const effort = (opts?.effortLevel ?? config.effortLevel ?? "medium") as string;

  const tracer = getDebugTracer();
  if (tracer.isEnabled()) {
    const resolvedKey = provider === "anthropic"
      ? (config.anthropicApiKey ? "anthropic-key" : config.apiKey ? "config-key" : "none")
      : (resolveApiKey(modelName, apiBase, config) ? "resolved" : "none");
    tracer.trace("model", `Build request: ${modelName}`, `Provider: ${provider}, base: ${apiBase}, effort: ${effort}, key: ${resolvedKey}`, { provider, apiBase, effort, maxTokens: opts?.maxTokens ?? config.maxTokens });
  }

  const effortMaxTokens = effort === "low" ? Math.min(maxTokens, 4096)
    : effort === "max" ? Math.max(maxTokens, 65536)
    : effort === "high" ? Math.max(maxTokens, 32768)
    : maxTokens;
  const effortTemperature = effort === "low" ? 0.3 : effort === "max" ? 0.9 : effort === "high" ? 0.7 : undefined;

  // Model profile: filter tools and adjust temperature for small models
  let profileToolFilter: ((name: string) => boolean) | null = null;
  let profileTemperature: number | undefined;
  try {
    const { getModelProfile, isToolAllowedForProfile } = require("./model-profile") as typeof import("./model-profile");
    const profile = getModelProfile(modelName);
    if (profile.tools !== "all") {
      profileToolFilter = (name: string) => isToolAllowedForProfile(name, profile);
    }
    if (profile.temperature !== null && !effortTemperature) {
      profileTemperature = profile.temperature;
    }
  } catch { /* module not loaded */ }

  // Tool budget cap: if tool definitions would consume >15% of context window,
  // fall back to essential tools only. Prevents bloating simple prompts with 27K+ tokens.
  const contextWindow = config.contextWindowSize ?? 32_000;
  const toolOverhead = estimateToolDefinitionTokens(tools, profileToolFilter ?? undefined);
  if (toolOverhead > contextWindow * 0.15 && !profileToolFilter) {
    const ESSENTIAL_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep", "GrepReplace", "LS"]);
    profileToolFilter = (name: string) => ESSENTIAL_TOOLS.has(name);
    log.info("llm", `Tool budget cap: ${toolOverhead} tokens > 15% of ${contextWindow}. Reduced to essential tools.`);
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (provider === "anthropic") {
    // Anthropic API: /v1/messages with x-api-key header
    const url = `${apiBase}/v1/messages`;
    const apiKey = config.anthropicApiKey ?? config.apiKey;
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }
    headers["anthropic-version"] = "2023-06-01";

    const convertedMessages = convertToAnthropicMessages(messages);
    const body: Record<string, unknown> = {
      model: modelName,
      messages: convertedMessages,
      system: systemPrompt,
      max_tokens: effortMaxTokens,
      stream: true,
    };

    if (effortTemperature !== undefined) {
      body.temperature = effortTemperature;
    }

    if (includeTools) {
      let defs = tools.getDefinitions();
      if (profileToolFilter) defs = defs.filter(d => profileToolFilter!(d.name));
      const toolDefs = convertToAnthropicTools(defs);
      if (toolDefs.length > 0) body.tools = toolDefs;
    }

    return { url, headers, body, provider, parser: parseAnthropicSSEStream };
  } else if (provider === "mnemocuda") {
    // MnemoCUDA: custom /v1/completions with ChatML prompt formatting
    // Thinking models embed <think>...</think> in the output, sharing max_tokens.
    const mnemocudaMaxTokens = config.thinking
      ? effortMaxTokens * 2
      : effortMaxTokens;

    const { buildMnemoCudaRequest, parseMnemoCudaStream } = await import("./mnemocuda-provider.js");
    const req = buildMnemoCudaRequest(
      apiBase,
      systemPrompt,
      messages,
      mnemocudaMaxTokens,
      effortTemperature ?? profileTemperature,
      config.apiKey,
    );

    // MnemoCUDA parser wraps its SSE format into OpenAI-compatible chunks
    const mnemoCudaParser = (response: Response): AsyncGenerator<SSEChunk> => {
      return parseMnemoCudaStream(response) as unknown as AsyncGenerator<SSEChunk>;
    };

    return { url: req.url, headers: req.headers, body: req.body, provider, parser: mnemoCudaParser };
  } else {
    // OpenAI-compatible API: /v1/chat/completions with Bearer token
    const url = `${apiBase}/v1/chat/completions`;
    // Resolve API key: check provider-specific env vars, then fall back to config.apiKey
    const resolvedKey = resolveApiKey(modelName, apiBase, config);
    if (resolvedKey) {
      headers["Authorization"] = `Bearer ${resolvedKey}`;
    }

    const convertedMessages = convertToOpenAIMessages(systemPrompt, messages);
    let filteredDefs = tools.getDefinitions();
    if (profileToolFilter) filteredDefs = filteredDefs.filter(d => profileToolFilter!(d.name));
    const toolDefs = includeTools ? convertToOpenAITools(filteredDefs) : [];

    const body: Record<string, unknown> = {
      model: modelName,
      messages: convertedMessages,
      max_tokens: effortMaxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    const finalTemp = effortTemperature ?? profileTemperature;
    if (finalTemp !== undefined) {
      body.temperature = finalTemp;
    }

    if (toolDefs.length > 0) body.tools = toolDefs;

    // Qwen3: control thinking mode via chat_template_kwargs
    // llama.cpp shares max_tokens between thinking + response output.
    // With unlimited reasoning (-1), the model can spend almost all tokens
    // on thinking, leaving nothing for the visible response.
    if (config.thinking) {
      body.chat_template_kwargs = { enable_thinking: true };
      // Pass through the user's reasoning budget unchanged.
      // Double max_tokens so thinking + response both fit.
      if (config.reasoningBudget !== undefined) {
        body.reasoning_budget = config.reasoningBudget;
      }
      body.max_tokens = effortMaxTokens * 2;
      log.info("llm", `Thinking mode: max_tokens=${body.max_tokens} (2x ${effortMaxTokens}), reasoning_budget=${config.reasoningBudget ?? "not set"}`);
    } else {
      body.chat_template_kwargs = { enable_thinking: false };
    }

    // JSON schema response format
    if (config.jsonSchema) {
      try {
        const schema = config.jsonSchema.startsWith("{")
          ? JSON.parse(config.jsonSchema)
          : JSON.parse(readFileSync(config.jsonSchema, "utf-8"));
        body.response_format = { type: "json_object" };
        body.json_schema = schema;
      } catch (e) {
        log.warn("llm", `Invalid JSON schema, ignoring: ${e}`);
      }
    }

    return { url, headers, body, provider, parser: parseSSEStream };
  }
}

/**
 * Execute a streaming request to a model and return the parsed SSE stream.
 * Used by both primary and fallback paths.
 */
export async function executeModelRequest(
  modelName: string,
  config: KCodeConfig,
  systemPrompt: string,
  messages: Message[],
  tools: ToolRegistry,
  abortController: AbortController | null,
  opts?: BuildRequestOptions,
): Promise<AsyncGenerator<SSEChunk>> {
  const req = await buildRequestForModel(modelName, config, systemPrompt, messages, tools, opts);

  // Pre-flight safety: if serialized request exceeds 95% of context window, strip tools
  if (config.contextWindowSize) {
    const bodyStr = JSON.stringify(req.body);
    const estimatedTokens = Math.ceil(bodyStr.length / CHARS_PER_TOKEN);
    if (estimatedTokens > config.contextWindowSize * 0.95) {
      log.warn("llm", `Pre-flight: ~${estimatedTokens} tokens > 95% of ${config.contextWindowSize}. Stripping tools to fit.`);
      delete req.body.tools;
    }
  }

  log.info("llm", `Request to ${modelName} (${req.provider}) at ${req.url}`);

  // Use a long timeout for large prompts (local models can take minutes to process 40K+ tokens)
  const controller = abortController;
  const timeoutMs = 300_000; // 5 minutes
  const timeoutId = setTimeout(() => controller?.abort(), timeoutMs);

  const fetchFn = config.customFetch ?? globalThis.fetch;
  const response = await fetchFn(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal: controller?.signal,
  }).finally(() => clearTimeout(timeoutId));

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `API request failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
    );
  }

  if (!response.body) {
    throw new Error("Response body is null - streaming not supported");
  }

  return req.parser(response);
}
