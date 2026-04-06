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
export function makeAuditLlmCallback(
  opts: AuditLlmOptions,
): (prompt: string) => Promise<string> {
  const { model, apiBase } = opts;
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.KCODE_API_KEY ?? "";
  const maxTokens = opts.maxTokens ?? 1024;
  const temperature = opts.temperature ?? 0.1;

  const isAnthropic =
    apiBase.includes("anthropic.com") || /\bclaude\b/i.test(model);
  const isOAuthToken = apiKey.startsWith("sk-ant-oat01-");

  return async (prompt: string): Promise<string> => {
    // Retry wrapper for 429 rate limits
    const fetchWithRetry = async (url: string, init: RequestInit, maxRetries = 3): Promise<Response> => {
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
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message.content ?? "";
  };
}

/**
 * Resolve an audit LLM callback from a KCodeConfig (same model the
 * conversation is using). Used when invoking the audit engine from
 * within the running TUI session (via /scan).
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
