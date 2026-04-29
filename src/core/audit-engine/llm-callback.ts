// KCode - LLM callback for audit verification
//
// Minimal HTTP client that routes a single verification prompt to either
// an Anthropic-style or OpenAI-compatible endpoint (llama.cpp, Ollama,
// vLLM, OpenAI). No streaming, no tools, no history — just ask and parse.
//
// This is deliberately simple: the audit verifier calls it once per
// candidate with a narrow, structured prompt.

import type { KCodeConfig } from "../types";

export interface AuditLlmOptions {
  model: string;
  /** Optional. When omitted, resolved by model-name prefix below. */
  apiBase?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  /** Optional ~/.kcode/settings.json fields. Used to resolve a
   *  provider-specific apiKey (anthropicApiKey / xaiApiKey / kimiApiKey
   *  / groqApiKey / deepseekApiKey / togetherApiKey) when `apiKey` is
   *  not passed explicitly. */
  settings?: Record<string, string | undefined>;
}

/**
 * Resolve the API base URL for a given model by name prefix. Used as
 * the default route when callers don't pass an explicit apiBase. The
 * mapping covers the providers KCode officially supports for verifier
 * + audit work; everything else falls through to OpenAI-compatible.
 *
 * Synced with cloud-fallback.ts and the model registry — model names
 * here are CANONICAL prefixes; vendor model IDs (`claude-sonnet-4-6`,
 * `grok-4-fast-reasoning`, `kimi-k2.6`, etc.) all match by prefix.
 *
 * v2.10.405. Closes the bug where `kcode audit -m claude-sonnet-4-6`
 * (without --api-base) routed to whatever default the CLI guessed
 * from the global apiKey setting — typically OpenAI when a
 * dashboard `sk-proj-...` key was saved, leading to 429 quota
 * errors and verdict=needs_context for every finding.
 */
export function resolveApiBaseByModel(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith("claude")) return "https://api.anthropic.com/v1";
  if (m.startsWith("grok")) return "https://api.x.ai/v1";
  if (m.startsWith("kimi") || m.startsWith("moonshot")) return "https://api.moonshot.ai/v1";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3"))
    return "https://api.openai.com/v1";
  if (m.startsWith("deepseek")) return "https://api.deepseek.com/v1";
  if (m.startsWith("llama") || m.startsWith("mixtral")) return "https://api.groq.com/openai/v1";
  // Local models (mark7, mnemo:, etc.) and unrecognised names fall to
  // localhost — works for the dev fleet, breaks loudly for everything
  // else (which is the right failure mode: tell the user to register
  // the model or pass --api-base).
  return "http://localhost:10091";
}

/**
 * Resolve an API key for a given baseUrl + model, reading both env
 * vars (always win) and the per-provider settings.json fields. Used
 * when the caller doesn't pass an explicit apiKey. v2.10.405.
 *
 * Settings shape: `~/.kcode/settings.json` has separate fields per
 * provider — `anthropicApiKey`, `xaiApiKey`, `kimiApiKey`,
 * `groqApiKey`, `deepseekApiKey`, `togetherApiKey`. The generic
 * `apiKey` field is reserved for the OpenAI dashboard key.
 */
function resolveApiKeyForBase(
  baseUrl: string,
  settings: Record<string, string | undefined> = {},
): string {
  const url = baseUrl.toLowerCase();
  if (url.includes("anthropic.com"))
    return process.env.ANTHROPIC_API_KEY ?? settings.anthropicApiKey ?? "";
  if (url.includes("api.x.ai")) return process.env.XAI_API_KEY ?? settings.xaiApiKey ?? "";
  if (url.includes("moonshot")) return process.env.MOONSHOT_API_KEY ?? settings.kimiApiKey ?? "";
  if (url.includes("groq.com")) return process.env.GROQ_API_KEY ?? settings.groqApiKey ?? "";
  if (url.includes("deepseek.com"))
    return process.env.DEEPSEEK_API_KEY ?? settings.deepseekApiKey ?? "";
  if (url.includes("together.xyz"))
    return process.env.TOGETHER_API_KEY ?? settings.togetherApiKey ?? "";
  if (url.includes("openai.com")) return process.env.OPENAI_API_KEY ?? settings.apiKey ?? "";
  // Local / unknown — no API key needed (or caller passes it explicitly)
  return "";
}

/**
 * Build a callback that sends ONE prompt to the configured LLM and
 * returns its response text. Works with Anthropic-native or OpenAI-
 * compatible endpoints (llama.cpp, Ollama, vLLM, OpenAI).
 *
 * When `apiBase` is omitted, resolved by model-name prefix via
 * `resolveApiBaseByModel`. v2.10.405 — closes the bug where the CLI
 * sent claude-/grok-/kimi- model names to OpenAI's chat-completions
 * endpoint when `settings.apiKey` happened to be an OpenAI key.
 */
export function makeAuditLlmCallback(opts: AuditLlmOptions): (prompt: string) => Promise<string> {
  const model = opts.model;
  const apiBase = opts.apiBase ?? resolveApiBaseByModel(model);
  const apiKey =
    opts.apiKey ?? resolveApiKeyForBase(apiBase, opts.settings) ?? process.env.KCODE_API_KEY ?? "";
  // Bumped to 4096 in v2.10.311 — reasoning models like mark7 / qwen-r1
  // / deepseek-r1 spend most of their budget on internal reasoning
  // tokens before producing the final VERDICT line. At 1024 the
  // content field came back empty because the model was still mid-
  // reasoning when truncated.
  const maxTokens = opts.maxTokens ?? 4096;
  const temperature = opts.temperature ?? 0.1;

  const isAnthropic = apiBase.includes("anthropic.com") || /\bclaude\b/i.test(model);
  // Anthropic deprecated `temperature` for opus-4-7 and newer reasoning
  // models — passing it returns HTTP 400 invalid_request_error and
  // every candidate buckets as needs_context. v2.10.405. Detect by
  // model name (opus-4-7+, sonnet-4-7+, opus-5+) and omit the field.
  const skipTemperature =
    isAnthropic && /\b(?:opus-4-[7-9]|opus-[5-9]|sonnet-4-[7-9]|sonnet-[5-9])\b/i.test(model);
  const isOAuthToken = apiKey.startsWith("sk-ant-oat01-");

  // Trace line for the audit benchmarks: confirms which provider is
  // actually being hit. Suppressed in tests / when KCODE_QUIET is set.
  if (!process.env.KCODE_QUIET && !process.env.NODE_TEST_CONTEXT) {
    const keyHint = apiKey ? `${apiKey.slice(0, 8)}…` : "<none>";
    process.stderr.write(`[Verifier] ${model} → ${apiBase} (key: ${keyHint})\n`);
  }

  return async (prompt: string): Promise<string> => {
    // Retry wrapper for 429 rate limits
    const fetchWithRetry = async (
      url: string,
      init: RequestInit,
      maxRetries = 3,
    ): Promise<Response> => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const res = await fetch(url, init);
        if (res.status === 429 && attempt < maxRetries) {
          const retryAfter = parseInt(res.headers.get("retry-after") ?? "5", 10);
          const delay = Math.min(retryAfter * 1000, 15000) * (attempt + 1);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        return res;
      }
      return fetch(url, init); // final attempt
    };

    if (isAnthropic) {
      // OAuth tokens (sk-ant-oat01-*) use Bearer auth + beta header
      // API keys (sk-ant-api03-*) use x-api-key
      const authHeaders: Record<string, string> = isOAuthToken
        ? {
            Authorization: `Bearer ${apiKey}`,
            "anthropic-beta": "oauth-2025-04-20,prompt-caching-2024-07-31",
            "x-app": "cli",
          }
        : { "x-api-key": apiKey };

      const res = await fetchWithRetry(`${apiBase.replace(/\/$/, "")}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          ...(skipTemperature ? {} : { temperature }),
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
      return data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
    }
    // OpenAI-compatible (local or cloud)
    const res = await fetchWithRetry(`${apiBase.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
    // Some local models (mark7, qwen-thinking, deepseek-r1) split their
    // output into `content` (final answer) and `reasoning_content`
    // (chain-of-thought). When max_tokens caps inside the reasoning
    // phase, content stays empty but the verdict often appears in
    // reasoning_content. Fall back to reasoning_content so the
    // verifier doesn't bucket every candidate as needs_context with
    // an empty reasoning string. v2.10.311 fix.
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string; reasoning_content?: string } }>;
    };
    const msg = data.choices[0]?.message;
    const content = msg?.content ?? "";
    if (content.trim().length > 0) return content;
    const reasoning = msg?.reasoning_content ?? "";
    return reasoning;
  };
}

/**
 * Resolve an audit LLM callback from a KCodeConfig (same model the
 * conversation is using). Used when invoking the audit engine from
 * within the running TUI session (via /scan).
 *
 * v2.10.311 fix: previously this fell back to "http://localhost:10091/v1"
 * when cfg.apiBase was unset, but the conversation actually resolves
 * the URL from ~/.kcode/models.json (per-model baseUrl). For local
 * models like mark7 on port 8090, the audit callback hit a dead
 * 10091 endpoint and bucketed every candidate as needs_context with
 * "Verification failed: Unable to connect" — invisible to the user
 * because the bucket label said "verifier couldn't decide".
 *
 * Now resolves via getModelBaseUrl(modelName) which consults the
 * registry first, falling back to env / defaults only when missing.
 */
export async function buildAuditLlmCallbackFromConfigAsync(
  cfg: KCodeConfig,
): Promise<(prompt: string) => Promise<string>> {
  const model = cfg.model ?? "claude-opus-4-6";
  const { getModelBaseUrl } = await import("../models.js");
  const resolvedBase = await getModelBaseUrl(model, cfg.apiBase);
  // Models registry stores root URL (e.g. "http://localhost:8090");
  // makeAuditLlmCallback expects /v1 suffix for OpenAI-style routing.
  // Avoid double-/v1 when callers already include it.
  const apiBase = /\/v\d+\/?$/.test(resolvedBase) ? resolvedBase : `${resolvedBase}/v1`;
  return makeAuditLlmCallback({
    model,
    apiBase,
    apiKey: cfg.apiKey,
  });
}

/**
 * Sync version preserved for callers that can't be made async right
 * now. Uses the registry only when KCodeConfig.apiBase is unset, but
 * skips the disk read so it's fast. Prefer the async version when
 * possible.
 */
export function buildAuditLlmCallbackFromConfig(
  cfg: KCodeConfig,
): (prompt: string) => Promise<string> {
  return makeAuditLlmCallback({
    model: cfg.model ?? "claude-opus-4-6",
    apiBase: cfg.apiBase ?? "http://localhost:10091/v1",
    apiKey: cfg.apiKey,
  });
}
