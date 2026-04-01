// KCode - Forked Agent Pattern
// Lightweight background LLM call infrastructure for async analysis tasks.
// A "forked agent" receives a snapshot of recent context and executes a specific
// prompt without tools or streaming, running in the background without blocking UI.

import { log } from "./logger";
import type { Message } from "./types";

// ─── Types ──────────────────────────────────────────────────────

export interface ForkedAgentConfig {
  /** Name for logging/telemetry */
  name: string;
  /** System prompt for the fork */
  systemPrompt: string;
  /** Context messages (subset of history) */
  contextMessages: Message[];
  /** User prompt (the specific task) */
  userPrompt: string;
  /** Model to use (default: tertiary/cheap model) */
  model?: string;
  /** Timeout in ms (default: 15000) */
  timeoutMs?: number;
  /** Max response tokens (default: 1500) */
  maxTokens?: number;
  /** Callback on completion */
  onComplete: (result: ForkedAgentResult) => Promise<void>;
  /** Callback on error (silent by default) */
  onError?: (error: Error) => void;
  /** Injected fetch function (for testing) */
  customFetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** API base URL override (for testing) */
  apiBase?: string;
  /** API key override (for testing) */
  apiKey?: string;
}

export interface ForkedAgentResult {
  /** Raw text content from the model */
  content: string;
  /** Model that was used */
  model: string;
  /** Input tokens consumed */
  inputTokens: number;
  /** Output tokens consumed */
  outputTokens: number;
  /** Duration in milliseconds */
  durationMs: number;
}

// ─── Message Simplification ─────────────────────────────────────

const MAX_TOOL_RESULT_LENGTH = 500;

/**
 * Simplify a message for the forked agent context:
 * - Truncate long tool results to MAX_TOOL_RESULT_LENGTH chars
 * - Convert content blocks to simple text where possible
 */
export function simplifyMessage(msg: Message): { role: string; content: string } {
  const role = msg.role;

  if (typeof msg.content === "string") {
    return { role, content: msg.content };
  }

  if (!Array.isArray(msg.content)) {
    return { role, content: String(msg.content ?? "") };
  }

  // Process content blocks
  const parts: string[] = [];
  for (const block of msg.content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool_use") {
      parts.push(`[Tool call: ${b.name}]`);
    } else if (b.type === "tool_result") {
      const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
      const truncated =
        content.length > MAX_TOOL_RESULT_LENGTH
          ? content.slice(0, MAX_TOOL_RESULT_LENGTH) + "... (truncated)"
          : content;
      parts.push(`[Tool result: ${truncated}]`);
    } else {
      // Unknown block type — skip
    }
  }

  return { role, content: parts.join("\n") };
}

// ─── Resolve Model Configuration ────────────────────────────────

interface ResolvedModelConfig {
  url: string;
  apiKey: string;
  model: string;
}

async function resolveModel(config: ForkedAgentConfig): Promise<ResolvedModelConfig> {
  const model = config.model ?? "";

  // Use injected values if provided (testing)
  if (config.apiBase) {
    return {
      url: `${config.apiBase}/v1/chat/completions`,
      apiKey: config.apiKey ?? "",
      model,
    };
  }

  // Try to resolve from model registry
  try {
    const { getModelBaseUrl } = await import("./models.js");
    const baseUrl = await getModelBaseUrl(model);
    return {
      url: `${baseUrl}/v1/chat/completions`,
      apiKey: config.apiKey ?? process.env.KCODE_API_KEY ?? "",
      model,
    };
  } catch {
    // Fallback to env or localhost
    const base = process.env.KCODE_API_BASE ?? "http://localhost:10091";
    return {
      url: `${base}/v1/chat/completions`,
      apiKey: config.apiKey ?? process.env.KCODE_API_KEY ?? "",
      model,
    };
  }
}

// ─── Run Forked Agent ───────────────────────────────────────────

/**
 * Execute a forked agent: a lightweight, non-streaming LLM call in the background.
 *
 * - No tools, no streaming (fast round-trip)
 * - Aggressive timeout (default 15s)
 * - Silent failure by default (does not propagate errors)
 * - Fire-and-forget: call without await to run in background
 */
export async function runForkedAgent(config: ForkedAgentConfig): Promise<void> {
  const timeoutMs = config.timeoutMs ?? 15_000;
  const maxTokens = config.maxTokens ?? 1500;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  const startTime = Date.now();

  try {
    const resolved = await resolveModel(config);

    const messages = [
      { role: "system", content: config.systemPrompt },
      ...config.contextMessages.map(simplifyMessage),
      { role: "user", content: config.userPrompt },
    ];

    const body = {
      model: resolved.model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.3,
      stream: false,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (resolved.apiKey) {
      headers["Authorization"] = `Bearer ${resolved.apiKey}`;
    }

    const fetchFn = config.customFetch ?? globalThis.fetch;
    const response = await fetchFn(resolved.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Forked agent API error: ${response.status} ${response.statusText} ${errorText}`,
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = data.choices?.[0]?.message?.content ?? "";
    const durationMs = Date.now() - startTime;

    const result: ForkedAgentResult = {
      content,
      model: resolved.model,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      durationMs,
    };

    log.debug(
      "forked-agent",
      `${config.name} completed in ${durationMs}ms (${result.inputTokens}+${result.outputTokens} tokens)`,
    );

    await config.onComplete(result);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.debug("forked-agent", `${config.name} failed: ${err.message}`);
    if (config.onError) {
      config.onError(err);
    }
    // Silent failure by default — do not propagate
  } finally {
    clearTimeout(timer);
  }
}
