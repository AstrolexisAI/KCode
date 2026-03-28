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
      const toolDefs = convertToAnthropicTools(tools.getDefinitions());
      if (toolDefs.length > 0) body.tools = toolDefs;
    }

    return { url, headers, body, provider, parser: parseAnthropicSSEStream };
  } else {
    // OpenAI-compatible API: /v1/chat/completions with Bearer token
    const url = `${apiBase}/v1/chat/completions`;
    // Resolve API key: check provider-specific env vars, then fall back to config.apiKey
    const resolvedKey = resolveApiKey(modelName, apiBase, config);
    if (resolvedKey) {
      headers["Authorization"] = `Bearer ${resolvedKey}`;
    }

    const convertedMessages = convertToOpenAIMessages(systemPrompt, messages);
    const toolDefs = includeTools ? convertToOpenAITools(tools.getDefinitions()) : [];

    const body: Record<string, unknown> = {
      model: modelName,
      messages: convertedMessages,
      max_tokens: effortMaxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (effortTemperature !== undefined) {
      body.temperature = effortTemperature;
    }

    if (toolDefs.length > 0) body.tools = toolDefs;

    // Qwen3: control thinking mode via chat_template_kwargs
    if (config.thinking) {
      body.chat_template_kwargs = { enable_thinking: true };
      // Set reasoning budget (-1 = unlimited, matching llama-server config)
      if (config.reasoningBudget !== undefined) {
        body.reasoning_budget = config.reasoningBudget;
      }
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
