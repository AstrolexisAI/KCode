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
import { extractExample, saveExample } from "./distillation";
import { scoreResponse, saveBenchmark, initBenchmarkSchema } from "./benchmarks";

// ─── Constants ───────────────────────────────────────────────────

const DEFAULT_CONTEXT_WINDOW = 32_000;
const CONTEXT_WINDOW_MARGIN = 0.2; // prune when we reach 80% of context window
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8000;
const MAX_AGENT_TURNS = 25; // prevent infinite loops — 25 tool turns is plenty for any task
const MAX_CONSECUTIVE_DENIALS = 2; // stop after N permission denials in a row
const MAX_OUTPUT_TOKENS_PER_TURN = 4096; // Hard cap on output tokens per API call
const MAX_TOTAL_OUTPUT_TOKENS = 50_000; // Hard cap on total output tokens per agent loop

// ─── Lightweight JSON Schema Validator ───────────────────────────
// Validates basic JSON Schema constraints without pulling in Ajv (~150KB).
// Covers: type, required, properties, enum, minimum, maximum, minLength, maxLength, pattern, items.

function validateJsonSchema(data: unknown, schema: Record<string, unknown>, path = "$"): string[] {
  const errors: string[] = [];

  // type check
  if (schema.type) {
    const schemaType = schema.type as string;
    const actualType = Array.isArray(data) ? "array" : data === null ? "null" : typeof data;
    if (schemaType === "integer") {
      if (typeof data !== "number" || !Number.isInteger(data)) {
        errors.push(`${path}: expected integer, got ${actualType}`);
        return errors;
      }
    } else if (actualType !== schemaType) {
      errors.push(`${path}: expected ${schemaType}, got ${actualType}`);
      return errors;
    }
  }

  // enum
  if (schema.enum && Array.isArray(schema.enum)) {
    if (!(schema.enum as unknown[]).includes(data)) {
      errors.push(`${path}: value must be one of [${(schema.enum as unknown[]).join(", ")}]`);
    }
  }

  // string constraints
  if (typeof data === "string") {
    if (typeof schema.minLength === "number" && data.length < schema.minLength) {
      errors.push(`${path}: string length ${data.length} < minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && data.length > schema.maxLength) {
      errors.push(`${path}: string length ${data.length} > maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string") {
      if (!new RegExp(schema.pattern).test(data)) {
        errors.push(`${path}: string does not match pattern "${schema.pattern}"`);
      }
    }
  }

  // number constraints
  if (typeof data === "number") {
    if (typeof schema.minimum === "number" && data < schema.minimum) {
      errors.push(`${path}: ${data} < minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && data > schema.maximum) {
      errors.push(`${path}: ${data} > maximum ${schema.maximum}`);
    }
  }

  // object constraints
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if (schema.required && Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in obj)) {
          errors.push(`${path}: missing required property "${key}"`);
        }
      }
    }
    if (schema.properties && typeof schema.properties === "object") {
      for (const [key, propSchema] of Object.entries(schema.properties as Record<string, Record<string, unknown>>)) {
        if (key in obj) {
          errors.push(...validateJsonSchema(obj[key], propSchema, `${path}.${key}`));
        }
      }
    }
  }

  // array constraints
  if (Array.isArray(data)) {
    if (typeof schema.minItems === "number" && data.length < schema.minItems) {
      errors.push(`${path}: array length ${data.length} < minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === "number" && data.length > schema.maxItems) {
      errors.push(`${path}: array length ${data.length} > maxItems ${schema.maxItems}`);
    }
    if (schema.items && typeof schema.items === "object") {
      for (let i = 0; i < data.length; i++) {
        errors.push(...validateJsonSchema(data[i], schema.items as Record<string, unknown>, `${path}[${i}]`));
      }
    }
  }

  return errors;
}

// ─── Text-based Tool Call Extraction ─────────────────────────────
// Local models (Qwen, etc.) often emit tool calls as JSON in text content
// instead of using OpenAI's native tool_calls format. This extracts them.

interface ExtractedToolCall {
  name: string;
  input: Record<string, unknown>;
  prefixText: string;
}

function extractToolCallsFromText(text: string, tools: ToolRegistry): ExtractedToolCall[] {
  const results: ExtractedToolCall[] = [];
  const toolDefs = tools.getDefinitions();
  const knownTools = new Set(toolDefs.map((t) => t.name));
  // Case-insensitive lookup: "bash" → "Bash"
  const toolNameMap = new Map(toolDefs.map((t) => [t.name.toLowerCase(), t.name]));
  let match: RegExpExecArray | null;
  let firstMatchIndex = text.length;

  // Pattern 1: ```json\n{"name": "ToolName", "arguments": {...}}\n```
  const codeBlockRe = /```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/g;
  while ((match = codeBlockRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      const rawName = parsed.name ?? parsed.function ?? parsed.tool;
      const toolName = typeof rawName === "string" ? (toolNameMap.get(rawName.toLowerCase()) ?? rawName) : null;
      const args = parsed.arguments ?? parsed.parameters ?? parsed.input ?? {};
      if (toolName && knownTools.has(toolName)) {
        if (match.index < firstMatchIndex) firstMatchIndex = match.index;
        results.push({ name: toolName, input: typeof args === "object" ? args : {}, prefixText: text.slice(0, firstMatchIndex) });
      }
    } catch { /* not valid JSON */ }
  }
  if (results.length > 0) return results;

  // Pattern 2: Raw JSON {"name": "ToolName", "arguments": {...}} anywhere in text
  const rawJsonRe = /\{\s*"(?:name|function|tool)"\s*:\s*"(\w+)"\s*,\s*"(?:arguments|parameters|input)"\s*:\s*(\{[^}]*\})\s*\}/g;
  while ((match = rawJsonRe.exec(text)) !== null) {
    const rawName = match[1];
    const toolName = rawName ? (toolNameMap.get(rawName.toLowerCase()) ?? rawName) : null;
    if (toolName && knownTools.has(toolName)) {
      try {
        const args = JSON.parse(match[2]);
        if (match.index < firstMatchIndex) firstMatchIndex = match.index;
        results.push({ name: toolName, input: typeof args === "object" ? args : {}, prefixText: text.slice(0, firstMatchIndex) });
      } catch { /* bad args JSON */ }
    }
  }
  if (results.length > 0) return results;

  // Pattern 3: Code block containing a shell command — common with small models
  // ```bash\nsome command\n``` or ```\nsome command\n```
  const bashBlockRe = /```(?:bash|sh|shell)?\s*\n([\s\S]*?)\n\s*```/g;
  while ((match = bashBlockRe.exec(text)) !== null) {
    const cmd = match[1].trim();
    // Only extract if it looks like a real command (not multiline explanation)
    if (cmd && !cmd.includes("\n") && cmd.length < 500 && !cmd.startsWith("#") && !cmd.startsWith("//")) {
      if (match.index < firstMatchIndex) firstMatchIndex = match.index;
      results.push({
        name: "Bash",
        input: { command: cmd, description: `Execute: ${cmd.slice(0, 60)}` },
        prefixText: text.slice(0, firstMatchIndex),
      });
    }
  }
  if (results.length > 0) return results;

  // Pattern 4: ToolName "arg1" "arg2" format (Qwen-style)
  // e.g. Bash "mkdir foo" "description" 20000
  for (const def of toolDefs) {
    const namePattern = new RegExp(`(?:^|\\n)\\s*${def.name}\\s+"([^"]+)"`, "g");
    while ((match = namePattern.exec(text)) !== null) {
      const firstArg = match[1];
      if (def.name === "Bash" || def.name === "bash") {
        if (match.index < firstMatchIndex) firstMatchIndex = match.index;
        results.push({
          name: "Bash",
          input: { command: firstArg, description: `Execute: ${firstArg.slice(0, 60)}` },
          prefixText: text.slice(0, firstMatchIndex),
        });
      }
    }
  }

  return results;
}

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
  private compactThreshold: number;
  private abortController: AbortController | null = null;
  private turnsSincePromptRebuild = 0;
  private systemPromptHash = "";
  private sessionStartTime = Date.now();

  constructor(config: KCodeConfig, tools: ToolRegistry) {
    this.config = config;
    this.tools = tools;
    this.systemPrompt = SystemPromptBuilder.build(config, config.version);
    this.systemPromptHash = this.hashString(this.systemPrompt);
    this.contextWindowSize = config.contextWindowSize ?? DEFAULT_CONTEXT_WINDOW;
    this.compactThreshold = config.compactThreshold ?? 0.8;
    this.maxRetries = config.maxRetries ?? MAX_RETRIES;
    this.permissions = new PermissionManager(config.permissionMode, config.workingDirectory, config.additionalDirs);
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

    // Smart context: inject relevant file hints based on the user's query
    try {
      const { getCodebaseIndex } = await import("./codebase-index.js");
      const idx = getCodebaseIndex(this.config.workingDirectory);
      const contextHint = idx.formatRelevantContext(userMessage);
      if (contextHint && this.state.messages.length <= 6) {
        // Only inject on early messages to avoid noise in long conversations
        this.state.messages.push({
          role: "user",
          content: `[SYSTEM CONTEXT] ${contextHint}`,
        });
      }
    } catch { /* non-critical */ }

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
    let inlineWarningCount = 0;
    let forceStopLoop = false; // set by inline warning force-stop; allows one final text turn then breaks
    const turnStartMs = Date.now();
    const crossTurnSigs = new Map<string, number>(); // track identical tool calls across turns

    while (true) {
      // Hard break after force-stop allowed one final text turn
      if (forceStopLoop) {
        log.warn("session", "Force-stop: breaking agent loop after final text turn");
        yield { type: "turn_end", stopReason: "force_stop" };
        this.abortController = null;
        return;
      }

      turnCount++;

      // Periodically rebuild system prompt (includes dynamic data like git status, user model)
      // Uses hash-based caching to skip rebuild if nothing changed
      this.turnsSincePromptRebuild++;
      if (this.turnsSincePromptRebuild >= 5) {
        const candidate = SystemPromptBuilder.build(this.config, this.config.version);
        const candidateHash = this.hashString(candidate);
        if (candidateHash !== this.systemPromptHash) {
          this.systemPrompt = candidate;
          this.systemPromptHash = candidateHash;
          log.info("session", "System prompt rebuilt (content changed)");
        }
        this.turnsSincePromptRebuild = 0;
      }

      if (turnCount > MAX_AGENT_TURNS + 1) {
        // Hard kill — model ignored the stop instruction, break immediately
        log.warn("session", `Agent loop hard-killed at turn ${turnCount} — model refused to stop`);
        yield { type: "turn_end", stopReason: "force_stop" };
        this.abortController = null;
        return;
      } else if (turnCount > MAX_AGENT_TURNS) {
        log.warn("session", `Agent loop exceeded ${MAX_AGENT_TURNS} turns, forcing stop`);
        this.state.messages.push({
          role: "user",
          content: `[SYSTEM] STOP. You have used ${turnCount} consecutive tool turns. Summarize what you accomplished and stop. Do NOT make any more tool calls.`,
        });
        forceStopLoop = true;
      } else if (turnCount === 15) {
        // Nudge the model to wrap up — it's been going for a while
        this.state.messages.push({
          role: "user",
          content: "[SYSTEM] You have been running tools for 15 turns. Please wrap up your current task soon and report your progress. Only continue if you are close to finishing.",
        });
      }
      // Check if aborted
      if (this.abortController?.signal.aborted) {
        yield { type: "turn_end", stopReason: "aborted" };
        this.abortController = null;
        return;
      }

      // Prune context if approaching the limit (auto-compacts via LLM when possible)
      await this.pruneMessagesIfNeeded();

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

      let streamedOutputChars = 0; // track chars for estimated token count

      try {
        for await (const chunk of sseStream) {
          switch (chunk.type) {
            case "content_delta": {
              if (chunk.content) {
                textChunks.push(chunk.content);
                streamedOutputChars += chunk.content.length;
                yield { type: "text_delta", text: chunk.content };
                // Emit estimated token count (~4 chars per token) during streaming
                const estimatedTokens = Math.round(streamedOutputChars / 4);
                yield { type: "token_count", tokens: estimatedTokens };
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
                streamedOutputChars += chunk.functionArgDelta.length;
                yield {
                  type: "tool_input_delta",
                  toolUseId: active.id,
                  partialJson: chunk.functionArgDelta,
                };
                const estimatedTokens = Math.round(streamedOutputChars / 4);
                yield { type: "token_count", tokens: estimatedTokens };
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

      // Extract tool calls from text when the model doesn't use native tool_calls
      // (common with local models like Qwen2.5-Coder that output JSON in content)
      if (activeToolCalls.size === 0 && fullText.length > 0) {
        const extracted = extractToolCallsFromText(fullText, this.tools);
        if (extracted.length > 0) {
          // Add remaining non-tool text
          if (extracted[0].prefixText.trim()) {
            assistantContent.push({ type: "text", text: extracted[0].prefixText.trim() });
          }
          for (const ext of extracted) {
            const toolBlock: ToolUseBlock = {
              type: "tool_use",
              id: `toolu_text_${crypto.randomUUID().slice(0, 8)}`,
              name: ext.name,
              input: ext.input,
            };
            assistantContent.push(toolBlock);
            toolCalls.push(toolBlock);
          }
          stopReason = "tool_use";
        } else if (fullText.length > 0) {
          assistantContent.push({ type: "text", text: fullText });
        }
      } else if (fullText.length > 0) {
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

      // If force-stop is set, refuse to execute any more tools regardless of what the model wants
      if (forceStopLoop && toolCalls.length > 0) {
        log.warn("session", `Force-stop active but model returned ${toolCalls.length} tool calls — dropping them`);
        // Strip tool calls from assistant content, keep only text
        const textOnly = assistantContent.filter(b => b.type === "text");
        if (textOnly.length > 0) {
          this.state.messages[this.state.messages.length - 1] = {
            role: "assistant",
            content: textOnly,
          };
        }
        yield { type: "turn_end", stopReason: "force_stop" };
        this.abortController = null;
        return;
      }

      // Client-side JSON schema validation
      if (this.config.jsonSchema && toolCalls.length === 0 && fullText.length > 0) {
        try {
          const schema = this.config.jsonSchema.startsWith("{")
            ? JSON.parse(this.config.jsonSchema)
            : JSON.parse(readFileSync(this.config.jsonSchema, "utf-8"));
          const parsed = JSON.parse(fullText);
          const errors = validateJsonSchema(parsed, schema);
          if (errors.length > 0) {
            log.warn("llm", `JSON schema validation failed: ${errors.join(", ")}`);
            // Ask model to fix the output
            this.state.messages.push({
              role: "user",
              content: `[SYSTEM] Your JSON output failed schema validation:\n${errors.join("\n")}\n\nFix the output to match the required schema. Return ONLY valid JSON.`,
            });
            yield { type: "turn_end", stopReason: "tool_use" };
            continue; // retry with validation feedback
          }
        } catch (e) {
          if (e instanceof SyntaxError) {
            log.warn("llm", `JSON parse failed for schema validation: ${e.message}`);
            this.state.messages.push({
              role: "user",
              content: `[SYSTEM] Your output is not valid JSON: ${e.message}\n\nReturn ONLY valid JSON matching the required schema.`,
            });
            yield { type: "turn_end", stopReason: "tool_use" };
            continue;
          }
          // Schema parsing error — skip validation
        }
      }

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

        // Knowledge distillation: capture successful interaction pattern
        if (stopReason === "end_turn" && turnCount >= 1) {
          try {
            const example = extractExample(this.state.messages, this.config.workingDirectory);
            if (example) saveExample(example);
          } catch { /* distillation is non-critical */ }

          // Benchmark: score this interaction
          try {
            initBenchmarkSchema();
            const lastAssistant = this.state.messages.filter(m => m.role === "assistant").pop();
            const responseText = lastAssistant
              ? (typeof lastAssistant.content === "string" ? lastAssistant.content : lastAssistant.content.filter(b => b.type === "text").map(b => (b as any).text).join(""))
              : "";
            const errorCount = this.state.messages.filter(m =>
              m.role === "assistant" && Array.isArray(m.content) &&
              m.content.some(b => b.type === "tool_result" && b.is_error)
            ).length;
            const score = scoreResponse({
              response: responseText,
              toolsUsed: this.state.toolUseCount,
              errorsEncountered: errorCount,
              taskCompleted: stopReason === "end_turn",
              turnCount,
            });
            saveBenchmark({
              model: this.config.model,
              taskType: "general",
              score,
              tokensUsed: this.state.tokenCount,
              latencyMs: 0,
              details: { turns: turnCount, tools: this.state.toolUseCount },
            });
          } catch { /* benchmarking is non-critical */ }
        }

        // Desktop notification for long-running tasks (>30s or 3+ tool turns)
        const elapsedMs = Date.now() - turnStartMs;
        if (elapsedMs > 30_000 || turnCount >= 3) {
          this.sendNotification("KCode", `Task completed (${turnCount} turns, ${Math.round(elapsedMs / 1000)}s)`);
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

      // Parallel fast-path: if ALL tool calls are read-only, execute them concurrently
      const allParallelSafe = toolCalls.length > 1 && toolCalls.every((c) => this.tools.isParallelSafe(c.name));
      if (allParallelSafe && this.permissions.getMode() === "auto") {
        log.info("tool", `Parallel execution: ${toolCalls.length} read-only tools`);

        // Emit tool_executing events
        for (const call of toolCalls) {
          yield { type: "tool_executing", name: call.name, toolUseId: call.id, input: call.input };
        }

        // Execute all in parallel
        const results = await this.tools.executeParallel(
          toolCalls.map((c) => ({ name: c.name, input: c.input })),
        );

        // Emit results and build tool_result blocks
        for (let i = 0; i < toolCalls.length; i++) {
          const call = toolCalls[i];
          const result = results[i];
          this.state.toolUseCount++;

          yield { type: "tool_result", name: call.name, toolUseId: call.id, result: result.content, isError: result.is_error };
          toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: result.content, is_error: result.is_error });
        }

        this.state.messages.push({ role: "user", content: toolResultBlocks });
        continue;
      }

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

        if (prevCount >= 3) {
          const skipMsg = `BLOCKED: You already called ${call.name} with these exact parameters ${prevCount + 1} times in this response. You are in an infinite loop. STOP calling this tool and do something different.`;
          log.warn("tool", `Dedup blocked: ${sig.slice(0, 80)} (attempt ${prevCount + 1})`);
          yield { type: "tool_result", name: call.name, toolUseId: call.id, result: skipMsg, isError: true };
          toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: skipMsg, is_error: true });
          continue;
        }

        // Cross-turn dedup: handle identical READ/OBSERVE calls repeated across turns
        // Skip Write/Edit — rewriting same file with different content is normal iteration
        const crossCount = (call.name !== "Write" && call.name !== "Edit") ? (crossTurnSigs.get(sig) ?? 0) : 0;
        if (call.name !== "Write" && call.name !== "Edit") crossTurnSigs.set(sig, crossCount + 1);

        // Smart redirect: auto-advance Read offset instead of blocking
        if (crossCount >= 2 && call.name === "Read") {
          const input = call.input as Record<string, unknown>;
          const currentOffset = (input.offset as number) || 1;
          const limit = (input.limit as number) || 200;
          const newOffset = currentOffset + (limit * crossCount);
          (call as any)._autoAdvancedInput = { ...input, offset: newOffset, limit: limit };
          log.info("tool", `Auto-advancing Read offset to ${newOffset} (repeat #${crossCount + 1}): ${String(input.file_path ?? "").slice(0, 60)}`);
        }

        // Hard block after many repeats (genuine stuck loop)
        if (crossCount >= 8) {
          const skipMsg = `BLOCKED: You have called ${call.name} with identical parameters ${crossCount + 1} times. Try a completely different approach.`;
          log.warn("tool", `Cross-turn dedup blocked: ${sig.slice(0, 80)} (attempt ${crossCount + 1})`);
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
        let effectiveInput = (call as any)._autoAdvancedInput ?? permResult.updatedInput ?? call.input;
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

        // After successful Edit/Write, reset cross-turn dedup for Bash/Read
        // This allows legitimate test-fix-test cycles (edit code, then re-run same curl/test)
        if (!result.is_error && (call.name === "Edit" || call.name === "Write")) {
          for (const [key] of crossTurnSigs) {
            if (key.startsWith("Bash:") || key.startsWith("Read:")) {
              crossTurnSigs.delete(key);
            }
          }
          // Also reset intention engine's action history for Bash/Read
          try { getIntentionEngine().resetTestFixCycle(); } catch { /* ignore */ }
          inlineWarningCount = 0;
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

        // 6. Auto-test suggestion: if Edit/Write succeeded, check for related tests
        if ((call.name === "Edit" || call.name === "Write") && !result.is_error) {
          try {
            const { getTestSuggestion } = await import("./auto-test.js");
            const fp = String((call.input as any)?.file_path ?? "");
            if (fp) {
              const suggestion = getTestSuggestion(fp, this.config.workingDirectory);
              if (suggestion) {
                yield {
                  type: "suggestion",
                  suggestions: [{
                    type: "test",
                    message: `Related test: ${suggestion.testFile} -- run with: ${suggestion.command}`,
                    priority: "low",
                  }],
                };
              }
            }
          } catch { /* auto-test is non-critical */ }
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
          inlineWarningCount++;
          log.warn("intentions", `Inline warning #${inlineWarningCount}: ${inlineWarning.slice(0, 100)}`);

          if (inlineWarningCount >= 5) {
            // Hard stop — model is genuinely stuck after many warnings
            log.warn("intentions", "Infinite loop detected: forcing agent loop stop after 5 inline warnings");
            this.state.messages.push({
              role: "user",
              content: `[SYSTEM] FORCE STOP: You have been warned ${inlineWarningCount} times about repeating the same actions. The agent loop is being terminated. Reply with text only — summarize what you accomplished and what you could not complete.`,
            });
            // Allow one more turn for text response, then hard break
            forceStopLoop = true;
          } else if (inlineWarningCount >= 2) {
            // Strong warning — but let the model continue working on other things
            log.warn("intentions", `Inline warning #${inlineWarningCount}: model repeating actions, injecting strong redirect`);
            this.state.messages.push({
              role: "user",
              content: `[SYSTEM] WARNING #${inlineWarningCount}: You are repeating the same tool calls. The repeated calls are being BLOCKED. MOVE ON to a different task or try a completely different approach. Do NOT keep reading the same file — use offset/limit to read different sections, or use Bash with sed/grep to find what you need.`,
            });
          } else {
            this.state.messages.push({
              role: "user",
              content: `⚠️ SYSTEM WARNING: ${inlineWarning}`,
            });
          }
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

        // Qwen3 models default to "thinking" mode which wastes tokens on internal
        // reasoning. Disable it unless the user explicitly requested --thinking.
        if (!this.config.thinking) {
          body.chat_template_kwargs = { enable_thinking: false };
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
  private async pruneMessagesIfNeeded(): Promise<void> {
    // Use the higher of: tracked token count or estimated from message content
    const estimatedTokens = this.estimateContextTokens();
    const effectiveCount = Math.max(this.state.tokenCount, estimatedTokens);
    const threshold = this.contextWindowSize * this.compactThreshold;
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

    // Phase 2: Auto-compact via LLM summary instead of blind pruning
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
      // Try LLM-based compaction first, fall back to simple pruning
      const toPrune = messages.slice(keepFirst, keepFirst + pruneCount);
      try {
        const { CompactionManager } = await import("./compaction.js");
        const compactor = new CompactionManager(this.config.apiKey, this.config.model, this.config.apiBase);
        const summary = await compactor.compact(toPrune);
        if (summary) {
          messages.splice(keepFirst, pruneCount, summary);
          this.state.tokenCount = this.estimateContextTokens();
          log.info("session", `Auto-compacted ${pruneCount} messages into summary, ~${this.state.tokenCount} tokens remaining`);
          return;
        }
      } catch (err) {
        log.error("session", `Auto-compaction failed, falling back to pruning: ${err}`);
      }

      // Fallback: simple pruning
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
   * Fork the conversation: keep current messages but start a new transcript.
   * Optionally truncate to a specific message count (fork from a point in history).
   */
  forkConversation(keepMessages?: number): { messageCount: number; sessionId: string } {
    const msgs = keepMessages
      ? this.state.messages.slice(0, keepMessages)
      : [...this.state.messages];
    // Start a new transcript
    this.transcript = new TranscriptManager();
    const summary = msgs.length > 0
      ? (typeof msgs[0].content === "string" ? msgs[0].content : "[forked session]").slice(0, 80)
      : "forked session";
    this.transcript.startSession(`[FORK] ${summary}`);
    this.state.messages = msgs;
    return { messageCount: msgs.length, sessionId: "forked" };
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

  /** Fast string hash for cache comparison (djb2). */
  private hashString(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }

  /** Get session start time for elapsed time tracking. */
  getSessionStartTime(): number {
    return this.sessionStartTime;
  }

  /** Send a desktop notification (Linux: notify-send, macOS: osascript). */
  sendNotification(title: string, body: string): void {
    try {
      const { execSync } = require("node:child_process");
      if (process.platform === "linux") {
        execSync(`notify-send "${title.replace(/"/g, '\\"')}" "${body.replace(/"/g, '\\"')}" 2>/dev/null`, { timeout: 3000 });
      } else if (process.platform === "darwin") {
        execSync(`osascript -e 'display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"' 2>/dev/null`, { timeout: 3000 });
      }
    } catch {
      // Silent failure — notifications are best-effort
    }
  }

  /** Get list of files modified in this session (from undo manager). */
  getModifiedFiles(): string[] {
    const files: string[] = [];
    for (const msg of this.state.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use" && (block.name === "Write" || block.name === "Edit")) {
            const fp = String((block.input as any)?.file_path ?? "");
            if (fp && !files.includes(fp)) files.push(fp);
          }
        }
      }
    }
    return files;
  }
}
