// KCode - Hooks System
// Loads and executes lifecycle hooks from .kcode/settings.json and ~/.kcode/settings.json

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ToolUseBlock, ToolResult } from "./types";
import { log } from "./logger";
import { evaluateHookifyRules } from "./hookify";
import { evaluatePromptHook } from "./prompt-hooks";

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
  | "PreEdit"       // Before file edit (can block)
  | "PostEdit"      // After file edit
  | "PreBash"       // Before bash execution (can block)
  | "PostBash"      // After bash execution
  | "PreWrite"      // Before file write (can block)
  | "PostWrite"     // After file write
  | "ModelSwitch"   // When model routing switches models
  | "ContextOverflow" // When context window is near capacity
  | "TaskComplete"  // When a multi-step task finishes
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
const HOOK_SOURCE = Symbol("hookSource");
type HookSource = "user" | "project";

/** Augmented hook type that carries source metadata internally */
type TaggedHook = (HookConfig | HookEntry) & { [HOOK_SOURCE]?: HookSource };

/** Settings file shape (only the hooks portion) */
interface KCodeSettings {
  hooks?: Partial<Record<HookEvent, TaggedHook[]>>;
}

// ─── Workspace Trust ────────────────────────────────────────────

/**
 * Session-only set of workspace paths the user has approved for
 * running project-level hooks. Not persisted to disk.
 */
const trustedWorkspaces = new Set<string>();

/**
 * Optional callback for prompting the user to trust a workspace.
 * Set by the UI layer via setTrustPromptCallback().
 * Called with (workspacePath, hookCommand) and should return true to trust.
 */
let _trustPromptCallback: ((workspacePath: string, hookCommand: string) => Promise<boolean>) | null = null;

/** Register a callback that asks the user whether to trust a workspace. */
export function setTrustPromptCallback(
  cb: (workspacePath: string, hookCommand: string) => Promise<boolean>,
): void {
  _trustPromptCallback = cb;
}

/** Normalize a workspace path for consistent trust lookups. */
function normalizePath(path: string): string {
  return resolve(path).replace(/\/+$/, "");
}

/** Explicitly trust a workspace path for the current session. */
export function trustWorkspace(path: string): void {
  trustedWorkspaces.add(normalizePath(path));
}

/** Check if a workspace path is currently trusted. */
export function isWorkspaceTrusted(path: string): boolean {
  return trustedWorkspaces.has(normalizePath(path));
}

// ─── Hook Execution ─────────────────────────────────────────────

const DEFAULT_HOOK_TIMEOUT = 10_000; // 10 seconds (new default)
const LEGACY_HOOK_TIMEOUT = 30_000; // 30 seconds (legacy default)
const HTTP_TIMEOUT = 10_000; // 10 seconds

/** Check if a config entry is the new HookEntry format */
function isHookEntry(entry: HookConfig | HookEntry): entry is HookEntry {
  const t = (entry as HookEntry).type;
  return t === "command" || t === "prompt" || t === "http" || t === "agent" || t === "llm-prompt";
}

/** Check if a config entry is the legacy HookConfig format */
function isLegacyHookConfig(entry: HookConfig | HookEntry): entry is HookConfig {
  return typeof (entry as HookConfig).matcher === "string" && Array.isArray((entry as HookConfig).hooks);
}

/**
 * Safely test a regex pattern against a target string, rejecting
 * patterns with nested quantifiers that can cause catastrophic backtracking (ReDoS).
 */
function safeRegexTest(pattern: string, target: string): boolean {
  try {
    // Reject patterns longer than 200 chars (reduces attack surface)
    if (pattern.length > 200) return false;

    // Reject obviously dangerous patterns (nested quantifiers)
    if (/([+*])\)?[+*{]|(\{[^}]*\})\)?[+*{]/.test(pattern)) {
      return false; // Reject nested quantifiers like a+* or a{2,}*
    }
    // Reject alternation with overlapping branches: (a|a)*, (ab|ab)+
    if (/\(([^)]+)\|(\1)\)[*+{]/.test(pattern)) {
      return false; // Reject (x|x)* patterns
    }
    // Reject deeply nested groups with quantifiers: ((a+)+)
    if (/\([^)]*\([^)]*[+*]\)[^)]*\)[+*{]/.test(pattern)) {
      return false; // Reject nested group quantifiers
    }
    // Reject excessive backtracking from repeated overlapping char classes
    if (/(\[.*\])[+*]\1[+*]/.test(pattern)) {
      return false;
    }

    // Execute with a timeout guard using a simple length check heuristic
    if (target.length > 10_000) {
      return false; // Don't run regex against very long strings
    }

    const regex = new RegExp(pattern);
    return regex.test(target);
  } catch (err) {
    log.debug("hooks", `Regex test failed for pattern "${pattern}": ${err}`);
    return false;
  }
}

/**
 * Simple glob match for hook matchers.
 * Supports * (any chars except /) and ** (any chars including /).
 */
function hookGlobMatch(pattern: string, value: string): boolean {
  let regex = pattern.replace(/([.+^${}()|[\]\\])/g, "\\$1");
  regex = regex.replace(/\*\*/g, "<<GLOBSTAR>>");
  regex = regex.replace(/\*/g, "[^/]*");
  regex = regex.replace(/<<GLOBSTAR>>/g, ".*");
  return new RegExp(`^${regex}$`).test(value);
}

/** Check if a HookMatcher matches the given context */
function matcherMatches(
  matcher: HookMatcher | undefined,
  toolName: string | undefined,
  context: Record<string, unknown>,
): boolean {
  if (!matcher) return true; // No matcher = match everything

  // Check toolName if specified
  if (matcher.toolName) {
    if (!toolName) return false;
    if (!hookGlobMatch(matcher.toolName, toolName)) return false;
  }

  // Check other property matchers
  for (const [key, pattern] of Object.entries(matcher)) {
    if (key === "toolName") continue; // Already handled
    if (pattern === undefined) continue;
    const value = context[key];
    if (typeof value !== "string") return false;
    if (!hookGlobMatch(pattern, value)) return false;
  }

  return true;
}

/** Validate a hook command string for obviously dangerous patterns. */
function validateHookCommand(command: string): boolean {
  const trimmed = command.trim();
  // Block empty commands
  if (!trimmed) return false;
  // Block commands that attempt to download and pipe to shell
  if (/curl\s.*\|\s*(sh|bash|zsh)/.test(trimmed)) return false;
  if (/wget\s.*\|\s*(sh|bash|zsh)/.test(trimmed)) return false;
  // Block reverse shells
  if (/\/dev\/(tcp|udp)\//.test(trimmed)) return false;
  // Block base64-encoded execution (common obfuscation)
  if (/base64\s.*-d\s*\|\s*(sh|bash|zsh)/.test(trimmed)) return false;
  // Block backgrounded network exfiltration
  if (/nc\s+-[^l]*\s+\d+/.test(trimmed) && /\|/.test(trimmed)) return false;
  return true;
}

/** Execute a single hook command, passing context as JSON via stdin. */
async function executeHookCommand(
  command: string,
  stdinData: string,
  cwd: string,
  timeout: number = LEGACY_HOOK_TIMEOUT,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Validate hook command before execution
  if (!validateHookCommand(command)) {
    log.warn("hooks", `Blocked suspicious hook command: ${command.slice(0, 100)}`);
    return { exitCode: 1, stdout: "", stderr: "Hook command blocked by security validation" };
  }

  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    // Strip sensitive env vars from hook subprocess environment
    const hookEnv = { ...process.env };
    for (const key of Object.keys(hookEnv)) {
      if (/^(KCODE_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|GROQ_API_KEY|DEEPSEEK_API_KEY|TOGETHER_API_KEY|GEMINI_API_KEY)$/i.test(key)) {
        delete hookEnv[key];
      }
    }

    const proc = spawn("sh", ["-c", command], {
      cwd,
      timeout,
      env: hookEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdout.on("data", (data: Buffer) => stdoutChunks.push(data));
    proc.stderr.on("data", (data: Buffer) => stderrChunks.push(data));

    // Write JSON context to stdin
    proc.stdin.write(stdinData);
    proc.stdin.end();

    proc.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8").trim(),
        stderr: Buffer.concat(stderrChunks).toString("utf-8").trim(),
      });
    });

    proc.on("error", (err) => {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: err.message,
      });
    });
  });
}

/** Check if a hostname resolves to a private/internal IP. */
function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "metadata.google.internal" || h === "metadata.google") return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  // Cloud provider metadata endpoints (AWS/GCP link-local + Azure wireserver)
  if (h === "168.63.129.16") return true; // Azure Instance Metadata / wireserver
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true; // AWS VPC carrier-grade NAT (100.64-127.x)
  if (/^0\./.test(h) || h === "0.0.0.0") return true;
  if (h === "::1" || h === "[::1]") return true;
  if (/^fe80:/i.test(h) || /^fd/i.test(h) || /^fc/i.test(h)) return true;
  const v4mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped && isPrivateHostname(v4mapped[1]!)) return true;
  return false;
}

/** Execute an HTTP hook action, posting JSON to the configured URL. */
async function executeHookHttp(
  action: HookAction,
  jsonData: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { requirePro } = await import("./pro.js");
  await requirePro("hooks-webhook");

  if (!action.url) {
    return { exitCode: 1, stdout: "", stderr: "HTTP hook missing url" };
  }

  // Validate URL protocol
  let parsed: URL;
  try {
    parsed = new URL(action.url);
  } catch (err) {
    log.debug("hooks", `Invalid hook URL "${action.url}": ${err}`);
    return { exitCode: 1, stdout: "", stderr: `Invalid hook URL: ${action.url}` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { exitCode: 1, stdout: "", stderr: `Hook URL must use http(s): ${action.url}` };
  }

  // Block SSRF to private/internal IPs
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateHostname(hostname)) {
    return { exitCode: 1, stdout: "", stderr: `Hook URL blocked (private/internal): ${action.url}` };
  }

  // Enforce HTTPS when auth headers are present (legacy format protection)
  if (action.headers && parsed.protocol !== "https:") {
    const hasAuth = Object.keys(action.headers).some(k => k.toLowerCase() === "authorization");
    if (hasAuth) {
      return { exitCode: 1, stdout: "", stderr: `Hook auth headers require HTTPS, got: ${parsed.protocol}` };
    }
  }

  try {
    const method = (action.method ?? "POST").toUpperCase();
    const httpTimeout = action.timeout ?? HTTP_TIMEOUT;
    const resp = await fetch(action.url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(action.headers ?? {}),
      },
      body: method !== "GET" ? jsonData : undefined,
      signal: AbortSignal.timeout(httpTimeout),
    });

    const body = await resp.text();
    // Map HTTP status to exit codes: 2xx=0, 403/422=2 (block), other=1
    let exitCode = 0;
    if (resp.status === 403 || resp.status === 422) {
      exitCode = 2; // Block signal
    } else if (!resp.ok) {
      exitCode = 1;
    }

    return { exitCode, stdout: body.slice(0, 64 * 1024), stderr: "" };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Execute a hook action (command or http). */
async function executeHookAction(
  action: HookAction,
  jsonData: string,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (action.type === "http") {
    return executeHookHttp(action, jsonData);
  }
  if (action.type === "command" && action.command) {
    return executeHookCommand(action.command, jsonData, cwd, action.timeout);
  }
  return { exitCode: 1, stdout: "", stderr: `Unknown hook type: ${action.type}` };
}

/** Expand template placeholders in an agent hook prompt. */
function expandAgentTemplate(
  template: string,
  context: { event?: string; toolName?: string; input?: unknown },
): string {
  return template
    .replace(/\{\{event\}\}/g, context.event ?? "")
    .replace(/\{\{toolName\}\}/g, context.toolName ?? "")
    .replace(/\{\{input\}\}/g, context.input !== undefined ? JSON.stringify(context.input) : "");
}

/** Default timeout for agent hooks (60 seconds). */
const AGENT_HOOK_TIMEOUT = 60_000;

/**
 * Execute an agent hook by spawning a subagent process.
 * Uses the same CLI pattern as src/tools/agent.ts — spawns `bun run src/index.ts --agent`.
 */
async function executeHookAgent(
  entry: HookEntry,
  jsonData: string,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { requirePro } = await import("./pro.js");
  await requirePro("hooks-agent");

  const config = entry.agentConfig;
  if (!config?.prompt) {
    return { exitCode: 1, stdout: "", stderr: "Agent hook missing agentConfig.prompt" };
  }

  // Parse the JSON context to extract template values
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(jsonData);
  } catch (err) { log.debug("hooks", `Failed to parse JSON context for agent hook: ${err}`); }

  const expandedPrompt = expandAgentTemplate(config.prompt, {
    event: parsed.event as string | undefined,
    toolName: parsed.tool_name as string | undefined,
    input: parsed.tool_input ?? parsed,
  });

  const background = config.background !== false; // default true
  const timeout = config.timeout ?? AGENT_HOOK_TIMEOUT;

  // Build subagent command args
  const args: string[] = ["run", "src/index.ts", "--agent"];
  if (config.model) {
    args.push("-m", config.model);
  }

  const proc = spawn("bun", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    timeout: background ? undefined : timeout,
  });

  // Send the expanded prompt via stdin
  proc.stdin.write(expandedPrompt + "\n");
  proc.stdin.end();

  if (background) {
    // Fire and forget — but enforce a max timeout to prevent zombie processes
    const bgTimeout = Math.max(timeout, 300_000); // at least 5 minutes
    const bgTimer = setTimeout(() => {
      try { proc.kill(); } catch (err) { log.debug("hooks", `Failed to kill background agent hook: ${err}`); }
      log.warn("hooks", `Agent hook (background) killed after ${bgTimeout}ms timeout`);
    }, bgTimeout);
    proc.on("error", (err) => {
      clearTimeout(bgTimer);
      log.warn("hooks", `Agent hook (background) error: ${err.message}`);
    });
    proc.on("close", (code) => {
      clearTimeout(bgTimer);
      if (code !== 0) {
        log.warn("hooks", `Agent hook (background) exited with code ${code}`);
      }
    });
    return { exitCode: 0, stdout: "[agent hook started in background]", stderr: "" };
  }

  // Foreground: await result
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on("data", (data: Buffer) => stdoutChunks.push(data));
    proc.stderr.on("data", (data: Buffer) => stderrChunks.push(data));

    const timer = setTimeout(() => {
      try { proc.kill(); } catch (err) { log.debug("hooks", `Failed to kill foreground agent hook: ${err}`); }
      resolve({ exitCode: 1, stdout: "", stderr: `Agent hook timed out after ${timeout}ms` });
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8").trim(),
        stderr: Buffer.concat(stderrChunks).toString("utf-8").trim(),
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout: "", stderr: err.message });
    });
  });
}

/** Execute a new-format HookEntry. */
async function executeHookEntry(
  entry: HookEntry,
  jsonData: string,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (entry.type === "prompt") {
    // Prompt hooks inject text — return prompt text as stdout, always succeed
    return { exitCode: 0, stdout: entry.prompt ?? "", stderr: "" };
  }
  if (entry.type === "command" && entry.command) {
    const timeout = entry.timeout ?? DEFAULT_HOOK_TIMEOUT;
    return executeHookCommand(entry.command, jsonData, cwd, timeout);
  }
  if (entry.type === "http") {
    // Enforce HTTPS when auth token is provided to prevent credential leakage
    if (entry.auth && entry.url) {
      try {
        const parsed = new URL(entry.url);
        if (parsed.protocol !== "https:") {
          return { exitCode: 1, stdout: "", stderr: `Hook auth requires HTTPS, got: ${parsed.protocol}` };
        }
      } catch (err) {
        log.debug("hooks", `Invalid hook entry URL "${entry.url}": ${err}`);
        return { exitCode: 1, stdout: "", stderr: `Invalid hook URL: ${entry.url}` };
      }
    }
    // Delegate to executeHookHttp via a HookAction adapter
    const action: HookAction = {
      type: "http",
      url: entry.url,
      method: entry.method,
      headers: {
        ...(entry.headers ?? {}),
        ...(entry.auth ? { Authorization: `Bearer ${entry.auth}` } : {}),
      },
      timeout: entry.timeout,
    };
    return executeHookHttp(action, jsonData);
  }
  if (entry.type === "agent") {
    return executeHookAgent(entry, jsonData, cwd);
  }
  if (entry.type === "llm-prompt" && entry.promptConfig) {
    const result = await evaluatePromptHook(entry.promptConfig, jsonData);
    if (result.decision === "block" || result.decision === "deny") {
      return { exitCode: 2, stdout: JSON.stringify({ decision: "block", reason: result.reason }), stderr: "" };
    }
    if (result.decision === "warn") {
      return { exitCode: 0, stdout: result.reason ?? "", stderr: "" };
    }
    return { exitCode: 0, stdout: result.reason ?? "", stderr: "" };
  }
  return { exitCode: 1, stdout: "", stderr: `Unknown hook type: ${entry.type}` };
}

/** Parse hook command output as JSON, with fallback. */
function parseHookOutput(stdout: string): HookOutput | null {
  if (!stdout) return null;

  try {
    const parsed = JSON.parse(stdout);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.decision === "string" &&
      ["allow", "deny", "block"].includes(parsed.decision)
    ) {
      return parsed as HookOutput;
    }
  } catch (err) {
    log.debug("hooks", `Non-JSON hook output (ignored): ${err}`);
  }

  return null;
}

/** Load hooks from a single settings file, tagging each hook with its source. */
function loadSettingsFile(path: string, source: HookSource): KCodeSettings {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf-8");
    const settings = JSON.parse(raw) as KCodeSettings;
    // Tag every hook entry with its source
    if (settings.hooks) {
      for (const configs of Object.values(settings.hooks)) {
        if (!Array.isArray(configs)) continue;
        for (const hook of configs) {
          (hook as TaggedHook)[HOOK_SOURCE] = source;
        }
      }
    }
    return settings;
  } catch (err) {
    log.debug("hooks", `Failed to parse settings file ${path}: ${err}`);
    return {};
  }
}

/** Merge hook configs from multiple sources (later sources have higher priority). */
function mergeHookSettings(...sources: KCodeSettings[]): KCodeSettings {
  const merged: KCodeSettings = { hooks: {} };
  for (const src of sources) {
    if (!src.hooks) continue;
    for (const [event, configs] of Object.entries(src.hooks)) {
      if (!Array.isArray(configs)) continue;
      const key = event as HookEvent;
      if (!merged.hooks![key]) {
        merged.hooks![key] = [];
      }
      merged.hooks![key]!.push(...configs);
    }
  }
  return merged;
}

// ─── Hook Manager ───────────────────────────────────────────────

export class HookManager {
  private settings: KCodeSettings = {};
  private workingDirectory: string;
  private loaded = false;

  constructor(workingDirectory: string) {
    this.workingDirectory = workingDirectory;
  }

  /** Load hooks from ~/.kcode/settings.json and .kcode/settings.json. Safe to call multiple times. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;

    // User-level settings (lower priority) — always trusted
    const userSettingsPath = join(homedir(), ".kcode", "settings.json");
    const userSettings = loadSettingsFile(userSettingsPath, "user");

    // Project-level settings (higher priority) — require workspace trust
    const projectSettingsPath = join(this.workingDirectory, ".kcode", "settings.json");
    const projectSettings = loadSettingsFile(projectSettingsPath, "project");

    // Merge: user first, then project (project hooks run after user hooks)
    this.settings = mergeHookSettings(userSettings, projectSettings);
  }

  /** Force reload settings (useful if the file changed). */
  reload(): void {
    this.loaded = false;
    this.load();
  }

  /** Check if any hooks are configured for the given event. */
  hasHooks(event: HookEvent): boolean {
    this.load();
    const configs = this.settings.hooks?.[event];
    return Array.isArray(configs) && configs.length > 0;
  }

  /**
   * Check if a tagged hook is allowed to run. User-level hooks always run.
   * Project-level hooks require workspace trust. If untrusted and a trust
   * prompt callback is set, prompts the user and caches the result.
   */
  private async checkHookTrust(hook: TaggedHook): Promise<boolean> {
    const source = hook[HOOK_SOURCE];
    if (source !== "project") return true; // User-level hooks always allowed

    if (isWorkspaceTrusted(normalizePath(this.workingDirectory))) return true;

    // Determine the command string for the prompt
    const command = (hook as HookEntry).command
      ?? (hook as HookConfig).hooks?.[0]?.command
      ?? (hook as HookConfig).hooks?.[0]?.url
      ?? "unknown";

    if (_trustPromptCallback) {
      const trusted = await _trustPromptCallback(this.workingDirectory, command);
      if (trusted) {
        trustWorkspace(this.workingDirectory);
      }
      return trusted;
    }

    // No callback available — skip project hook with a warning
    log.warn("hooks", `Skipping untrusted project hook in ${this.workingDirectory}: ${command}`);
    return false;
  }

  /** Get legacy hook configs that match a given target (e.g., tool name). */
  private getMatchingLegacyHooks(event: HookEvent, target: string): HookConfig[] {
    this.load();
    const configs = this.settings.hooks?.[event];
    if (!Array.isArray(configs)) return [];

    return configs
      .filter((config): config is HookConfig => isLegacyHookConfig(config))
      .filter((config) => safeRegexTest(config.matcher, target));
  }

  /** Get new-format hook entries that match the given context. */
  private getMatchingHookEntries(
    event: HookEvent,
    toolName?: string,
    context: Record<string, unknown> = {},
  ): HookEntry[] {
    this.load();
    const configs = this.settings.hooks?.[event];
    if (!Array.isArray(configs)) return [];

    return configs
      .filter((config): config is HookEntry => isHookEntry(config))
      .filter((entry) => matcherMatches(entry.matcher, toolName, context));
  }

  /**
   * Combined matching: returns both legacy HookConfigs and new HookEntries that match.
   * For backward compatibility, both formats are supported.
   */
  private getMatchingHooks(event: HookEvent, target: string): HookConfig[] {
    return this.getMatchingLegacyHooks(event, target);
  }

  // ─── PreToolUse ─────────────────────────────────────────────

  /**
   * Run PreToolUse hooks. These can:
   * - Allow the tool call (exit 0, decision "allow")
   * - Block the tool call (exit 2, or decision "deny"/"block")
   * - Modify the tool input (output updatedInput)
   * - Warn but allow (any other exit code)
   * - Inject context via stdout (appended to contextOutput)
   *
   * Supports both legacy HookConfig format and new HookEntry format.
   */
  async runPreToolUse(tool: ToolUseBlock): Promise<HookResult> {
    const legacyHooks = this.getMatchingLegacyHooks("PreToolUse", tool.name);
    const entryHooks = this.getMatchingHookEntries("PreToolUse", tool.name, {
      tool_name: tool.name,
      tool_id: tool.id,
      ...tool.input,
    });

    if (legacyHooks.length === 0 && entryHooks.length === 0) {
      return { allowed: true, warnings: [] };
    }

    let stdinData = JSON.stringify({
      event: "PreToolUse",
      tool_name: tool.name,
      tool_id: tool.id,
      tool_input: tool.input,
    });

    const warnings: string[] = [];
    const contextOutput: string[] = [];
    let currentInput = tool.input;

    // Run legacy hooks first
    for (const config of legacyHooks) {
      // Check workspace trust for project-level hooks
      if (!(await this.checkHookTrust(config as TaggedHook))) continue;

      for (const action of config.hooks) {
        const result = await executeHookAction(
          action,
          stdinData,
          this.workingDirectory,
        );

        // Exit code 2 = block the tool call
        if (result.exitCode === 2) {
          const output = parseHookOutput(result.stdout);
          return {
            allowed: false,
            reason: output?.reason ?? `Hook blocked: ${action.command ?? action.url ?? "unknown"}`,
            warnings,
            contextOutput: contextOutput.length > 0 ? contextOutput : undefined,
          };
        }

        // Exit code 0 = success, check output for decisions
        if (result.exitCode === 0) {
          const output = parseHookOutput(result.stdout);
          if (output) {
            if (output.decision === "deny" || output.decision === "block") {
              return {
                allowed: false,
                reason: output.reason ?? "Hook denied tool execution",
                warnings,
                contextOutput: contextOutput.length > 0 ? contextOutput : undefined,
              };
            }
            if (output.updatedInput) {
              currentInput = output.updatedInput;
              // Rebuild stdinData so subsequent hooks see the updated input
              stdinData = JSON.stringify({
                event: "PreToolUse",
                tool_name: tool.name,
                tool_id: tool.id,
                tool_input: currentInput,
              });
            }
          } else if (result.stdout) {
            // Non-JSON stdout is appended as context
            contextOutput.push(result.stdout);
          }
        } else {
          // Non-zero, non-2 exit code = warning only
          const label = action.command ?? action.url ?? "unknown";
          const message = result.stderr || result.stdout || `Hook "${label}" exited with code ${result.exitCode}`;
          warnings.push(message);
        }
      }
    }

    // Run new-format hook entries
    for (const entry of entryHooks) {
      // Check workspace trust for project-level hooks
      if (!(await this.checkHookTrust(entry as TaggedHook))) continue;

      const result = await executeHookEntry(entry, stdinData, this.workingDirectory);

      if (entry.type === "prompt") {
        // Prompt hooks always inject text as context
        if (result.stdout) {
          contextOutput.push(result.stdout);
        }
        continue;
      }

      // Command hooks follow the same exit code semantics
      if (result.exitCode === 2) {
        const output = parseHookOutput(result.stdout);
        return {
          allowed: false,
          reason: output?.reason ?? `Hook blocked: ${entry.command ?? "unknown"}`,
          warnings,
          contextOutput: contextOutput.length > 0 ? contextOutput : undefined,
        };
      }

      if (result.exitCode === 0) {
        const output = parseHookOutput(result.stdout);
        if (output) {
          if (output.decision === "deny" || output.decision === "block") {
            return {
              allowed: false,
              reason: output.reason ?? "Hook denied tool execution",
              warnings,
              contextOutput: contextOutput.length > 0 ? contextOutput : undefined,
            };
          }
          if (output.updatedInput) {
            currentInput = output.updatedInput;
            stdinData = JSON.stringify({
              event: "PreToolUse",
              tool_name: tool.name,
              tool_id: tool.id,
              tool_input: currentInput,
            });
          }
        } else if (result.stdout) {
          contextOutput.push(result.stdout);
        }
      } else {
        const label = entry.command ?? "unknown";
        const message = result.stderr || result.stdout || `Hook "${label}" exited with code ${result.exitCode}`;
        warnings.push(message);
      }
    }

    // Evaluate hookify rules (lower priority than explicit hooks)
    try {
      const hookifyResult = await evaluateHookifyRules(tool.name, currentInput as Record<string, unknown>, "PreToolUse");
      if (hookifyResult.decision === "block") {
        return {
          allowed: false,
          reason: hookifyResult.messages.join("\n") || "Blocked by hookify rule",
          warnings,
          contextOutput: contextOutput.length > 0 ? contextOutput : undefined,
        };
      }
      if (hookifyResult.decision === "warn" && hookifyResult.messages.length > 0) {
        warnings.push(...hookifyResult.messages);
      }
    } catch (err) {
      log.warn("hooks", `Hookify evaluation error: ${err instanceof Error ? err.message : err}`);
    }

    const inputChanged = currentInput !== tool.input;
    return {
      allowed: true,
      updatedInput: inputChanged ? currentInput : undefined,
      warnings,
      contextOutput: contextOutput.length > 0 ? contextOutput : undefined,
    };
  }

  // ─── PostToolUse ────────────────────────────────────────────

  /** Run PostToolUse hooks for logging/notification. These cannot block. */
  async runPostToolUse(tool: ToolUseBlock, result: ToolResult): Promise<{ warnings: string[]; contextOutput?: string[] }> {
    const legacyHooks = this.getMatchingLegacyHooks("PostToolUse", tool.name);
    const entryHooks = this.getMatchingHookEntries("PostToolUse", tool.name, {
      tool_name: tool.name,
      tool_id: tool.id,
      ...tool.input,
    });

    if (legacyHooks.length === 0 && entryHooks.length === 0) return { warnings: [] };

    const stdinData = JSON.stringify({
      event: "PostToolUse",
      tool_name: tool.name,
      tool_id: tool.id,
      tool_input: tool.input,
      tool_result: {
        content: result.content,
        is_error: result.is_error,
      },
    });

    const warnings: string[] = [];
    const contextOutput: string[] = [];

    // Legacy hooks
    for (const config of legacyHooks) {
      if (!(await this.checkHookTrust(config as TaggedHook))) continue;

      for (const action of config.hooks) {
        const hookResult = await executeHookAction(
          action,
          stdinData,
          this.workingDirectory,
        );

        if (hookResult.exitCode !== 0) {
          const label = action.command ?? action.url ?? "unknown";
          const message = hookResult.stderr || hookResult.stdout || `PostToolUse hook "${label}" exited with code ${hookResult.exitCode}`;
          warnings.push(message);
        } else if (hookResult.stdout && !parseHookOutput(hookResult.stdout)) {
          contextOutput.push(hookResult.stdout);
        }
      }
    }

    // New-format hooks
    for (const entry of entryHooks) {
      if (!(await this.checkHookTrust(entry as TaggedHook))) continue;

      const hookResult = await executeHookEntry(entry, stdinData, this.workingDirectory);
      if (entry.type === "prompt" && hookResult.stdout) {
        contextOutput.push(hookResult.stdout);
      } else if (hookResult.exitCode !== 0) {
        const label = entry.command ?? "unknown";
        warnings.push(hookResult.stderr || hookResult.stdout || `PostToolUse hook "${label}" exited with code ${hookResult.exitCode}`);
      } else if (hookResult.stdout && !parseHookOutput(hookResult.stdout)) {
        contextOutput.push(hookResult.stdout);
      }
    }

    return { warnings, contextOutput: contextOutput.length > 0 ? contextOutput : undefined };
  }

  // ─── PostToolUseFailure ────────────────────────────────────

  /** Run PostToolUseFailure hooks when a tool call errors. Cannot block. */
  async runPostToolUseFailure(tool: ToolUseBlock, error: string): Promise<{ warnings: string[] }> {
    const legacyHooks = this.getMatchingLegacyHooks("PostToolUseFailure", tool.name);
    const entryHooks = this.getMatchingHookEntries("PostToolUseFailure", tool.name, {
      tool_name: tool.name,
      tool_id: tool.id,
      error,
    });

    if (legacyHooks.length === 0 && entryHooks.length === 0) return { warnings: [] };

    const stdinData = JSON.stringify({
      event: "PostToolUseFailure",
      tool_name: tool.name,
      tool_id: tool.id,
      tool_input: tool.input,
      error,
    });

    const warnings: string[] = [];

    for (const config of legacyHooks) {
      if (!(await this.checkHookTrust(config as TaggedHook))) continue;

      for (const action of config.hooks) {
        const hookResult = await executeHookAction(action, stdinData, this.workingDirectory);
        if (hookResult.exitCode !== 0) {
          const label = action.command ?? action.url ?? "unknown";
          warnings.push(hookResult.stderr || hookResult.stdout || `PostToolUseFailure hook "${label}" exited with code ${hookResult.exitCode}`);
        }
      }
    }

    for (const entry of entryHooks) {
      if (!(await this.checkHookTrust(entry as TaggedHook))) continue;
      if (entry.type === "prompt") continue; // Prompt hooks don't apply to failure events
      const hookResult = await executeHookEntry(entry, stdinData, this.workingDirectory);
      if (hookResult.exitCode !== 0) {
        const label = entry.command ?? "unknown";
        warnings.push(hookResult.stderr || hookResult.stdout || `PostToolUseFailure hook "${label}" exited with code ${hookResult.exitCode}`);
      }
    }

    return { warnings };
  }

  // ─── Generic Event Hooks ────────────────────────────────────

  /**
   * Run hooks for non-tool events. Returns warnings and optional context output.
   * Supports all event types including: SessionStart, SessionEnd, PreCompact, PostCompact,
   * UserPromptSubmit, PermissionRequest, Stop, Notification, ConfigChange, InstructionsLoaded,
   * SubagentStart, SubagentStop, TaskCompleted, WorktreeCreate, WorktreeRemove.
   */
  async runEventHook(
    event: Exclude<HookEvent, "PreToolUse" | "PostToolUse" | "PostToolUseFailure">,
    context: Record<string, unknown> = {},
  ): Promise<{ warnings: string[]; contextOutput?: string[] }> {
    const legacyHooks = this.getMatchingLegacyHooks(event, event);
    const entryHooks = this.getMatchingHookEntries(event, undefined, context);

    if (legacyHooks.length === 0 && entryHooks.length === 0) return { warnings: [] };

    const stdinData = JSON.stringify({
      event,
      ...context,
    });

    const warnings: string[] = [];
    const contextOutput: string[] = [];

    // Legacy hooks
    for (const config of legacyHooks) {
      if (!(await this.checkHookTrust(config as TaggedHook))) continue;

      for (const action of config.hooks) {
        const result = await executeHookAction(
          action,
          stdinData,
          this.workingDirectory,
        );

        if (result.exitCode !== 0) {
          const label = action.command ?? action.url ?? "unknown";
          const message = result.stderr || result.stdout || `${event} hook "${label}" exited with code ${result.exitCode}`;
          warnings.push(message);
        } else if (result.stdout && !parseHookOutput(result.stdout)) {
          contextOutput.push(result.stdout);
        }
      }
    }

    // New-format hooks
    for (const entry of entryHooks) {
      if (!(await this.checkHookTrust(entry as TaggedHook))) continue;

      const result = await executeHookEntry(entry, stdinData, this.workingDirectory);
      if (entry.type === "prompt" && result.stdout) {
        contextOutput.push(result.stdout);
      } else if (result.exitCode !== 0) {
        const label = entry.command ?? "unknown";
        warnings.push(result.stderr || result.stdout || `${event} hook "${label}" exited with code ${result.exitCode}`);
      } else if (result.stdout && !parseHookOutput(result.stdout)) {
        contextOutput.push(result.stdout);
      }
    }

    return { warnings, contextOutput: contextOutput.length > 0 ? contextOutput : undefined };
  }

  // ─── Fire-and-forget hooks (non-blocking) ──────────────────

  /**
   * Fire a hook event without awaiting. Used for notification-style events
   * where we don't want to block the main flow.
   */
  fireAndForget(
    event: Exclude<HookEvent, "PreToolUse" | "PostToolUse" | "PostToolUseFailure">,
    context: Record<string, unknown> = {},
  ): void {
    if (!this.hasHooks(event)) return;
    this.runEventHook(event, context).catch((err) => {
      log.warn("hooks", `Fire-and-forget hook "${event}" error: ${err instanceof Error ? err.message : err}`);
    });
  }

  async runStopHook(
    event: "Stop" | "SubagentStop",
    context: Record<string, unknown> = {},
  ): Promise<{ blocked: boolean; reason?: string; warnings: string[] }> {
    const legacyHooks = this.getMatchingLegacyHooks(event, event);
    const entryHooks = this.getMatchingHookEntries(event, undefined, context);

    if (legacyHooks.length === 0 && entryHooks.length === 0) {
      return { blocked: false, warnings: [] };
    }

    const stdinData = JSON.stringify({ event, ...context });
    const warnings: string[] = [];

    for (const config of legacyHooks) {
      if (!(await this.checkHookTrust(config as TaggedHook))) continue;

      for (const action of config.hooks) {
        const result = await executeHookAction(action, stdinData, this.workingDirectory);

        if (result.exitCode === 2) {
          const output = parseHookOutput(result.stdout);
          return {
            blocked: true,
            reason: output?.reason ?? `Stop hook blocked: ${action.command ?? action.url ?? "unknown"}`,
            warnings,
          };
        }

        if (result.exitCode === 0) {
          const output = parseHookOutput(result.stdout);
          if (output?.decision === "deny" || output?.decision === "block") {
            return {
              blocked: true,
              reason: output.reason ?? "Stop hook blocked conversation end",
              warnings,
            };
          }
        } else {
          const label = action.command ?? action.url ?? "unknown";
          warnings.push(result.stderr || `${event} hook "${label}" exited with code ${result.exitCode}`);
        }
      }
    }

    for (const entry of entryHooks) {
      if (!(await this.checkHookTrust(entry as TaggedHook))) continue;

      const result = await executeHookEntry(entry, stdinData, this.workingDirectory);

      if (entry.type === "prompt") continue;

      if (result.exitCode === 2) {
        const output = parseHookOutput(result.stdout);
        return {
          blocked: true,
          reason: output?.reason ?? `Stop hook blocked: ${entry.command ?? "unknown"}`,
          warnings,
        };
      }

      if (result.exitCode === 0) {
        const output = parseHookOutput(result.stdout);
        if (output?.decision === "deny" || output?.decision === "block") {
          return {
            blocked: true,
            reason: output.reason ?? "Stop hook blocked conversation end",
            warnings,
          };
        }
      } else {
        const label = entry.command ?? "unknown";
        warnings.push(result.stderr || `${event} hook "${label}" exited with code ${result.exitCode}`);
      }
    }

    return { blocked: false, warnings };
  }

  /**
   * Run a pre-action hook that can block. Returns { allowed, reason }.
   * Used for PreEdit, PreBash, PreWrite hooks.
   */
  async runPreAction(
    event: "PreEdit" | "PreBash" | "PreWrite",
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<HookResult> {
    const legacyHooks = this.getMatchingLegacyHooks(event, toolName);
    const entryHooks = this.getMatchingHookEntries(event, toolName, { tool_name: toolName, ...input });

    if (legacyHooks.length === 0 && entryHooks.length === 0) return { allowed: true, warnings: [] };

    const stdinData = JSON.stringify({
      event,
      tool_name: toolName,
      tool_input: input,
    });

    const warnings: string[] = [];
    const contextOutput: string[] = [];

    // Legacy hooks
    for (const config of legacyHooks) {
      if (!(await this.checkHookTrust(config as TaggedHook))) continue;

      for (const action of config.hooks) {
        const result = await executeHookAction(action, stdinData, this.workingDirectory);

        if (result.exitCode === 2) {
          const output = parseHookOutput(result.stdout);
          return {
            allowed: false,
            reason: output?.reason ?? `${event} hook blocked: ${action.command ?? action.url ?? "unknown"}`,
            warnings,
            contextOutput: contextOutput.length > 0 ? contextOutput : undefined,
          };
        }

        if (result.exitCode === 0) {
          const output = parseHookOutput(result.stdout);
          if (output?.decision === "deny" || output?.decision === "block") {
            return { allowed: false, reason: output.reason ?? `${event} hook denied`, warnings };
          }
          if (result.stdout && !output) {
            contextOutput.push(result.stdout);
          }
        } else {
          const label = action.command ?? action.url ?? "unknown";
          warnings.push(result.stderr || `${event} hook "${label}" exited with code ${result.exitCode}`);
        }
      }
    }

    // New-format hooks
    for (const entry of entryHooks) {
      if (!(await this.checkHookTrust(entry as TaggedHook))) continue;

      const result = await executeHookEntry(entry, stdinData, this.workingDirectory);

      if (entry.type === "prompt") {
        if (result.stdout) contextOutput.push(result.stdout);
        continue;
      }

      if (result.exitCode === 2) {
        const output = parseHookOutput(result.stdout);
        return {
          allowed: false,
          reason: output?.reason ?? `${event} hook blocked: ${entry.command ?? "unknown"}`,
          warnings,
          contextOutput: contextOutput.length > 0 ? contextOutput : undefined,
        };
      }

      if (result.exitCode === 0) {
        const output = parseHookOutput(result.stdout);
        if (output?.decision === "deny" || output?.decision === "block") {
          return { allowed: false, reason: output.reason ?? `${event} hook denied`, warnings };
        }
        if (result.stdout && !output) {
          contextOutput.push(result.stdout);
        }
      } else {
        const label = entry.command ?? "unknown";
        warnings.push(result.stderr || `${event} hook "${label}" exited with code ${result.exitCode}`);
      }
    }

    return {
      allowed: true,
      warnings,
      contextOutput: contextOutput.length > 0 ? contextOutput : undefined,
    };
  }
}
