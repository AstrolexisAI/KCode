// KCode - Core type definitions
// Core type definitions

// ─── Message Types ───────────────────────────────────────────────

export type Role = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: Role;
  content: ContentBlock[] | string;
}

// ─── OpenAI-Compatible Message Types ─────────────────────────────

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ─── Tool Types ──────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

// ─── Configuration ───────────────────────────────────────────────

export interface KCodeConfig {
  apiKey?: string;
  apiBase?: string;
  model: string;
  maxTokens: number;
  systemPrompt: string;
  workingDirectory: string;
  additionalDirs?: string[]; // Additional directories the AI can read/write
  permissionMode: PermissionMode;
  contextWindowSize?: number; // model's context window size in tokens
  maxRetries?: number;
  autoRoute?: boolean; // auto-route to best model based on content (default true)
  modelExplicitlySet?: boolean; // true if user set model via -m flag
  rateLimit?: { maxPerMinute?: number; maxConcurrent?: number };
  version?: string;
  jsonSchema?: string;
  thinking?: boolean;
  theme?: string;
  compactThreshold?: number; // 0.0 to 1.0, default 0.8 — trigger auto-compact at this % of context window
}

export type PermissionMode = "ask" | "auto" | "plan" | "deny" | "acceptEdits";

// ─── Model Registry ─────────────────────────────────────────────
// Models are configured dynamically via ~/.kcode/models.json
// Use src/core/models.ts for model lookup (getModelBaseUrl, etc.)

// ─── Conversation ────────────────────────────────────────────────

export interface ConversationState {
  messages: Message[];
  tokenCount: number;
  toolUseCount: number;
}

// ─── Token Usage ─────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

// ─── Stream Events ───────────────────────────────────────────────

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_use_start"; toolUseId: string; name: string }
  | { type: "tool_input_delta"; toolUseId: string; partialJson: string }
  | { type: "tool_executing"; name: string; toolUseId: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; toolUseId: string; result: string; isError?: boolean }
  | { type: "usage_update"; usage: TokenUsage }
  | { type: "token_count"; tokens: number }
  | { type: "error"; error: Error; retryable: boolean; attempt?: number }
  | { type: "turn_start" }
  | { type: "suggestion"; suggestions: { type: string; message: string; priority: string }[] }
  | { type: "turn_end"; stopReason: string };

// ─── Tool Input/Output Schemas ───────────────────────────────────

export interface BashInput {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}

export interface FileReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
  pages?: string;
}

export interface FileWriteInput {
  file_path: string;
  content: string;
}

export interface FileEditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface GlobInput {
  pattern: string;
  path?: string;
}

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  "-i"?: boolean;
  "-n"?: boolean;
  "-A"?: number;
  "-B"?: number;
  "-C"?: number;
  context?: number;
  type?: string;
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
}
