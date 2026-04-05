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

  return async (prompt: string): Promise<string> => {
    if (isAnthropic) {
      const res = await fetch(`${apiBase.replace(/\/$/, "")}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
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
    const res = await fetch(`${apiBase.replace(/\/$/, "")}/chat/completions`, {
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
