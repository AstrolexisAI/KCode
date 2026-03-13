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
import { readFileSync } from "node:fs";
import { getModelBaseUrl } from "./models";
import { routeToModel } from "./router";
import { ToolRegistry } from "./tool-registry";
import { SystemPromptBuilder } from "./system-prompt";
import { PermissionManager } from "./permissions";
import { HookManager } from "./hooks";
import { RateLimiter } from "./rate-limiter";
import { UndoManager } from "./undo";
import { TranscriptManager } from "./transcript";
import { log } from "./logger";
import { getWorldModel } from "./world-model";
import { getUserModel } from "./user-model";
import { getIntentionEngine } from "./intentions";
import type { Suggestion } from "./intentions";

// ─── Constants ───────────────────────────────────────────────────

const DEFAULT_CONTEXT_WINDOW = 32_000;
const CONTEXT_WINDOW_MARGIN = 0.2; // prune when we reach 80% of context window
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8000;
const MAX_AGENT_TURNS = 50; // prevent infinite loops
const MAX_CONSECUTIVE_DENIALS = 2; // stop after N permission denials in a row

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
  private rateLimiter: RateLimiter;
  private undoManager: UndoManager;
  private transcript: TranscriptManager;
  private abortController: AbortController | null = null;
  private turnsSincePromptRebuild = 0;

  constructor(config: KCodeConfig, tools: ToolRegistry) {
    this.config = config;
    this.tools = tools;
    this.systemPrompt = SystemPromptBuilder.build(config, config.version);
    this.contextWindowSize = config.contextWindowSize ?? DEFAULT_CONTEXT_WINDOW;
    this.maxRetries = config.maxRetries ?? MAX_RETRIES;
    this.permissions = new PermissionManager(config.permissionMode, config.workingDirectory);
    this.hooks = new HookManager(config.workingDirectory);
    this.rateLimiter = new RateLimiter(
      config.rateLimit?.maxPerMinute ?? 60,
      config.rateLimit?.maxConcurrent ?? 2,
    );
    this.undoManager = new UndoManager();
    this.transcript = new TranscriptManager();
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

  /** Access the undo manager (e.g., for /undo command). */
  getUndo(): UndoManager {
    return this.undoManager;
  }

  /** Abort the current LLM request / agent loop. */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      log.info("session", "Request aborted by user");
    }
  }

  /** Whether a request is currently in progress. */
  get isRunning(): boolean {
    return this.abortController !== null;
  }

  /**
   * Send a user message and get back an async generator of StreamEvents.
   * The generator runs the full agent loop: streaming response, tool execution, repeat.
   */
  async *sendMessage(userMessage: string): AsyncGenerator<StreamEvent> {
    // Start transcript session on first message
    if (!this.transcript.isActive) {
      this.transcript.startSession(userMessage);
    } else {
      this.transcript.append("user", "user_message", userMessage);
    }

    this.state.messages.push({
      role: "user",
      content: userMessage,
    });

    // Layer 7: Update user model from message signals
    try { getUserModel().updateFromMessage(userMessage); } catch { /* ignore */ }

    // Layer 9: Reset intention engine for new turn
    try { getIntentionEngine().reset(); } catch { /* ignore */ }

    // Wrap the agent loop to record events to transcript
    for await (const event of this.runAgentLoop()) {
      this.recordTranscriptEvent(event);
      yield event;
    }
  }

  private recordTranscriptEvent(event: StreamEvent): void {
    switch (event.type) {
      case "text_delta":
        // Text deltas are accumulated — we record the final text in turn_end via messages
        break;
      case "thinking_delta":
        break;
      case "tool_executing":
        this.transcript.append("assistant", "tool_use", JSON.stringify({
          id: event.toolUseId,
          name: event.name,
          input: event.input,
        }));
        break;
      case "tool_result":
        this.transcript.append("tool", "tool_result", JSON.stringify({
          tool_use_id: event.toolUseId,
          name: event.name,
          content: event.result.slice(0, 2000),
          is_error: event.isError,
        }));
        break;
      case "error":
        this.transcript.append("system", "error", event.error.message);
        break;
      case "turn_end": {
        // Record the final assistant text from the last message
        const lastMsg = this.state.messages[this.state.messages.length - 1];
        if (lastMsg?.role === "assistant" && Array.isArray(lastMsg.content)) {
          for (const block of lastMsg.content) {
            if (block.type === "text") {
              this.transcript.append("assistant", "assistant_text", block.text);
            } else if (block.type === "thinking") {
              this.transcript.append("assistant", "thinking", block.thinking);
            }
          }
        }
        break;
      }
    }
  }

  /**
   * Agent loop: stream a response from the LLM, collect tool calls, execute them, and loop.
   * Stops when the LLM's finish_reason is "stop" or there are no tool calls.
   */
  private async *runAgentLoop(): AsyncGenerator<StreamEvent> {
    this.abortController = new AbortController();
    let turnCount = 0;
    let consecutiveDenials = 0;

    while (true) {
      turnCount++;

      // Periodically rebuild system prompt (includes dynamic data like git status, user model)
      this.turnsSincePromptRebuild++;
      if (this.turnsSincePromptRebuild >= 5) {
        this.systemPrompt = SystemPromptBuilder.build(this.config, this.config.version);
        this.turnsSincePromptRebuild = 0;
      }

      if (turnCount > MAX_AGENT_TURNS) {
        log.warn("session", `Agent loop exceeded ${MAX_AGENT_TURNS} turns, stopping`);
        yield { type: "turn_end", stopReason: "max_turns" };
        this.abortController = null;
        return;
      }
      // Check if aborted
      if (this.abortController?.signal.aborted) {
        yield { type: "turn_end", stopReason: "aborted" };
        this.abortController = null;
        return;
      }

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
        await this.rateLimiter.acquire();
        sseStream = await this.createStreamWithRetry();
      } catch (error) {
        this.rateLimiter.release();
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
      } finally {
        this.rateLimiter.release();
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
            if (fullJson.length > 50000) {
              parsedInput = { _raw: `[truncated: ${fullJson.length} chars of malformed JSON]` };
              log.warn("llm", `Truncated malformed tool args: ${fullJson.length} chars`);
            } else {
              parsedInput = { _raw: fullJson };
            }
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
        // Layer 9: Evaluate intentions and emit suggestions
        let hasHighPrioritySuggestion = false;
        try {
          const suggestions = getIntentionEngine().evaluate();
          if (suggestions.length > 0) {
            yield { type: "suggestion", suggestions };
            // Check if any high-priority suggestion indicates incomplete work
            hasHighPrioritySuggestion = suggestions.some(s => s.priority === "high" && s.type === "verify");
          }
        } catch { /* ignore */ }

        // Auto-continue: if the model stopped but has incomplete tasks, push it to continue
        if (hasHighPrioritySuggestion && turnCount <= 3) {
          log.info("session", "Auto-continuing: model stopped with incomplete tasks");
          this.state.messages.push({
            role: "user",
            content: "You stopped before completing the task. Continue working — create the actual files and finish what you planned. Do not re-plan, just execute.",
          });
          // Don't break — loop continues to next turn
          yield { type: "turn_end", stopReason };
          continue;
        }

        yield { type: "turn_end", stopReason };
        this.abortController = null;
        break;
      }

      // Check abort between tool calls
      if (this.abortController?.signal.aborted) {
        yield { type: "turn_end", stopReason: "aborted" };
        this.abortController = null;
        return;
      }

      // Execute tool calls with permission checks and hooks
      const toolResultBlocks: ContentBlock[] = [];
      let turnHadDenial = false;

      // Dedup: track executed tool signatures to skip identical calls in same batch
      const executedSigs = new Map<string, number>(); // sig -> count executed

      for (const call of toolCalls) {
        this.state.toolUseCount++;

        // 0. Dedup identical tool calls within same response
        const dedupKey = call.name === "Bash"
          ? String((call.input as Record<string, unknown>).command ?? "").slice(0, 120)
          : String((call.input as Record<string, unknown>).file_path ?? (call.input as Record<string, unknown>).pattern ?? (call.input as Record<string, unknown>).query ?? JSON.stringify(call.input).slice(0, 120));
        const sig = `${call.name}:${dedupKey}`;
        const prevCount = executedSigs.get(sig) ?? 0;
        executedSigs.set(sig, prevCount + 1);

        if (prevCount >= 2) {
          const skipMsg = `BLOCKED: You already called ${call.name} with these exact parameters ${prevCount + 1} times in this response. You are in an infinite loop. STOP calling this tool and do something different.`;
          log.warn("tool", `Dedup blocked: ${sig.slice(0, 80)} (attempt ${prevCount + 1})`);
          yield { type: "tool_result", name: call.name, toolUseId: call.id, result: skipMsg, isError: true };
          toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: skipMsg, is_error: true });
          continue;
        }

        // 1. Check permissions before executing
        const permResult = await this.permissions.checkPermission(call);
        if (!permResult.allowed) {
          turnHadDenial = true;
          const deniedContent = `Permission denied: ${permResult.reason ?? "blocked by permission system"}. STOP: Do not retry this tool. Inform the user that permission mode needs to be changed (use -p auto) or approve in interactive mode.`;
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

        // 3. Capture undo snapshot for file-modifying tools
        let undoSnapshot: import("./undo").FileSnapshot | null = null;
        if ((call.name === "Edit" || call.name === "Write") && typeof effectiveInput.file_path === "string") {
          undoSnapshot = this.undoManager.captureSnapshot(effectiveInput.file_path as string);
        }

        // 4. Layer 6: World Model — predict outcome before executing
        let prediction: { action: string; expected: string; confidence: number } | null = null;
        try { prediction = getWorldModel().predict(call.name, effectiveInput); } catch { /* ignore */ }

        // Execute the tool
        yield {
          type: "tool_executing",
          name: call.name,
          toolUseId: call.id,
          input: effectiveInput,
        };

        let result = await this.tools.execute(call.name, effectiveInput);

        // Layer 6: Compare prediction with actual result
        try { if (prediction) getWorldModel().compare(prediction, result.content, result.is_error); } catch { /* ignore */ }

        // Layer 9: Record action for post-task evaluation
        try { getIntentionEngine().recordAction(call.name, effectiveInput, result.content, result.is_error); } catch { /* ignore */ }

        // LSP: notify file change and append diagnostics to result
        if (!result.is_error && (call.name === "Write" || call.name === "Edit")) {
          try {
            const { getLspManager } = await import("./lsp.js");
            const lsp = getLspManager();
            if (lsp?.isActive()) {
              const filePath = String(effectiveInput.file_path ?? "");
              if (filePath) {
                const { readFileSync } = await import("node:fs");
                const content = readFileSync(filePath, "utf-8");
                lsp.notifyFileChanged(filePath, content);
                await new Promise(r => setTimeout(r, 500));
                const diagMsg = lsp.formatDiagnosticsForFile(filePath);
                if (diagMsg) {
                  result = { ...result, content: result.content + "\n\n" + diagMsg };
                }
              }
            }
          } catch { /* LSP not available, ignore */ }
        }

        // Record undo action if snapshot was captured and tool succeeded
        if (undoSnapshot && !result.is_error) {
          const desc = call.name === "Edit"
            ? `Edit ${effectiveInput.file_path}`
            : `Write ${effectiveInput.file_path}`;
          this.undoManager.pushAction(call.name, [undoSnapshot], desc);
        }

        yield {
          type: "tool_result",
          name: call.name,
          toolUseId: call.id,
          result: result.content,
          isError: result.is_error,
        };

        // Truncate large tool results to protect context window
        // ~4 chars per token, leave room for other messages
        const maxResultChars = Math.floor(this.contextWindowSize * 1.5);
        let contextContent = result.content;
        if (contextContent.length > maxResultChars) {
          contextContent = contextContent.slice(0, maxResultChars)
            + `\n\n... [truncated: result was ${result.content.length} chars, showing first ${maxResultChars}]`;
          log.warn("tool", `Truncated ${call.name} result from ${result.content.length} to ${maxResultChars} chars`);
        }

        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: contextContent,
          is_error: result.is_error,
        });

        // 5. Run PostToolUse hooks (for logging/notification, non-blocking)
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

      // Layer 9: Inline warning — detect wasted context mid-loop
      try {
        const inlineWarning = getIntentionEngine().getInlineWarning();
        if (inlineWarning) {
          log.warn("intentions", `Inline warning: ${inlineWarning.slice(0, 100)}`);
          this.state.messages.push({
            role: "user",
            content: `⚠️ SYSTEM WARNING: ${inlineWarning}`,
          });
        }
      } catch { /* ignore */ }

      // Track consecutive permission denials to prevent infinite loops
      if (turnHadDenial) {
        consecutiveDenials++;

        // In deny mode, ALL tools will be denied — stop immediately after first attempt
        if (this.config.permissionMode === "deny") {
          log.info("session", "Deny mode: stopping agent loop after first denial");
          this.state.messages.push({
            role: "user",
            content: "[SYSTEM] Permission mode is 'deny'. All tools are blocked. Do NOT attempt any tool calls. Reply with text only, explaining that you cannot perform this action because all tools are blocked. Suggest using -p auto or -p ask.",
          });
          // Allow one more turn for the text response, then hard stop
          consecutiveDenials = MAX_CONSECUTIVE_DENIALS - 1;
        } else if (consecutiveDenials >= MAX_CONSECUTIVE_DENIALS) {
          log.warn("session", `${MAX_CONSECUTIVE_DENIALS} consecutive permission denials, stopping agent loop`);
          yield { type: "turn_end", stopReason: "permission_denied" };
          this.abortController = null;
          return;
        } else {
          // Non-deny modes: inject guidance after first denial
          this.state.messages.push({
            role: "user",
            content: "[SYSTEM] Tool call was denied by the permission system. Do NOT retry the same tool. Reply with a text message explaining what happened.",
          });
        }
      } else {
        consecutiveDenials = 0;
      }

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
        // Auto-route to a better model if enabled and user didn't explicitly set one
        let effectiveModel = this.config.model;
        if (this.config.autoRoute !== false && !this.config.modelExplicitlySet) {
          const recentText = this.getRecentMessageText();
          effectiveModel = await routeToModel(this.config.model, recentText);
        }

        const apiBase = await getModelBaseUrl(effectiveModel, this.config.apiBase);
        const url = `${apiBase}/v1/chat/completions`;
        const requestStart = Date.now();

        const openAIMessages = convertToOpenAIMessages(
          this.systemPrompt,
          this.state.messages,
        );
        const openAITools = convertToOpenAITools(this.tools.getDefinitions());

        const body: Record<string, unknown> = {
          model: effectiveModel,
          messages: openAIMessages,
          max_tokens: this.config.maxTokens,
          stream: true,
        };

        // Only include tools if we have any
        if (openAITools.length > 0) {
          body.tools = openAITools;
        }

        // Add JSON schema response format if configured
        if (this.config.jsonSchema) {
          try {
            const schema = this.config.jsonSchema.startsWith("{")
              ? JSON.parse(this.config.jsonSchema)
              : JSON.parse(readFileSync(this.config.jsonSchema, "utf-8"));
            // llama.cpp supports json_schema in grammar form, OpenAI uses response_format
            // Try the OpenAI-compatible format first; llama.cpp also accepts it in newer versions
            body.response_format = { type: "json_object" };
            // Pass schema via the json_schema field (works with vLLM, newer llama.cpp)
            body.json_schema = schema;
          } catch (e) {
            log.warn("llm", `Invalid JSON schema, ignoring: ${e}`);
          }
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        // Add auth header if an API key is configured (not required for local LLMs)
        if (this.config.apiKey) {
          headers["Authorization"] = `Bearer ${this.config.apiKey}`;
        }

        log.info("llm", `Request to ${effectiveModel} at ${url} (${openAIMessages.length} messages)`);

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: this.abortController?.signal,
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

        log.debug("llm", `Stream opened in ${Date.now() - requestStart}ms`);
        return parseSSEStream(response);
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error(String(error));

        if (attempt < this.maxRetries && isRetryableError(error)) {
          const delay = computeRetryDelay(attempt);
          log.warn("llm", `Retryable error (attempt ${attempt + 1}/${this.maxRetries}), retrying in ${delay}ms`, lastError);
          await sleep(delay);
          continue;
        }

        log.error("llm", `Request failed: ${lastError.message}`, lastError);
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
    // Use the higher of: tracked token count or estimated from message content
    const estimatedTokens = this.estimateContextTokens();
    const effectiveCount = Math.max(this.state.tokenCount, estimatedTokens);
    const threshold = this.contextWindowSize * (1 - CONTEXT_WINDOW_MARGIN);
    if (effectiveCount < threshold) {
      return;
    }

    const messages = this.state.messages;
    if (messages.length <= 4) {
      return;
    }

    log.info("session", `Context pruning triggered: ~${estimatedTokens} tokens, threshold ${Math.floor(threshold)}`);

    // Phase 1: Compress large tool results in older messages (keep last 6 messages intact)
    const compressibleEnd = Math.max(0, messages.length - 6);
    let compressed = 0;
    for (let i = 0; i < compressibleEnd; i++) {
      const msg = messages[i];
      if (Array.isArray(msg.content)) {
        for (let j = 0; j < msg.content.length; j++) {
          const block = msg.content[j];
          if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > 500) {
            // Summarize tool results: keep first line + truncate
            const firstLine = block.content.split("\n")[0].slice(0, 200);
            const wasError = block.is_error ? " (error)" : "";
            msg.content[j] = {
              ...block,
              content: `[Compressed] ${firstLine}${wasError} (was ${block.content.length} chars)`,
            };
            compressed++;
          }
        }
      }
    }

    if (compressed > 0) {
      log.info("session", `Compressed ${compressed} tool results`);
    }

    // Re-check after compression
    const postCompressTokens = this.estimateContextTokens();
    if (postCompressTokens < threshold) {
      this.state.tokenCount = postCompressTokens;
      return;
    }

    // Phase 2: Drop old messages if still over threshold
    const keepFirst = 1;
    const keepLast = 6;

    if (messages.length <= keepFirst + keepLast) {
      return;
    }

    const pruneCount = Math.min(
      Math.floor((messages.length - keepFirst - keepLast) / 2) * 2,
      messages.length - keepFirst - keepLast,
    );

    if (pruneCount > 0) {
      messages.splice(keepFirst, pruneCount);
      this.state.tokenCount = this.estimateContextTokens();
      log.info("session", `Pruned ${pruneCount} old messages, ~${this.state.tokenCount} tokens remaining`);
    }
  }

  /** Rough estimate of current context size in tokens from message content. */
  private estimateContextTokens(): number {
    let chars = this.systemPrompt.length;
    for (const msg of this.state.messages) {
      if (typeof msg.content === "string") {
        chars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") chars += block.text.length;
          else if (block.type === "tool_result") {
            chars += typeof block.content === "string" ? block.content.length : 100;
          } else if (block.type === "tool_use") {
            chars += JSON.stringify(block.input).length;
          }
        }
      }
    }
    return Math.ceil(chars / 4); // ~4 chars per token
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

  // ─── Router Helpers ────────────────────────────────────────────

  /**
   * Extract text from recent messages for routing heuristics.
   * Looks at the last few messages (user + tool results) to detect content type.
   */
  private getRecentMessageText(): string {
    const parts: string[] = [];
    // Check the last 4 messages (enough to catch recent tool results)
    const recent = this.state.messages.slice(-4);
    for (const msg of recent) {
      if (typeof msg.content === "string") {
        parts.push(msg.content);
      } else {
        for (const block of msg.content) {
          if (block.type === "text") {
            parts.push(block.text);
          } else if (block.type === "tool_result") {
            if (typeof block.content === "string") {
              parts.push(block.content);
            } else {
              for (const sub of block.content) {
                if (sub.type === "text") {
                  parts.push(sub.text);
                }
              }
            }
          }
        }
      }
    }
    return parts.join("\n");
  }

  // ─── State Access ───────────────────────────────────────────────

  getState(): ConversationState {
    return { ...this.state };
  }

  getUsage(): TokenUsage {
    return { ...this.cumulativeUsage };
  }

  /**
   * Restore messages from a previous session (for --continue).
   * Sets the message history and estimates token count from content length.
   */
  restoreMessages(messages: Message[]): void {
    this.state.messages = [...messages];
    // Rough token estimate: ~4 chars per token
    let totalChars = 0;
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        totalChars += msg.content.length;
      } else {
        for (const block of msg.content) {
          if (block.type === "text") {
            totalChars += block.text.length;
          } else if (block.type === "thinking") {
            totalChars += block.thinking.length;
          } else if (block.type === "tool_use") {
            totalChars += JSON.stringify(block.input).length;
          } else if (block.type === "tool_result") {
            totalChars += typeof block.content === "string"
              ? block.content.length
              : JSON.stringify(block.content).length;
          }
        }
      }
    }
    this.state.tokenCount = Math.ceil(totalChars / 4);
  }

  /**
   * Collect session data for the narrative system (Layer 10).
   */
  collectSessionData(): {
    project: string;
    messagesCount: number;
    toolsUsed: string[];
    actionsCount: number;
    topicsDiscussed: string[];
    errorsEncountered: number;
    filesModified: string[];
  } {
    const toolsUsed: string[] = [];
    const filesModified: string[] = [];
    let errorsEncountered = 0;

    for (const msg of this.state.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            toolsUsed.push(block.name);
            if (block.name === "Write" || block.name === "Edit") {
              const fp = String((block.input as any)?.file_path ?? "");
              if (fp && !filesModified.includes(fp)) filesModified.push(fp);
            }
          }
          if (block.type === "tool_result" && block.is_error) {
            errorsEncountered++;
          }
        }
      }
    }

    return {
      project: this.config.workingDirectory,
      messagesCount: this.state.messages.length,
      toolsUsed,
      actionsCount: this.state.toolUseCount,
      topicsDiscussed: [],
      errorsEncountered,
      filesModified,
    };
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
