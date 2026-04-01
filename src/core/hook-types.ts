// KCode - Hook Types & Interfaces
// All type definitions, interfaces, and internal types for the hooks system

// ─── Types ──────────────────────────────────────────────────────

export type HookEvent =
  | "SessionStart"
  | "SessionEnd"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PreCompact"
  | "PostCompact"
  | "UserPromptSubmit"
  | "PermissionRequest"
  | "Stop"
  | "Notification"
  | "ConfigChange"
  | "InstructionsLoaded"
  | "SubagentStart"
  | "SubagentStop"
  | "TaskCompleted"
  | "WorktreeCreate"
  | "WorktreeRemove"
  // Phase 12: Expanded hook events
  | "PreEdit" // Before file edit (can block)
  | "PostEdit" // After file edit
  | "PreBash" // Before bash execution (can block)
  | "PostBash" // After bash execution
  | "PreWrite" // Before file write (can block)
  | "PostWrite" // After file write
  | "ModelSwitch" // When model routing switches models
  | "ContextOverflow" // When context window is near capacity
  | "TaskComplete" // When a multi-step task finishes
  | "ErrorRecovery"; // When auto-recovery from an error occurs

/**
 * Matcher for filtering hooks by event properties.
 * Used with the new config format. Supports tool name matching and
 * arbitrary key-value property matching.
 */
export interface HookMatcher {
  /** Match against tool name (glob pattern, e.g. "Bash", "Edit", "mcp__*") */
  toolName?: string;
  /** Match against arbitrary event properties (key-value pairs) */
  [key: string]: string | undefined;
}

/**
 * Legacy hook config format (backward compatible).
 * Uses regex matcher string and an array of hook actions.
 */
export interface HookConfig {
  /** Regex pattern to match against (tool name for tool hooks, event name otherwise) */
  matcher: string;
  /** List of hook actions to execute */
  hooks: HookAction[];
}

/**
 * New simplified hook entry format.
 * Configured directly under each event in the hooks object.
 */
export interface PromptHookConfig {
  prompt: string;
  model?: string;
  timeout?: number;
}

export interface HookEntry {
  /** Hook type: "command" runs a shell command, "prompt" injects text, "http" calls a webhook, "agent" spawns a subagent, "llm-prompt" uses LLM evaluation */
  type: "command" | "prompt" | "http" | "agent" | "llm-prompt";
  /** Shell command to execute (type=command). Receives JSON on stdin. */
  command?: string;
  /** Text to inject into conversation context (type=prompt). */
  prompt?: string;
  /** HTTP endpoint URL (type=http). Receives JSON body. */
  url?: string;
  /** HTTP method (type=http, default: POST) */
  method?: string;
  /** Additional HTTP headers (type=http) */
  headers?: Record<string, string>;
  /** Bearer token or API key for Authorization header (type=http) */
  auth?: string;
  /** Filter by tool name and event properties */
  matcher?: HookMatcher;
  /** Timeout in milliseconds (default: 10000) */
  timeout?: number;
  /** LLM prompt configuration (type=llm-prompt). Sends to a fast model for evaluation. */
  promptConfig?: PromptHookConfig;
  /** Agent configuration (type=agent). Spawns a subagent to handle the hook. */
  agentConfig?: {
    /** Template prompt for the agent. Supports {{event}}, {{toolName}}, {{input}} placeholders. */
    prompt: string;
    /** Optional model override for the subagent. */
    model?: string;
    /** Timeout in milliseconds (default: 60000). */
    timeout?: number;
    /** Run in background without awaiting result (default: true). */
    background?: boolean;
  };
}

export interface HookAction {
  type: "command" | "http";
  /** Shell command to execute (type=command). Receives JSON on stdin. */
  command?: string;
  /** HTTP endpoint to POST to (type=http). Receives JSON body. */
  url?: string;
  /** HTTP method (default: POST) */
  method?: string;
  /** Additional HTTP headers */
  headers?: Record<string, string>;
  /** Timeout in milliseconds (overrides default) */
  timeout?: number;
}

export interface HookOutput {
  decision: "allow" | "deny" | "block";
  reason?: string;
  updatedInput?: Record<string, unknown>;
}

export interface HookResult {
  /** Whether the tool call should proceed */
  allowed: boolean;
  /** Reason for blocking, if blocked */
  reason?: string;
  /** Updated tool input, if the hook modified it */
  updatedInput?: Record<string, unknown>;
  /** Warnings from hooks that exited with non-0/non-2 codes */
  warnings: string[];
  /** Stdout from hooks (appended as context) */
  contextOutput?: string[];
}

/** Internal symbol used to tag hooks with their source (user vs project) */
export const HOOK_SOURCE = Symbol("hookSource");
export type HookSource = "user" | "project";

/** Augmented hook type that carries source metadata internally */
export type TaggedHook = (HookConfig | HookEntry) & { [HOOK_SOURCE]?: HookSource };

/** Settings file shape (only the hooks portion) */
export interface KCodeSettings {
  hooks?: Partial<Record<HookEvent, TaggedHook[]>>;
}
