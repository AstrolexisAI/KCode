// KCode - Request Builder
// Extracted from conversation.ts — handles API request construction for LLM providers

import { readFileSync } from "node:fs";
import { getDebugTracer } from "./debug-tracer";
import { log } from "./logger";
import {
  convertToAnthropicMessages,
  convertToAnthropicTools,
  convertToOpenAIMessages,
  convertToOpenAITools,
} from "./message-converters";
import type { ModelProvider } from "./models";
import { getModelBaseUrl, getModelProvider } from "./models";
import { parseAnthropicSSEStream, parseSSEStream, type SSEChunk } from "./sse-parser";
import type { ToolRegistry } from "./tool-registry";
import type { KCodeConfig, Message } from "./types";

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

export interface RateLimitError extends Error {
  retryAfterMs: number;
  isRateLimit: true;
  /** Last known 5-hour utilization (0.0-1.0), if available */
  fiveHourUtilization?: number;
  /** Server says don't retry (subscription hard limit) */
  shouldNotRetry?: boolean;
  /** Which limit was hit: "five_hour" | "seven_day" | "seven_day_opus" */
  representativeClaim?: string;
  /** Unix ms when the rate limit resets */
  resetAtMs?: number;
}

export function isRateLimitError(err: unknown): err is RateLimitError {
  return err instanceof Error && (err as RateLimitError).isRateLimit === true;
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
  if (profileFilter) defs = defs.filter((d) => profileFilter(d.name));
  if (defs.length === 0) return 0;
  const totalChars = defs.reduce((sum, d) => {
    return (
      sum +
      d.name.length +
      (d.description?.length ?? 0) +
      JSON.stringify(d.input_schema ?? {}).length +
      50
    ); // 50 chars overhead per tool (keys, formatting)
  }, 0);
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

// ─── API Key Resolution ──────────────────────────────────────────

/**
 * Detect which OAuth provider name corresponds to a model/url combination.
 * Returns the provider key used in PROVIDER_CONFIGS, or null for non-OAuth providers.
 */
function detectOAuthProvider(modelName: string, baseUrl: string): string | null {
  const lower = modelName.toLowerCase();
  const urlLower = baseUrl.toLowerCase();

  if (
    lower.startsWith("gpt-") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    urlLower.includes("openai.com")
  ) {
    return "openai-codex";
  }
  if (
    lower.startsWith("gemini") ||
    urlLower.includes("googleapis.com") ||
    urlLower.includes("generativelanguage")
  ) {
    return "gemini";
  }

  return null;
}

/**
 * Resolve the API key for a model based on its name/baseUrl.
 * Priority: OAuth token (keychain) → provider env var → config.apiKey.
 */
export function resolveApiKey(
  modelName: string,
  baseUrl: string,
  config: KCodeConfig,
): string | undefined {
  // Provider-specific env vars (checked in priority order)
  const lower = modelName.toLowerCase();
  const urlLower = baseUrl.toLowerCase();

  if (
    lower.startsWith("gpt-") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    urlLower.includes("openai.com")
  ) {
    return process.env.OPENAI_API_KEY ?? config.apiKey;
  }
  if (
    lower.startsWith("gemini") ||
    urlLower.includes("googleapis.com") ||
    urlLower.includes("generativelanguage")
  ) {
    return process.env.GEMINI_API_KEY ?? config.geminiApiKey ?? config.apiKey;
  }
  if (urlLower.includes("groq.com")) {
    return process.env.GROQ_API_KEY ?? config.groqApiKey ?? config.apiKey;
  }
  if (lower.startsWith("deepseek") || urlLower.includes("deepseek.com")) {
    return process.env.DEEPSEEK_API_KEY ?? config.deepseekApiKey ?? config.apiKey;
  }
  if (urlLower.includes("together.xyz")) {
    return process.env.TOGETHER_API_KEY ?? config.togetherApiKey ?? config.apiKey;
  }
  if (lower.startsWith("grok") || urlLower.includes("x.ai")) {
    return process.env.XAI_API_KEY ?? config.xaiApiKey ?? config.apiKey;
  }

  return config.apiKey;
}

/**
 * Resolve API key with OAuth token fallback.
 * Tries OAuth token from keychain first, then falls back to resolveApiKey().
 * This is async because it may need to refresh an expired OAuth token.
 */
async function resolveApiKeyWithOAuth(
  modelName: string,
  baseUrl: string,
  config: KCodeConfig,
): Promise<string | undefined> {
  const lower = modelName.toLowerCase();
  const isAnthropic = lower.startsWith("claude") || baseUrl.includes("anthropic.com");
  const isOpenAI =
    lower.startsWith("gpt-") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    baseUrl.includes("openai.com");

  // 1. CLI bridges: reuse existing authentication
  // For Anthropic: prefer bridge token (subscription) over API key (pay-per-token, may run out)
  // For OpenAI: prefer direct API key over Codex bridge (restricted scopes)
  if (isAnthropic) {
    try {
      const { getClaudeCodeToken } = await import("./auth/claude-code-bridge.js");
      const token = await getClaudeCodeToken();
      if (token) return token;
    } catch {
      /* not available */
    }

    const directKey = config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
    if (directKey) return directKey;
  }

  if (isOpenAI) {
    // Prefer user's own OPENAI_API_KEY over Codex bridge token — the bridge
    // token may have restricted scopes (e.g. missing model.request for gpt-4o)
    const directKey = process.env.OPENAI_API_KEY ?? config.apiKey;
    if (directKey) return directKey;

    try {
      const { getCodexToken } = await import("./auth/claude-code-bridge.js");
      const token = await getCodexToken();
      if (token) return token;
    } catch {
      /* not available */
    }
  }

  // 2. KCode's own OAuth sessions (keychain)
  const oauthProvider = detectOAuthProvider(modelName, baseUrl);
  if (oauthProvider) {
    try {
      const { getAuthSessionManager } = await import("./auth/session.js");
      const { resolveProviderConfig } = await import("./auth/oauth-flow.js");
      const manager = getAuthSessionManager();
      const providerConfig = resolveProviderConfig(oauthProvider);
      const token = await manager.getAccessToken(oauthProvider, providerConfig ?? undefined);
      if (token) return token;
    } catch {
      /* not available */
    }
  }

  // 3. KCode keychain API key
  if (isAnthropic) {
    try {
      const { getApiKey } = await import("./auth/oauth-flow.js");
      const keychainKey = await getApiKey("anthropic");
      if (keychainKey) return keychainKey;
    } catch {
      /* not available */
    }
  }

  return resolveApiKey(modelName, baseUrl, config);
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

  // Agent pool injection: conditionally append a short "Active Agent
  // Pool" fragment to the system prompt so the model can reference
  // agents by name.
  //
  // Caching note (fixes M1 from the branch self-audit):
  //   Anthropic (and some OpenAI-compatible) prompt caching keys on
  //   the system prompt prefix. Appending the pool fragment changes
  //   the suffix on every turn while agents are running, which
  //   invalidates the cache and drives up cost/latency. To minimize
  //   cache misses, we ONLY inject the fragment when either:
  //     1. The last user message explicitly mentions agents, OR
  //     2. An agent was spawned within the last 2 minutes (recent
  //        activity window where the user is likely iterating).
  //   Otherwise the fragment is skipped and the system prompt stays
  //   identical to a no-agent turn — cache hit preserved.
  try {
    const { getAgentPool } = await import("./agents/pool.js");
    const { buildAgentSystemPromptFragment } = await import("./agents/narrative.js");
    const pool = getAgentPool();
    const status = pool.getStatus();
    if (status.active.length > 0 || status.queued.length > 0) {
      // Find the last user message by iterating backwards — O(n)
      // in the worst case but avoids cloning the whole array via
      // [...messages].reverse().find() which was the previous
      // implementation. In long conversations (100+ messages)
      // the clone cost dominated request-build time for a field
      // that's only used here.
      let lastText = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role === "user" && typeof m.content === "string") {
          lastText = m.content;
          break;
        }
      }
      const mentionsAgents = /\b(agent|agente|worker|bot|grupo|group|team|swarm)\b/i.test(
        lastText,
      );
      const RECENT_SPAWN_WINDOW_MS = 2 * 60 * 1000;
      const now = Date.now();
      const hasRecentSpawn = status.active.some(
        (a) => now - a.startedAt < RECENT_SPAWN_WINDOW_MS,
      );
      if (mentionsAgents || hasRecentSpawn) {
        const fragment = buildAgentSystemPromptFragment(status);
        if (fragment) {
          systemPrompt = systemPrompt + "\n\n" + fragment;
        }
      }
    }
  } catch {
    // Agent pool module failed to load — continue without the fragment.
  }

  const tracer = getDebugTracer();
  if (tracer.isEnabled()) {
    const resolvedKey =
      provider === "anthropic"
        ? config.anthropicApiKey
          ? "anthropic-key"
          : config.apiKey
            ? "config-key"
            : "none"
        : resolveApiKey(modelName, apiBase, config)
          ? "resolved"
          : "none";
    tracer.trace(
      "model",
      `Build request: ${modelName}`,
      `Provider: ${provider}, base: ${apiBase}, effort: ${effort}, key: ${resolvedKey}`,
      { provider, apiBase, effort, maxTokens: opts?.maxTokens ?? config.maxTokens },
    );
  }

  // Reasoning models (OpenAI o1/o3/o4, xAI Grok reasoning variants,
  // DeepSeek Reasoner, Claude thinking mode) burn a LARGE number of
  // tokens on internal chain-of-thought BEFORE emitting the final
  // output. A "medium" effort budget of 16K can easily be consumed
  // entirely by reasoning, leaving nothing for the visible response —
  // the model returns an empty completion.
  //
  // Detect these by name prefix/substring and guarantee a floor of
  // 32K tokens so there's always room for output after reasoning.
  const lowerModel = modelName.toLowerCase();
  const isReasoningModel =
    lowerModel.startsWith("o1") ||
    lowerModel.startsWith("o3") ||
    lowerModel.startsWith("o4") ||
    lowerModel.includes("reasoning") ||
    lowerModel.includes("reasoner") ||
    lowerModel === "grok-3-mini" ||
    lowerModel.startsWith("grok-3-mini") ||
    lowerModel === "grok-4.20" ||
    lowerModel === "grok-4.20-latest";

  let effortMaxTokens =
    effort === "low"
      ? Math.min(maxTokens, 4096)
      : effort === "max"
        ? Math.max(maxTokens, 65536)
        : effort === "high"
          ? Math.max(maxTokens, 32768)
          : maxTokens;

  // Reasoning floor: at least 32K for any reasoning model, 64K on high/max.
  if (isReasoningModel) {
    const reasoningFloor = effort === "high" || effort === "max" ? 65536 : 32768;
    if (effortMaxTokens < reasoningFloor) {
      effortMaxTokens = reasoningFloor;
    }
  }
  const effortTemperature =
    effort === "low" ? 0.3 : effort === "max" ? 0.9 : effort === "high" ? 0.7 : undefined;

  // Model profile: filter tools and adjust temperature for small models
  let profileToolFilter: ((name: string) => boolean) | null = null;
  let profileTemperature: number | undefined;
  try {
    const { getModelProfile, isToolAllowedForProfile } =
      require("./model-profile") as typeof import("./model-profile");
    const profile = getModelProfile(modelName);
    if (profile.tools !== "all") {
      profileToolFilter = (name: string) => isToolAllowedForProfile(name, profile);
    }
    if (profile.temperature !== null && !effortTemperature) {
      profileTemperature = profile.temperature;
    }
  } catch {
    /* module not loaded */
  }

  // Tool budget cap: local models can't handle 47 tools (27K tokens).
  // Cloud APIs: reduce if tools > 15% of context. Local: always use essentials.
  const contextWindow = config.contextWindowSize ?? 32_000;
  const isLocalModel =
    apiBase.includes("localhost") ||
    apiBase.includes("127.0.0.1") ||
    apiBase.startsWith("http://[::1]");
  const toolOverhead = estimateToolDefinitionTokens(tools, profileToolFilter ?? undefined);
  if ((isLocalModel || toolOverhead > contextWindow * 0.15) && !profileToolFilter) {
    const ESSENTIAL_TOOLS = new Set([
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Bash",
      "Glob",
      "Grep",
      "GrepReplace",
      "LS",
    ]);
    profileToolFilter = (name: string) => ESSENTIAL_TOOLS.has(name);
    log.info(
      "llm",
      `Tool budget cap: ${isLocalModel ? "local model" : `${toolOverhead} tok > 15%`}. Reduced to ${ESSENTIAL_TOOLS.size} essential tools.`,
    );
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (provider === "anthropic") {
    // Anthropic API: /v1/messages
    const url = `${apiBase}/v1/messages`;
    // Priority: OAuth/Claude Code token (subscription) → config key → env var
    const resolvedKey =
      (await resolveApiKeyWithOAuth(modelName, apiBase, config)) ??
      config.anthropicApiKey ??
      config.apiKey;
    if (resolvedKey) {
      // OAuth tokens (sk-ant-oat01-*) use Bearer auth + beta header → subscription billing
      // API keys (sk-ant-api03-*) use x-api-key → per-token billing
      if (resolvedKey.startsWith("sk-ant-oat01-")) {
        headers["Authorization"] = `Bearer ${resolvedKey}`;
        headers["anthropic-beta"] = "oauth-2025-04-20";
        // Subscriber context headers — matches what Claude Code CLI sends
        // so Anthropic backend applies subscriber-tier rate limits
        headers["x-app"] = "cli";
        headers["User-Agent"] = `kcode-cli/${config.version ?? "0.0.0"}`;
      } else {
        headers["x-api-key"] = resolvedKey;
      }
    }
    headers["anthropic-version"] = "2023-06-01";
    // Enable prompt caching beta (cache_control on system/message blocks)
    const betaParts = [headers["anthropic-beta"], "prompt-caching-2024-07-31"].filter(Boolean);
    headers["anthropic-beta"] = betaParts.join(",");

    const convertedMessages = convertToAnthropicMessages(messages);

    // Prompt caching: wrap system prompt in a block with cache_control
    // so Anthropic reuses cached tokenization across turns (~15-20K tokens saved)
    const systemBlocks = [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ];

    // Add cache_control to the last user text message for conversation prefix caching.
    // Only applies to text blocks — tool_result blocks don't support cache_control.
    for (let i = convertedMessages.length - 1; i >= 0; i--) {
      const msg = convertedMessages[i]!;
      if (msg.role !== "user") continue;
      if (typeof msg.content === "string") {
        msg.content = [
          { type: "text", text: msg.content, cache_control: { type: "ephemeral" } },
        ];
        break;
      }
      if (Array.isArray(msg.content)) {
        // Find the last text block in this message
        for (let j = msg.content.length - 1; j >= 0; j--) {
          if (msg.content[j]!.type === "text") {
            msg.content[j]!.cache_control = { type: "ephemeral" };
            break;
          }
        }
        break;
      }
    }

    const body: Record<string, unknown> = {
      model: modelName,
      messages: convertedMessages,
      system: systemBlocks,
      max_tokens: effortMaxTokens,
      stream: true,
    };

    if (effortTemperature !== undefined) {
      body.temperature = effortTemperature;
    }

    if (includeTools) {
      let defs = tools.getDefinitions();
      if (profileToolFilter) defs = defs.filter((d) => profileToolFilter!(d.name));
      const toolDefs = convertToAnthropicTools(defs);
      if (toolDefs.length > 0) body.tools = toolDefs;
    }

    return { url, headers, body, provider, parser: parseAnthropicSSEStream };
  } else {
    // OpenAI-compatible API: /v1/chat/completions with Bearer token
    const url = `${apiBase}/v1/chat/completions`;
    // Resolve API key: OAuth token → provider env var → config.apiKey
    const resolvedKey = await resolveApiKeyWithOAuth(modelName, apiBase, config);
    if (resolvedKey) {
      headers["Authorization"] = `Bearer ${resolvedKey}`;
    }

    const convertedMessages = convertToOpenAIMessages(systemPrompt, messages);
    let filteredDefs = tools.getDefinitions();
    if (profileToolFilter) filteredDefs = filteredDefs.filter((d) => profileToolFilter!(d.name));
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

    // The reasoning_effort parameter is only supported by OpenAI's
    // o-series models (o1, o3, o4). xAI supports it for some models
    // (grok-3-mini accepts it) but rejects it for others
    // (grok-4.20-0309-reasoning returns 400 "does not support parameter
    // reasoningEffort"). Rather than maintain a per-model allowlist,
    // we skip the parameter entirely for xAI and rely on the
    // max_tokens floor (32K for reasoning models) to prevent the
    // empty-response bug.
    //
    // For OpenAI o-series, reasoning_effort IS documented and stable,
    // so we map KCode's effort level to the provider's field.
    const apiBaseLower = apiBase.toLowerCase();
    const supportsReasoningEffort =
      isReasoningModel &&
      apiBaseLower.includes("openai.com") &&
      (lowerModel.startsWith("o1") ||
        lowerModel.startsWith("o3") ||
        lowerModel.startsWith("o4"));
    if (supportsReasoningEffort) {
      const reasoningEffort =
        effort === "low" ? "low" : effort === "high" || effort === "max" ? "high" : "medium";
      body.reasoning_effort = reasoningEffort;
    }

    if (toolDefs.length > 0) body.tools = toolDefs;

    // Adaptive thinking: only enable when the prompt needs reasoning.
    // llama.cpp shares max_tokens between thinking + response — simple prompts
    // like "hola" get starved if thinking is always on.
    if (config.thinking) {
      const lastUserMsg = messages.filter((m) => m.role === "user").pop();
      const userText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";

      const { classifyTask } = await import("./router.js");
      const { looksTheoretical } = await import("./prompt-analysis.js");
      const taskType = classifyTask(userText);
      const needsThinking =
        taskType === "code" || taskType === "reasoning" || looksTheoretical(userText);

      if (needsThinking) {
        body.chat_template_kwargs = { enable_thinking: true };
        if (config.reasoningBudget !== undefined) {
          body.reasoning_budget = config.reasoningBudget;
        }
        body.max_tokens = effortMaxTokens * 2;
        log.info("llm", `Thinking ON (${taskType}): max_tokens=${body.max_tokens}`);
      } else {
        body.chat_template_kwargs = { enable_thinking: false };
        log.info("llm", `Thinking OFF (${taskType}): simple prompt, saving tokens`);
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

  // Pre-flight safety: if serialized request exceeds 95% of context window, strip tools
  if (config.contextWindowSize) {
    const bodyStr = JSON.stringify(req.body);
    const estimatedTokens = Math.ceil(bodyStr.length / CHARS_PER_TOKEN);
    if (estimatedTokens > config.contextWindowSize * 0.95) {
      log.warn(
        "llm",
        `Pre-flight: ~${estimatedTokens} tokens > 95% of ${config.contextWindowSize}. Stripping tools to fit.`,
      );
      delete req.body.tools;
    }
  }

  // Log message structure at debug level for diagnosing tool_use/tool_result pairing
  if (log.isDebugEnabled?.()) {
    const msgs = Array.isArray(req.body.messages) ? req.body.messages as Array<{role: string; content: unknown}> : [];
    const summary = msgs.map((m, i) => {
      if (typeof m.content === "string") return `${i}:${m.role}(text)`;
      if (Array.isArray(m.content)) {
        const types = (m.content as Array<{type: string}>).map(b => b.type).join(",");
        return `${i}:${m.role}[${types}]`;
      }
      return `${i}:${m.role}(?)`;
    });
    log.debug("llm", `Messages(${msgs.length}): ${summary.join(" | ")}`);
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
    const msgCount = Array.isArray(req.body.messages) ? req.body.messages.length : "?";
    const bodyLen = JSON.stringify(req.body).length;
    const estimatedTokens = Math.round(bodyLen / 4);
    log.warn(
      "llm",
      `Request failed ${response.status}: ${msgCount} messages, ${bodyLen} bytes (~${estimatedTokens} tokens)${errorText ? `, server: ${errorText.slice(0, 200)}` : ""}`,
    );

    // Provide actionable hint for common errors
    let hint = "";
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const retrySeconds = retryAfter ? parseInt(retryAfter) || 30 : 30;
      const resetHeader = response.headers.get("anthropic-ratelimit-unified-reset");
      let resetInfo = "";
      if (resetHeader) {
        const resetMs = Number(resetHeader) * 1000 - Date.now();
        if (resetMs > 0) {
          const mins = Math.ceil(resetMs / 60_000);
          resetInfo = mins > 1 ? ` Resets in ~${mins} minutes.` : " Resets in ~1 minute.";
        }
      }

      // Check x-should-retry header — Anthropic tells us if retrying will help
      const shouldRetryHeader = response.headers.get("x-should-retry");
      const shouldNotRetry = shouldRetryHeader === "false";
      const representativeClaim = response.headers.get("anthropic-ratelimit-unified-representative-claim") ?? undefined;

      // Calculate exact reset time from Anthropic's unified reset header
      let resetAtMs: number | undefined;
      if (resetHeader) {
        const ts = Number(resetHeader) * 1000;
        if (ts > Date.now()) resetAtMs = ts;
      }

      // If server says don't retry (subscription hard limit), fail fast with clear message
      if (shouldNotRetry) {
        const resetMsg = resetAtMs
          ? ` Resets in ~${Math.ceil((resetAtMs - Date.now()) / 60_000)} minutes.`
          : resetInfo;
        const limitType = representativeClaim === "seven_day" ? " (7-day limit)" :
          representativeClaim === "five_hour" ? " (5-hour limit)" :
          representativeClaim === "seven_day_opus" ? " (7-day Opus limit)" : "";
        const err = new Error(
          `Rate limit reached${limitType}.${resetMsg} Switch to a smaller model with /model.`,
        );
        (err as RateLimitError).retryAfterMs = retrySeconds * 1000;
        (err as RateLimitError).isRateLimit = true;
        (err as RateLimitError).shouldNotRetry = true;
        (err as RateLimitError).representativeClaim = representativeClaim;
        (err as RateLimitError).resetAtMs = resetAtMs;
        updateRateLimitUsage(response.headers);
        throw err;
      }

      // Retryable 429: create error with backoff info
      const err = new Error(
        `Rate limit reached (429). Retrying in ${retrySeconds}s...${resetInfo}`,
      );
      (err as RateLimitError).retryAfterMs = retrySeconds * 1000;
      (err as RateLimitError).isRateLimit = true;
      (err as RateLimitError).shouldNotRetry = false;
      (err as RateLimitError).representativeClaim = representativeClaim;
      (err as RateLimitError).resetAtMs = resetAtMs;
      // Capture utilization: prefer 429 response headers, fall back to last known
      const utilHeader = response.headers.get("anthropic-ratelimit-unified-5h-utilization");
      (err as RateLimitError).fiveHourUtilization = utilHeader
        ? Number(utilHeader)
        : (_rateLimitUsage?.fiveHour ?? undefined);
      // Also update tracking from 429 headers (Anthropic sends them on 429 too)
      updateRateLimitUsage(response.headers);
      throw err;
    } else {
      // Classify error and provide actionable hint
      const errLower = errorText.toLowerCase();
      if (errLower.includes("credit") || errLower.includes("balance") || errLower.includes("billing") || errLower.includes("payment") || response.status === 402) {
        hint = " (hint: check your API billing/credits at the provider's dashboard)";
      } else if (response.status === 401 || response.status === 403 || errLower.includes("missing_scope") || errLower.includes("unauthorized")) {
        hint = " (hint: check API key permissions — ensure it has the required scopes)";
      } else if (response.status === 400 && (errLower.includes("too long") || errLower.includes("too many tokens") || errLower.includes("context") || errLower.includes("maximum"))) {
        hint = " (hint: request may exceed model context window — try /compact or reduce conversation length)";
      }
    }
    throw new Error(
      `API request failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}${hint}`,
    );
  }

  if (!response.body) {
    throw new Error("Response body is null - streaming not supported");
  }

  // Track subscription rate limit utilization from response headers
  updateRateLimitUsage(response.headers);

  return req.parser(response);
}

// ─── Subscription Rate Limit Usage Tracking ──────────────────────

export interface RateLimitUsage {
  /** 5-hour window utilization (0.0-1.0) */
  fiveHour: number;
  /** 7-day window utilization (0.0-1.0) */
  sevenDay: number;
  /** Unix timestamp (ms) when 5h window resets */
  fiveHourReset: number;
  /** Unix timestamp (ms) when 7d window resets */
  sevenDayReset: number;
  /** Overall status: allowed, allowed_warning, rejected */
  status: string;
  /** Which limit is most relevant */
  representative: string;
  /** Last updated timestamp */
  updatedAt: number;
}

let _rateLimitUsage: RateLimitUsage | null = null;

function updateRateLimitUsage(headers: Headers): void {
  const fiveH = headers.get("anthropic-ratelimit-unified-5h-utilization");
  const sevenD = headers.get("anthropic-ratelimit-unified-7d-utilization");
  if (!fiveH && !sevenD) return; // Not a subscription response

  _rateLimitUsage = {
    fiveHour: fiveH ? Number(fiveH) : (_rateLimitUsage?.fiveHour ?? 0),
    sevenDay: sevenD ? Number(sevenD) : (_rateLimitUsage?.sevenDay ?? 0),
    fiveHourReset: Number(headers.get("anthropic-ratelimit-unified-5h-reset") ?? "0") * 1000,
    sevenDayReset: Number(headers.get("anthropic-ratelimit-unified-7d-reset") ?? "0") * 1000,
    status: headers.get("anthropic-ratelimit-unified-status") ?? "unknown",
    representative: headers.get("anthropic-ratelimit-unified-representative-claim") ?? "",
    updatedAt: Date.now(),
  };
}

/** Get current rate limit usage (null if no subscription data yet) */
export function getRateLimitUsage(): RateLimitUsage | null {
  return _rateLimitUsage;
}

/** Format rate limit usage as a visual bar for display */
export function formatRateLimitBar(usage: RateLimitUsage): string {
  const barWidth = 20;
  const pct5h = Math.min(Math.round(usage.fiveHour * 100), 100);
  const pct7d = Math.min(Math.round(usage.sevenDay * 100), 100);
  const filled5h = Math.round((pct5h / 100) * barWidth);
  const filled7d = Math.round((pct7d / 100) * barWidth);
  const bar5h = "\u2588".repeat(filled5h) + "\u2591".repeat(barWidth - filled5h);
  const bar7d = "\u2588".repeat(filled7d) + "\u2591".repeat(barWidth - filled7d);

  const now = Date.now();
  const reset5h =
    usage.fiveHourReset > now
      ? `resets in ${Math.ceil((usage.fiveHourReset - now) / 60_000)}m`
      : "";
  const reset7d =
    usage.sevenDayReset > now
      ? `resets in ${Math.ceil((usage.sevenDayReset - now) / 3_600_000)}h`
      : "";

  return [
    `  Subscription Usage`,
    ``,
    `  5-hour  ${bar5h}  ${pct5h}%${reset5h ? `  (${reset5h})` : ""}`,
    `  7-day   ${bar7d}  ${pct7d}%${reset7d ? `  (${reset7d})` : ""}`,
  ].join("\n");
}
