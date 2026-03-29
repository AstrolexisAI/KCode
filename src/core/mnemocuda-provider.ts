// KCode - MnemoCUDA Provider
// Adapts KCode's OpenAI-compatible chat format to MnemoCUDA's
// custom /v1/completions endpoint with expert streaming support.
//
// MnemoCUDA uses a simpler completions API:
//   POST /v1/completions { prompt, max_tokens, temperature, stream }
//   Response: SSE with { token, done } or JSON { text, tokens, tok_per_sec }
//
// This provider translates:
//   - Chat messages → single prompt string (ChatML format)
//   - OpenAI SSE chunks → MnemoCUDA SSE chunks
//   - Tool definitions → inline instructions (MnemoCUDA has no native tool support)

import type { KCodeConfig } from "./types";

/**
 * Check if a base URL points to a MnemoCUDA server.
 * Uses the /status endpoint which is MnemoCUDA-specific.
 */
export async function isMnemoCudaServer(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json() as Record<string, unknown>;
    // MnemoCUDA /status returns fields like cache_slots, expert counts
    return typeof data.cache_slots === "number" || typeof data.resident_mb === "number";
  } catch {
    return false;
  }
}

/**
 * Check if the MnemoCUDA server is ready (not busy with another request).
 */
export async function isMnemoCudaReady(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json() as Record<string, unknown>;
    return data.status === "ready";
  } catch {
    return false;
  }
}

/**
 * Convert chat messages to a single prompt string in ChatML format.
 * MnemoCUDA expects raw text, not structured messages.
 */
export function chatMessagesToPrompt(
  systemPrompt: string,
  messages: Array<{ role: string; content: unknown }>,
): string {
  const parts: string[] = [];

  // System prompt
  if (systemPrompt) {
    parts.push(`<|im_start|>system\n${systemPrompt}<|im_end|>`);
  }

  // Messages
  for (const msg of messages) {
    const role = msg.role;
    let content = "";

    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Extract text from content blocks
      content = (msg.content as Array<{ type: string; text?: string; content?: string }>)
        .filter(b => b.type === "text")
        .map(b => b.text ?? b.content ?? "")
        .join("\n");

      // For tool use blocks, format as text
      const toolUses = (msg.content as Array<{ type: string; name?: string; input?: unknown }>)
        .filter(b => b.type === "tool_use");
      if (toolUses.length > 0) {
        const toolText = toolUses
          .map(t => `[Tool: ${t.name}] ${JSON.stringify(t.input)}`)
          .join("\n");
        content = content ? `${content}\n${toolText}` : toolText;
      }

      // For tool results, format as text
      const toolResults = (msg.content as Array<{ type: string; content?: string; is_error?: boolean }>)
        .filter(b => b.type === "tool_result");
      if (toolResults.length > 0) {
        const resultText = toolResults
          .map(r => `[Result${r.is_error ? " (error)" : ""}] ${r.content ?? ""}`)
          .join("\n");
        content = content ? `${content}\n${resultText}` : resultText;
      }
    }

    if (content) {
      parts.push(`<|im_start|>${role}\n${content}<|im_end|>`);
    }
  }

  // Prompt the assistant to respond
  parts.push("<|im_start|>assistant\n");

  return parts.join("\n");
}

/**
 * Build a MnemoCUDA-compatible request from KCode's chat request.
 */
export function buildMnemoCudaRequest(
  baseUrl: string,
  systemPrompt: string,
  messages: Array<{ role: string; content: unknown }>,
  maxTokens: number,
  temperature?: number,
  apiKey?: string,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const prompt = chatMessagesToPrompt(systemPrompt, messages);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  return {
    url: `${baseUrl}/v1/completions`,
    headers,
    body: {
      prompt,
      max_tokens: Math.min(maxTokens, 32768), // MnemoCUDA cap
      temperature: temperature ?? 0.7,
      stream: true,
      raw_prompt: true, // We already formatted ChatML
    },
  };
}

/**
 * Parse MnemoCUDA's SSE stream into KCode's SSEChunk format.
 * Converts { token, done } → SSEChunk { type: "content_delta", content }
 */
export async function* parseMnemoCudaStream(
  response: Response,
): AsyncGenerator<{ type: string; content?: string; finishReason?: string; promptTokens?: number; completionTokens?: number }> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let tokenCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();

        if (data === "[DONE]") {
          yield {
            type: "finish",
            finishReason: "stop",
            promptTokens: 0,
            completionTokens: tokenCount,
          };
          return;
        }

        try {
          const chunk = JSON.parse(data) as { token?: string; done?: boolean };

          if (chunk.token) {
            tokenCount++;
            // MnemoCUDA token post-processing:
            // \u0010 (DLE) = space separator between tokens
            // \uFFFD (�) = newline in some quantizations
            let text = chunk.token;
            text = text.replace(/\u0010/g, " ");
            text = text.replace(/\uFFFD/g, "\n");
            yield { type: "content_delta", content: text };
          }

          if (chunk.done) {
            yield {
              type: "finish",
              finishReason: "stop",
              promptTokens: 0,
              completionTokens: tokenCount,
            };
            return;
          }
        } catch {
          // Skip unparseable lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
