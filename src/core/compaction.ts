// KCode - Conversation Compaction
//
// STATUS: Auxiliary (see docs/architecture/modules.md).
// Context-window management — the audit engine runs shorter
// turns and doesn't depend on this path. Removable without
// breaking core audit flow.
//
// Summarizes pruned messages via LLM instead of discarding them

import { log } from "./logger.js";
import { getModelBaseUrl, getModelProvider } from "./models.js";
import type { ContentBlock, Message, TextBlock } from "./types.js";

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// ─── Constants ───────────────────────────────────────────────────

const SUMMARY_MAX_TOKENS = 1024;
const SUMMARY_MODEL = "mnemo:mark5"; // Use the local model for summaries
const CIRCUIT_BREAKER_THRESHOLD = 3;

const SUMMARY_SYSTEM_PROMPT =
  "You are a conversation summarizer. Produce a concise summary of the conversation context provided. " +
  "Focus on: key decisions made, files modified, important findings, current task state, and any " +
  "outstanding questions. Be factual and brief. Output only the summary, no preamble.";

// ─── Circuit Breaker State ──────────────────────────────────────

export interface CircuitBreakerState {
  failures: number;
  tripped: boolean;
}

// ─── CompactionManager ──────────────────────────────────────────

export class CompactionManager {
  private apiBase?: string;
  private apiKey?: string;
  private model: string;
  private compactionCount = 0;
  private consecutiveFailures = 0;
  private circuitBreakerTripped = false;
  private customFetch?: FetchFn;

  constructor(apiKey?: string, model?: string, apiBase?: string, customFetch?: FetchFn) {
    if (model) {
      this.model = model;
    } else {
      log.warn(
        "compaction",
        `No model configured for compaction, falling back to hardcoded "${SUMMARY_MODEL}". Configure a model to avoid this.`,
      );
      this.model = SUMMARY_MODEL;
    }
    this.apiKey = apiKey;
    this.apiBase = apiBase; // resolved lazily via getModelBaseUrl if not provided
    this.customFetch = customFetch;
  }

  private async resolveApiBase(): Promise<string> {
    if (this.apiBase) return this.apiBase;
    this.apiBase = await getModelBaseUrl(this.model);
    return this.apiBase;
  }

  /**
   * Compact a set of messages by summarizing them via the LLM.
   * Returns a single system-injected summary message to replace the pruned messages.
   * Falls back to simple pruning (returns null) if the summary call fails.
   * When the circuit breaker is tripped (3 consecutive failures), auto-compaction
   * is disabled for the session and null is returned immediately.
   */
  async compact(messagesToPrune: Message[]): Promise<Message | null> {
    if (messagesToPrune.length === 0) return null;

    if (this.circuitBreakerTripped) {
      return null;
    }

    try {
      const conversationText = this.messagesToText(messagesToPrune);
      const summaryPrompt =
        "Summarize the following conversation context that is being compacted to save space. " +
        "Preserve all important details about what was discussed, decided, and accomplished:\n\n" +
        conversationText;

      const apiBase = await this.resolveApiBase();
      const provider = await getModelProvider(this.model);
      const isAnthropic = provider === "anthropic";

      const url = isAnthropic ? `${apiBase}/v1/messages` : `${apiBase}/v1/chat/completions`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.apiKey) {
        if (isAnthropic) {
          headers["x-api-key"] = this.apiKey;
          headers["anthropic-version"] = "2023-06-01";
        } else {
          headers["Authorization"] = `Bearer ${this.apiKey}`;
        }
      }

      const body = isAnthropic
        ? {
            model: this.model,
            max_tokens: SUMMARY_MAX_TOKENS,
            system: SUMMARY_SYSTEM_PROMPT,
            messages: [{ role: "user", content: summaryPrompt }],
          }
        : {
            model: this.model,
            max_tokens: SUMMARY_MAX_TOKENS,
            messages: [
              { role: "system", content: SUMMARY_SYSTEM_PROMPT },
              { role: "user", content: summaryPrompt },
            ],
          };

      const fetchFn = this.customFetch ?? fetch;
      const response = await fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000), // 60s timeout to prevent hanging
      });

      if (!response.ok) {
        this.recordFailure();
        return null;
      }

      interface CompactionResponse {
        content?: Array<{ text?: string }>;
        choices?: Array<{ message?: { content?: string } }>;
      }
      const data = (await response.json()) as CompactionResponse;
      const summaryText = isAnthropic
        ? data.content?.[0]?.text
        : data.choices?.[0]?.message?.content;
      if (!summaryText || typeof summaryText !== "string") {
        this.recordFailure();
        return null;
      }
      // Cap summary length to prevent context pollution from malformed model output
      const safeSummary =
        summaryText.length > 10_000
          ? summaryText.slice(0, 10_000) + "\n[summary truncated]"
          : summaryText;

      this.consecutiveFailures = 0;
      this.compactionCount++;

      return {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `[Conversation Summary - Compaction #${this.compactionCount}]\n` +
              `The following is a summary of ${messagesToPrune.length} earlier messages ` +
              `that were compacted to save context space:\n\n${safeSummary}`,
          } as TextBlock,
        ],
      };
    } catch {
      this.recordFailure();
      return null;
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && !this.circuitBreakerTripped) {
      this.circuitBreakerTripped = true;
      console.warn(
        `[compaction] Circuit breaker tripped after ${this.consecutiveFailures} consecutive failures. ` +
          `Auto-compaction disabled for this session. Call resetCircuitBreaker() to re-enable.`,
      );
    }
  }

  /**
   * Convert messages to a plain-text representation for summarization.
   */
  private messagesToText(messages: Message[]): string {
    const parts: string[] = [];

    for (const msg of messages) {
      const role = msg.role.toUpperCase();

      if (!msg.content) continue;

      if (typeof msg.content === "string") {
        parts.push(`${role}: ${msg.content}`);
        continue;
      }

      for (const block of msg.content) {
        switch (block.type) {
          case "text":
            parts.push(`${role}: ${block.text}`);
            break;
          case "thinking":
            // Skip thinking blocks in summaries
            break;
          case "tool_use":
            parts.push(
              `${role} [tool_use ${block.name}]: ${JSON.stringify(block.input).slice(0, 200)}`,
            );
            break;
          case "tool_result": {
            const content =
              typeof block.content === "string"
                ? block.content.slice(0, 300)
                : JSON.stringify(block.content).slice(0, 300);
            parts.push(`${role} [tool_result${block.is_error ? " ERROR" : ""}]: ${content}`);
            break;
          }
        }
      }
    }

    return parts.join("\n");
  }

  /**
   * Number of compactions performed this session.
   */
  getCompactionCount(): number {
    return this.compactionCount;
  }

  /**
   * Reset compaction count (e.g., on conversation reset).
   */
  reset(): void {
    this.compactionCount = 0;
  }

  resetCircuitBreaker(): void {
    this.consecutiveFailures = 0;
    this.circuitBreakerTripped = false;
  }

  getCircuitBreakerState(): CircuitBreakerState {
    return {
      failures: this.consecutiveFailures,
      tripped: this.circuitBreakerTripped,
    };
  }
}
