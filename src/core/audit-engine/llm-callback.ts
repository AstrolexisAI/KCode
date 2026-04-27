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
  apiBase: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Build a callback that sends ONE prompt to the configured LLM and
 * returns its response text. Works with Anthropic-native or OpenAI-
 * compatible endpoints (llama.cpp, Ollama, vLLM, OpenAI).
 */
export function makeAuditLlmCallback(opts: AuditLlmOptions): (prompt: string) => Promise<string> {
  const { model, apiBase } = opts;
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.KCODE_API_KEY ?? "";
  // Bumped to 4096 in v2.10.311 — reasoning models like mark7 / qwen-r1
  // / deepseek-r1 spend most of their budget on internal reasoning
  // tokens before producing the final VERDICT line. At 1024 the
  // content field came back empty because the model was still mid-
  // reasoning when truncated.
  const maxTokens = opts.maxTokens ?? 4096;
  const temperature = opts.temperature ?? 0.1;

  const isAnthropic = apiBase.includes("anthropic.com") || /\bclaude\b/i.test(model);
  const isOAuthToken = apiKey.startsWith("sk-ant-oat01-");

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
          temperature,
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
