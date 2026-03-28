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
  anthropicApiKey?: string; // Anthropic-specific API key (ANTHROPIC_API_KEY env var)
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
  reasoningBudget?: number; // -1 = unlimited, positive = max thinking tokens
  noCache?: boolean; // Disable response cache
  theme?: string;
  compactThreshold?: number; // 0.0 to 1.0, default 0.8 — trigger auto-compact at this % of context window
  permissionRules?: PermissionRule[]; // Granular per-tool rules (first match wins)
  effortLevel?: "low" | "medium" | "high" | "max"; // Reasoning effort: adjusts maxTokens, temperature, prompt depth
  fallbackModel?: string; // Auto-switch to this model if primary fails
  tertiaryModel?: string; // Ultra-lightweight fallback if both primary and fallback fail
  fallbackModels?: string[]; // Ordered fallback chain — tried sequentially after primary + retries fail
  maxBudgetUsd?: number; // Max spend per session in USD
  outputFormat?: "text" | "json" | "stream-json"; // Output format for print mode
  telemetry?: boolean; // Opt-in/out for local analytics tracking
  systemPromptOverride?: string; // Override the entire system prompt
  systemPromptAppend?: string; // Append text to the system prompt
  sessionName?: string; // Named session (used in UI and transcript filename)
  allowedTools?: string[]; // Whitelist of allowed tool names
  disallowedTools?: string[]; // Blacklist of blocked tool names
  noSessionPersistence?: boolean; // Do not save session transcript to disk
  tmux?: boolean; // Open worktree agents in separate tmux panes
  pro?: boolean; // Whether the current installation has an active Pro license
  // Managed policy fields (org-level, immutable)
  managedDisallowedTools?: string[]; // Org-level blocked tools (cannot be overridden)
  managedAllowedTools?: string[]; // Org-level allowed tools (bypass permission prompts)
  disableWebAccess?: boolean; // Org-level: disable WebFetch/WebSearch
  auditLog?: boolean; // Org-level: require audit logging
  orgId?: string; // Organization identifier for audit trail
  activeProfile?: string; // Currently active execution profile name (e.g., "safe", "fast", "review")
  customFetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; // Inject a custom fetch function (for in-process testing)
}

export type PermissionMode = "ask" | "auto" | "plan" | "deny" | "acceptEdits";

// ─── Permission Rules ───────────────────────────────────────────

export type PermissionRuleAction = "allow" | "deny" | "ask";

/**
 * Granular per-tool permission rules.
 * Evaluated in order: first match wins. If no rule matches, falls back to permission mode.
 *
 * Pattern formats:
 *   `Bash(npm run *)` — match Bash commands starting with "npm run "
 *   `Edit(/src/wildcard.ts)` — match Edit/Write on paths matching glob
 *   `WebFetch(domain:example.com)` — match WebFetch to specific domain
 *   `Bash(*)` — match ALL bash commands
 *   `mcp__server__*` — match MCP tool calls by prefix
 */
export interface PermissionRule {
  pattern: string;
  action: PermissionRuleAction;
}

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

// ─── Per-Turn Cost Tracking ─────────────────────────────────────

export interface TurnCostEntry {
  turnIndex: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolCalls: string[];  // tool names used in this turn
  timestamp: number;
}

// ─── Stream Events ───────────────────────────────────────────────

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_use_start"; toolUseId: string; name: string }
  | { type: "tool_input_delta"; toolUseId: string; partialJson: string }
  | { type: "tool_executing"; name: string; toolUseId: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; toolUseId: string; result: string; isError?: boolean; durationMs?: number }
  | { type: "usage_update"; usage: TokenUsage }
  | { type: "token_count"; tokens: number }
  | { type: "error"; error: Error; retryable: boolean; attempt?: number }
  | { type: "turn_start" }
  | { type: "suggestion"; suggestions: { type: string; message: string; priority: string }[] }
  | { type: "turn_end"; stopReason: string; emptyType?: "thinking_only" | "tools_only" | "thinking_and_tools" | "no_output" }
  | { type: "compaction_start"; messageCount: number; tokensBefore: number }
  | { type: "compaction_end"; tokensAfter: number; method: "llm" | "pruned" | "compressed" }
  | { type: "budget_warning"; costUsd: number; limitUsd: number; pct: number }
  | { type: "tool_progress"; toolUseId: string; name: string; status: "queued" | "running" | "done" | "error"; index: number; total: number; durationMs?: number }
  | { type: "tool_stream"; toolUseId: string; name: string; chunk: string };

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
