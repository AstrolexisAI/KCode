// KCode - Conversation Manager
// Handles the main conversation loop with local LLM API (OpenAI-compatible) using SSE streaming

import type {
  Message,
  ContentBlock,
  ToolUseBlock,
  TextBlock,
  KCodeConfig,
  ConversationState,
  StreamEvent,
  TokenUsage,
  OpenAIMessage,
  OpenAIToolCall,
  OpenAIToolDefinition,
} from "./types";
import { getModelBaseUrl } from "./models";
import { ToolRegistry } from "./tool-registry";
import { SystemPromptBuilder } from "./system-prompt";
import { PermissionManager } from "./permissions";
import { HookManager } from "./hooks";

// ─── Constants ───────────────────────────────────────────────────

const DEFAULT_CONTEXT_WINDOW = 32_000;
const CONTEXT_WINDOW_MARGIN = 0.2; // prune when we reach 80% of context window
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8000;

// ─── Retry Logic ─────────────────────────────────────────────────

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Retry on network errors and common HTTP errors
    if (
      msg.includes("network") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("timeout") ||
      msg.includes("socket") ||
      msg.includes("429") ||
      msg.includes("500") ||
      msg.includes("502") ||
      msg.includes("503")
    ) {
      return true;
    }
  }
  return false;
}

function computeRetryDelay(attempt: number): number {
  // Exponential backoff: 0.5s, 1s, 2s, 4s, 8s capped at MAX_RETRY_DELAY_MS
  const baseDelay = Math.min(
    BASE_RETRY_DELAY_MS * Math.pow(2, attempt),
    MAX_RETRY_DELAY_MS,
  );
  // 75-100% jitter
  const jitter = 0.75 + Math.random() * 0.25;
  return Math.round(baseDelay * jitter);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Message Conversion ─────────────────────────────────────────

/**
 * Convert internal Message[] to OpenAI-compatible message format.
 */
function convertToOpenAIMessages(
  systemPrompt: string,
  messages: Message[],
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  // System message first
  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Complex content blocks
    if (msg.role === "assistant") {
      // Collect text and tool_calls from assistant blocks
      const textParts: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "thinking") {
          // Include thinking as text prefix (local models don't have thinking blocks)
          textParts.push(`<thinking>${block.thinking}</thinking>`);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        }
      }

      const assistantMsg: OpenAIMessage = {
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("\n") : null,
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      result.push(assistantMsg);
    } else if (msg.role === "user") {
      // User messages may contain tool_result blocks
      const textParts: string[] = [];
      const toolResults: OpenAIMessage[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_result") {
          const content =
            typeof block.content === "string"
              ? block.content
              : block.content
                  .map((b) => {
                    if (b.type === "text") return b.text;
                    return JSON.stringify(b);
                  })
                  .join("\n");
          toolResults.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: content,
          });
        }
      }

      // Tool results go as separate "tool" role messages
      for (const tr of toolResults) {
        result.push(tr);
      }

      // Any plain text from the user block
      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("\n") });
      }
    }
  }

  return result;
}

/**
 * Convert tool definitions to OpenAI function-calling format.
 */
function convertToOpenAITools(
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[],
): OpenAIToolDefinition[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// ─── SSE Stream Parser ──────────────────────────────────────────

interface SSEChunk {
  type: "content_delta" | "tool_call_delta" | "finish" | "usage" | "error";
  // content_delta
  content?: string;
  // tool_call_delta
  toolCallIndex?: number;
  toolCallId?: string;
  functionName?: string;
  functionArgDelta?: string;
  // finish
  finishReason?: string;
  // usage
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Parse an SSE stream from the OpenAI-compatible API and yield structured chunks.
 */
async function* parseSSEStream(
  response: Response,
): AsyncGenerator<SSEChunk> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue; // Skip empty lines and comments

        if (trimmed === "data: [DONE]") {
          return;
        }

        if (trimmed.startsWith("data: ")) {
          const jsonStr = trimmed.slice(6);
          let parsed: any;
          try {
            parsed = JSON.parse(jsonStr);
          } catch {
            continue; // Skip malformed JSON
          }

          const choice = parsed.choices?.[0];
          if (!choice) {
            // Check for usage-only messages
            if (parsed.usage) {
              yield {
                type: "usage",
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
              };
            }
            continue;
          }

          const delta = choice.delta;
          const finishReason = choice.finish_reason;

          // Content delta
          if (delta?.content) {
            yield { type: "content_delta", content: delta.content };
          }

          // Tool call deltas
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              yield {
                type: "tool_call_delta",
                toolCallIndex: tc.index ?? 0,
                toolCallId: tc.id ?? undefined,
                functionName: tc.function?.name ?? undefined,
                functionArgDelta: tc.function?.arguments ?? undefined,
              };
            }
          }

          // Finish reason
          if (finishReason) {
            yield { type: "finish", finishReason };
          }

          // Usage in chunk
          if (parsed.usage) {
            yield {
              type: "usage",
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
            };
          }
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
        try {
          const parsed = JSON.parse(trimmed.slice(6));
          if (parsed.usage) {
            yield {
              type: "usage",
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
            };
          }
        } catch {
          // ignore
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Conversation Manager ────────────────────────────────────────

export class ConversationManager {
  private config: KCodeConfig;
  private state: ConversationState;
  private tools: ToolRegistry;
  private systemPrompt: string;
  private contextWindowSize: number;
  private maxRetries: number;
  private cumulativeUsage: TokenUsage;
  private permissions: PermissionManager;
  private hooks: HookManager;

  constructor(config: KCodeConfig, tools: ToolRegistry) {
    this.config = config;
    this.tools = tools;
    this.systemPrompt = SystemPromptBuilder.build(config);
    this.contextWindowSize = config.contextWindowSize ?? DEFAULT_CONTEXT_WINDOW;
    this.maxRetries = config.maxRetries ?? MAX_RETRIES;
    this.permissions = new PermissionManager(config.permissionMode, config.workingDirectory);
    this.hooks = new HookManager(config.workingDirectory);
    this.state = {
      messages: [],
      tokenCount: 0,
      toolUseCount: 0,
    };
    this.cumulativeUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
  }

  /** Access the permission manager (e.g., to set the prompt callback from the UI). */
  getPermissions(): PermissionManager {
    return this.permissions;
  }

  /** Access the hook manager (e.g., to force reload). */
  getHooks(): HookManager {
    return this.hooks;
  }

  /**
   * Send a user message and get back an async generator of StreamEvents.
   * The generator runs the full agent loop: streaming response, tool execution, repeat.
   */
  async *sendMessage(userMessage: string): AsyncGenerator<StreamEvent> {
    this.state.messages.push({
      role: "user",
      content: userMessage,
    });

    yield* this.runAgentLoop();
  }

  /**
   * Agent loop: stream a response from the LLM, collect tool calls, execute them, and loop.
   * Stops when the LLM's finish_reason is "stop" or there are no tool calls.
   */
  private async *runAgentLoop(): AsyncGenerator<StreamEvent> {
    while (true) {
      // Prune context if approaching the limit
      this.pruneMessagesIfNeeded();

      yield { type: "turn_start" };

      const assistantContent: ContentBlock[] = [];
      const toolCalls: ToolUseBlock[] = [];
      let stopReason = "end_turn";

      // Track in-progress tool calls by index
      const activeToolCalls = new Map<
        number,
        { id: string; name: string; argChunks: string[] }
      >();
      let textChunks: string[] = [];

      // Stream the API response with retry logic
      let sseStream: AsyncGenerator<SSEChunk>;
      try {
        sseStream = await this.createStreamWithRetry();
      } catch (error) {
        yield {
          type: "error",
          error: error instanceof Error ? error : new Error(String(error)),
          retryable: false,
        };
        yield { type: "turn_end", stopReason: "error" };
        return;
      }

      try {
        for await (const chunk of sseStream) {
          switch (chunk.type) {
            case "content_delta": {
              if (chunk.content) {
                textChunks.push(chunk.content);
                yield { type: "text_delta", text: chunk.content };
              }
              break;
            }

            case "tool_call_delta": {
              const idx = chunk.toolCallIndex ?? 0;
              let active = activeToolCalls.get(idx);

              // New tool call starting
              if (chunk.toolCallId && chunk.functionName) {
                active = {
                  id: chunk.toolCallId,
                  name: chunk.functionName,
                  argChunks: [],
                };
                activeToolCalls.set(idx, active);
                yield {
                  type: "tool_use_start",
                  toolUseId: chunk.toolCallId,
                  name: chunk.functionName,
                };
              } else if (!active && chunk.toolCallId) {
                // Tool call ID without name yet - create placeholder
                active = {
                  id: chunk.toolCallId,
                  name: "",
                  argChunks: [],
                };
                activeToolCalls.set(idx, active);
              } else if (!active && chunk.functionName) {
                // Name without ID - create with generated ID
                const id = `call_${Date.now()}_${idx}`;
                active = {
                  id,
                  name: chunk.functionName,
                  argChunks: [],
                };
                activeToolCalls.set(idx, active);
                yield {
                  type: "tool_use_start",
                  toolUseId: id,
                  name: chunk.functionName,
                };
              }

              // Update name if it arrives later
              if (active && chunk.functionName && !active.name) {
                active.name = chunk.functionName;
                yield {
                  type: "tool_use_start",
                  toolUseId: active.id,
                  name: active.name,
                };
              }

              // Accumulate argument fragments
              if (active && chunk.functionArgDelta) {
                active.argChunks.push(chunk.functionArgDelta);
                yield {
                  type: "tool_input_delta",
                  toolUseId: active.id,
                  partialJson: chunk.functionArgDelta,
                };
              }
              break;
            }

            case "finish": {
              // Map OpenAI finish reasons to our internal ones
              if (chunk.finishReason === "tool_calls") {
                stopReason = "tool_use";
              } else if (chunk.finishReason === "stop") {
                stopReason = "end_turn";
              } else if (chunk.finishReason === "length") {
                stopReason = "max_tokens";
              } else {
                stopReason = chunk.finishReason ?? "end_turn";
              }
              break;
            }

            case "usage": {
              const usage: TokenUsage = {
                inputTokens: chunk.promptTokens ?? 0,
                outputTokens: chunk.completionTokens ?? 0,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
              };
              this.accumulateUsage(usage);
              yield { type: "usage_update", usage: { ...this.cumulativeUsage } };
              break;
            }
          }
        }
      } catch (error) {
        // Stream-level errors that weren't retried
        yield {
          type: "error",
          error: error instanceof Error ? error : new Error(String(error)),
          retryable: false,
        };
        yield { type: "turn_end", stopReason: "error" };
        return;
      }

      // Finalize text content
      const fullText = textChunks.join("");
      if (fullText.length > 0) {
        assistantContent.push({ type: "text", text: fullText });
      }

      // Finalize tool calls
      for (const [, active] of activeToolCalls) {
        const fullJson = active.argChunks.join("");
        let parsedInput: Record<string, unknown> = {};
        if (fullJson.length > 0) {
          try {
            parsedInput = JSON.parse(fullJson);
          } catch {
            parsedInput = { _raw: fullJson };
          }
        }
        const toolBlock: ToolUseBlock = {
          type: "tool_use",
          id: active.id,
          name: active.name,
          input: parsedInput,
        };
        assistantContent.push(toolBlock);
        toolCalls.push(toolBlock);
      }

      // Store assistant message in conversation history
      this.state.messages.push({
        role: "assistant",
        content: assistantContent,
      });

      // If no tool calls or stop reason is not tool_use, we're done
      if (toolCalls.length === 0 || stopReason !== "tool_use") {
        yield { type: "turn_end", stopReason };
        break;
      }

      // Execute tool calls with permission checks and hooks
      const toolResultBlocks: ContentBlock[] = [];
      for (const call of toolCalls) {
        this.state.toolUseCount++;

        // 1. Check permissions before executing
        const permResult = await this.permissions.checkPermission(call);
        if (!permResult.allowed) {
          const deniedContent = `Permission denied: ${permResult.reason ?? "blocked by permission system"}`;
          yield {
            type: "tool_result",
            name: call.name,
            toolUseId: call.id,
            result: deniedContent,
            isError: true,
          };
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: deniedContent,
            is_error: true,
          });
          continue;
        }

        // 2. Run PreToolUse hooks (may modify input or block)
        let effectiveInput = permResult.updatedInput ?? call.input;
        if (this.hooks.hasHooks("PreToolUse")) {
          const hookResult = await this.hooks.runPreToolUse(call);
          if (!hookResult.allowed) {
            const blockedContent = `Blocked by hook: ${hookResult.reason ?? "PreToolUse hook denied execution"}`;
            yield {
              type: "tool_result",
              name: call.name,
              toolUseId: call.id,
              result: blockedContent,
              isError: true,
            };
            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: blockedContent,
              is_error: true,
            });
            continue;
          }
          if (hookResult.updatedInput) {
            effectiveInput = hookResult.updatedInput;
          }
        }

        // 3. Execute the tool
        yield {
          type: "tool_executing",
          name: call.name,
          toolUseId: call.id,
          input: effectiveInput,
        };

        const result = await this.tools.execute(call.name, effectiveInput);

        yield {
          type: "tool_result",
          name: call.name,
          toolUseId: call.id,
          result: result.content,
          isError: result.is_error,
        };

        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: result.content,
          is_error: result.is_error,
        });

        // 4. Run PostToolUse hooks (for logging/notification, non-blocking)
        if (this.hooks.hasHooks("PostToolUse")) {
          await this.hooks.runPostToolUse(call, {
            tool_use_id: call.id,
            content: result.content,
            is_error: result.is_error,
          });
        }
      }

      this.state.messages.push({
        role: "user",
        content: toolResultBlocks,
      });

      yield { type: "turn_end", stopReason };
      // Loop continues for next agent turn
    }
  }

  /**
   * Create a streaming API call with exponential backoff retry.
   * Returns an async generator of parsed SSE chunks.
   */
  private async createStreamWithRetry(): Promise<AsyncGenerator<SSEChunk>> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const apiBase = await getModelBaseUrl(this.config.model, this.config.apiBase);
        const url = `${apiBase}/v1/chat/completions`;

        const openAIMessages = convertToOpenAIMessages(
          this.systemPrompt,
          this.state.messages,
        );
        const openAITools = convertToOpenAITools(this.tools.getDefinitions());

        const body: Record<string, unknown> = {
          model: this.config.model,
          messages: openAIMessages,
          max_tokens: this.config.maxTokens,
          stream: true,
        };

        // Only include tools if we have any
        if (openAITools.length > 0) {
          body.tools = openAITools;
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        // Add auth header if an API key is configured (not required for local LLMs)
        if (this.config.apiKey) {
          headers["Authorization"] = `Bearer ${this.config.apiKey}`;
        }

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          throw new Error(
            `API request failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
          );
        }

        if (!response.body) {
          throw new Error("Response body is null - streaming not supported");
        }

        return parseSSEStream(response);
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error(String(error));

        if (attempt < this.maxRetries && isRetryableError(error)) {
          const delay = computeRetryDelay(attempt);
          await sleep(delay);
          continue;
        }

        throw lastError;
      }
    }

    throw lastError ?? new Error("Unexpected retry exhaustion");
  }

  // ─── Context Window Management ──────────────────────────────────

  /**
   * Prune older messages when approaching the context window limit.
   * Keeps the system prompt, first user message, and recent messages.
   */
  private pruneMessagesIfNeeded(): void {
    const threshold = this.contextWindowSize * (1 - CONTEXT_WINDOW_MARGIN);
    if (this.state.tokenCount < threshold) {
      return;
    }

    const messages = this.state.messages;
    if (messages.length <= 4) {
      // Too few messages to prune meaningfully
      return;
    }

    // Strategy: remove the oldest non-first messages in pairs (assistant + user)
    // to maintain alternation. Keep at least the first user message and last 4 messages.
    const keepFirst = 1; // first user message
    const keepLast = 4; // recent context

    if (messages.length <= keepFirst + keepLast) {
      return;
    }

    const pruneCount = Math.min(
      Math.floor((messages.length - keepFirst - keepLast) / 2) * 2,
      messages.length - keepFirst - keepLast,
    );

    if (pruneCount > 0) {
      messages.splice(keepFirst, pruneCount);
      // Rough estimate: reduce token count proportionally
      this.state.tokenCount = Math.floor(
        this.state.tokenCount * (messages.length / (messages.length + pruneCount)),
      );
    }
  }

  // ─── Usage Tracking ─────────────────────────────────────────────

  private accumulateUsage(usage: TokenUsage): void {
    this.cumulativeUsage.inputTokens += usage.inputTokens;
    this.cumulativeUsage.outputTokens += usage.outputTokens;
    this.cumulativeUsage.cacheCreationInputTokens += usage.cacheCreationInputTokens;
    this.cumulativeUsage.cacheReadInputTokens += usage.cacheReadInputTokens;

    // Update legacy tokenCount
    this.state.tokenCount =
      this.cumulativeUsage.inputTokens + this.cumulativeUsage.outputTokens;
  }

  // ─── State Access ───────────────────────────────────────────────

  getState(): ConversationState {
    return { ...this.state };
  }

  getUsage(): TokenUsage {
    return { ...this.cumulativeUsage };
  }

  /**
   * Reset conversation state for a new session.
   */
  reset(): void {
    this.state = {
      messages: [],
      tokenCount: 0,
      toolUseCount: 0,
    };
    this.cumulativeUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
  }
}
