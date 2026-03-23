// KCode - Permission System
// Gates tool execution based on permission mode and safety analysis

import type { PermissionMode, PermissionRule, PermissionRuleAction, ToolUseBlock, BashInput, FileWriteInput, FileEditInput } from "./types";
import { resolve, isAbsolute } from "node:path";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { log } from "./logger";
import { generateDiff, formatDiffPreview } from "./diff";

// ─── Types ──────────────────────────────────────────────────────

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  /** If set, the tool input should be replaced with this */
  updatedInput?: Record<string, unknown>;
}

export interface PermissionPromptRequest {
  toolName: string;
  toolInput: Record<string, unknown>;
  summary: string;
  riskLevel: "safe" | "moderate" | "dangerous";
}

/** Callback the UI provides so PermissionManager can prompt the user. */
export type PermissionPromptFn = (
  request: PermissionPromptRequest,
) => Promise<{ granted: boolean; alwaysAllow?: boolean }>;

// ─── Safety Analysis ────────────────────────────────────────────

/** Shells that should not be invoked directly */
const SHELL_BINARIES = new Set([
  "sh", "bash", "zsh", "fish", "csh", "tcsh", "ksh", "dash",
  "/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/sh", "/usr/bin/bash",
  "/usr/bin/zsh", "/usr/bin/env",
]);

/** Extract the base command (first token) from a shell command string */
export function extractCommandPrefix(command: string): string {
  const trimmed = command.trimStart();
  // Handle env prefix: env VAR=val cmd → cmd
  if (trimmed.startsWith("env ")) {
    const parts = trimmed.split(/\s+/).slice(1);
    // Skip VAR=val pairs
    for (const part of parts) {
      if (!part.includes("=")) return part;
    }
  }
  // Handle sudo prefix
  if (trimmed.startsWith("sudo ")) {
    const afterSudo = trimmed.slice(5).trimStart();
    return afterSudo.split(/\s+/)[0] ?? "";
  }
  return trimmed.split(/\s+/)[0] ?? "";
}

/** Detect command injection patterns */
export function detectCommandInjection(command: string): string | null {
  // Backtick substitution
  if (/`[^`]+`/.test(command)) {
    return "Command contains backtick substitution";
  }

  // $() command substitution (but not simple $VAR)
  if (/\$\(/.test(command)) {
    return "Command contains $() command substitution";
  }

  // Subshell via ( )
  // Only flag if it looks like a subshell, not just grouping in arguments
  if (/;\s*\(/.test(command) || /\|\s*\(/.test(command) || /^\s*\(/.test(command)) {
    return "Command contains subshell invocation";
  }

  return null;
}

/** Detect dangerous redirections */
export function detectDangerousRedirections(command: string): string | null {
  // Skip redirections inside quotes
  const unquoted = stripQuotedStrings(command);

  // Overwrite redirection to important files
  if (/>\s*\/etc\//.test(unquoted) || />\s*\/dev\/sd/.test(unquoted)) {
    return "Command redirects to sensitive system path";
  }

  // General write redirection (>, >>)
  if (/>{1,2}\s*\S/.test(unquoted)) {
    return "Command contains output redirection";
  }

  return null;
}

/** Detect pipe-to-shell patterns like `curl url | bash` */
export function detectPipeToShell(command: string): string | null {
  // Strip quoted strings so we don't match pipes inside quotes
  const unquoted = stripQuotedStrings(command);

  // Split on unquoted pipe characters
  const segments = unquoted.split("|");
  if (segments.length < 2) return null;

  // Check each segment after the first
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i].trimStart();
    const prefix = extractCommandPrefix(segment);
    const basename = prefix.split("/").pop() ?? prefix;

    // Direct shell: ... | bash, ... | sh, etc.
    if (SHELL_BINARIES.has(prefix) || SHELL_BINARIES.has(basename)) {
      return `Command pipes to shell: ${basename}`;
    }

    // sudo shell: ... | sudo bash, ... | sudo sh, etc.
    if (prefix === "sudo") {
      const afterSudo = segment.replace(/^\s*sudo\s+/, "");
      const sudoTarget = afterSudo.split(/\s+/)[0] ?? "";
      const sudoBasename = sudoTarget.split("/").pop() ?? sudoTarget;
      if (SHELL_BINARIES.has(sudoTarget) || SHELL_BINARIES.has(sudoBasename)) {
        return `Command pipes to shell: sudo ${sudoBasename}`;
      }
    }
  }

  return null;
}

/** Detect direct shell invocation */
export function detectShellInvocation(command: string): string | null {
  const prefix = extractCommandPrefix(command);
  const basename = prefix.split("/").pop() ?? prefix;

  if (SHELL_BINARIES.has(prefix) || SHELL_BINARIES.has(basename)) {
    // Allow "bash -c 'simple'" but flag "bash" alone or "bash script.sh"
    const trimmed = command.trimStart();
    const afterCmd = trimmed.slice(prefix.length).trimStart();
    if (!afterCmd.startsWith("-c ")) {
      return `Direct shell invocation: ${basename}`;
    }
  }

  return null;
}

/** Detect quote desync patterns in comments */
export function detectQuoteDesync(command: string): string | null {
  // Look for unmatched quotes that could indicate injection via comments
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    }

    // If we hit a # outside quotes, anything after is a comment
    if (ch === "#" && !inSingle && !inDouble) {
      const remainder = command.slice(i + 1);
      // Check if the comment contains unmatched quotes
      const singleCount = (remainder.match(/'/g) ?? []).length;
      const doubleCount = (remainder.match(/"/g) ?? []).length;
      if (singleCount % 2 !== 0 || doubleCount % 2 !== 0) {
        return "Unmatched quotes in comment may indicate injection attempt";
      }
      break; // Rest is comment, stop analysis
    }
  }

  if (inSingle || inDouble) {
    return "Command has unmatched quotes";
  }

  return null;
}

/** Strip quoted strings to analyze the unquoted portions */
function stripQuotedStrings(command: string): string {
  // Replace single-quoted strings
  let result = command.replace(/'[^']*'/g, "''");
  // Replace double-quoted strings (handle escaped quotes)
  result = result.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return result;
}

/** Full bash command safety analysis */
export function analyzeBashCommand(command: string): {
  safe: boolean;
  issues: string[];
  riskLevel: "safe" | "moderate" | "dangerous";
} {
  const issues: string[] = [];

  const injection = detectCommandInjection(command);
  if (injection) issues.push(injection);

  const redirection = detectDangerousRedirections(command);
  if (redirection) issues.push(redirection);

  const shellInvoke = detectShellInvocation(command);
  if (shellInvoke) issues.push(shellInvoke);

  const quoteDesync = detectQuoteDesync(command);
  if (quoteDesync) issues.push(quoteDesync);

  const pipeToShell = detectPipeToShell(command);
  if (pipeToShell) issues.push(pipeToShell);

  let riskLevel: "safe" | "moderate" | "dangerous" =
    issues.length === 0 ? "safe" :
    issues.some((i) =>
      i.includes("injection") || i.includes("shell invocation") || i.includes("sensitive system path") || i.includes("pipes to shell")
    )
      ? "dangerous"
      : "moderate";

  // Sudo commands are at least moderate risk
  if (/\bsudo\b/.test(command) && riskLevel === "safe") {
    riskLevel = "moderate";
  }

  return { safe: issues.length === 0, issues, riskLevel };
}

// ─── Write Validation ───────────────────────────────────────────

export function validateFileWritePath(filePath: string, workingDirectory: string, additionalDirs?: string[]): PermissionResult {
  if (!isAbsolute(filePath)) {
    return {
      allowed: false,
      reason: `File path must be absolute, got: ${filePath}`,
    };
  }

  let resolved = resolve(filePath);

  // Resolve symlinks to prevent directory traversal via symlink chains
  try {
    if (existsSync(resolved)) {
      // File exists — resolve the full path including the final component
      // This prevents symlink attacks where the file itself is a symlink
      // (e.g., /tmp/project/secret.txt -> /etc/passwd)
      resolved = realpathSync(resolved);
    } else {
      // File doesn't exist yet — resolve the parent directory only
      const dir = resolved.split("/").slice(0, -1).join("/");
      if (dir && existsSync(dir)) {
        const realDir = realpathSync(dir);
        const basename = resolved.split("/").pop() ?? "";
        resolved = realDir + "/" + basename;
      }
    }
  } catch {
    // If realpath fails, continue with resolved path
  }

  // Block writes to system directories (checked first for specific error messages)
  const PROTECTED_DIRS = [
    "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64",
    "/boot", "/proc", "/sys", "/dev", "/var/run", "/var/lock",
  ];
  for (const dir of PROTECTED_DIRS) {
    if (resolved.startsWith(dir + "/") || resolved === dir) {
      return {
        allowed: false,
        reason: `Write blocked: "${resolved}" is in a protected system directory`,
      };
    }
  }

  // Block writes to sensitive home directory dotfiles/dirs
  const home = process.env.HOME ?? "/root";
  const SENSITIVE_HOME_PATTERNS = [
    ".ssh", ".gnupg", ".gpg", ".aws", ".azure", ".kube", ".docker",
    ".config/gcloud", ".config/gh",
    ".npmrc", ".pypirc", ".netrc", ".git-credentials",
  ];
  for (const pattern of SENSITIVE_HOME_PATTERNS) {
    const fullPath = `${home}/${pattern}`;
    if (resolved.startsWith(fullPath + "/") || resolved === fullPath) {
      return {
        allowed: false,
        reason: `Write blocked: "${pattern}" contains sensitive credentials`,
      };
    }
  }

  // Block writes outside the working directory (unless explicitly to /tmp or an additional dir)
  const inAdditionalDir = additionalDirs?.some((d) => resolved.startsWith(d)) ?? false;
  if (!resolved.startsWith(workingDirectory) && !resolved.startsWith("/tmp") && !inAdditionalDir) {
    return {
      allowed: false,
      reason: `Write blocked: path "${resolved}" is outside working directory "${workingDirectory}"`,
    };
  }

  // Block writes to dotfiles that control shell/tool behavior
  const basename = resolved.split("/").pop() ?? "";
  const sensitiveFiles = [
    ".env", ".env.local", ".env.production",
    ".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile",
    ".gitconfig", ".gitignore_global",
  ];
  if (sensitiveFiles.includes(basename)) {
    return {
      allowed: false,
      reason: `Write blocked: "${basename}" is a sensitive configuration file`,
    };
  }

  return { allowed: true };
}

// ─── Read-Only Tools ────────────────────────────────────────────

/** Tools that only read data and don't modify anything */
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep"]);

/** Tools that modify the filesystem or environment */
const WRITE_TOOLS = new Set(["Bash", "Write", "Edit"]);

/** Tools auto-allowed in acceptEdits mode (everything except Bash) */
const ACCEPT_EDITS_TOOLS = new Set([
  "Read", "Write", "Edit", "MultiEdit", "GrepReplace", "Rename",
  "Glob", "Grep", "WebFetch", "WebSearch", "Learn", "Agent", "Tasks",
]);

// ─── Permission Rules Engine ────────────────────────────────────

export interface ParsedToolRule {
  tool: string;
  pattern?: string;
}

/**
 * Parse a tool rule string into its components.
 *
 * Supported formats:
 *   "Bash(git add:*)"     -> { tool: "Bash", pattern: "git add:*" }
 *   "Bash(npm:*)"         -> { tool: "Bash", pattern: "npm:*" }
 *   "Bash(rm:-rf)"        -> { tool: "Bash", pattern: "rm:-rf" }
 *   "Read(src/**)"        -> { tool: "Read", pattern: "src/**" }
 *   "Write(*.test.ts)"    -> { tool: "Write", pattern: "*.test.ts" }
 *   "mcp__server__*"      -> { tool: "mcp__server__*" }
 *   "Bash"                -> { tool: "Bash" }
 */
export function parseToolRule(rule: string): ParsedToolRule {
  const m = rule.match(/^(\w+)\((.+)\)$/);
  if (m) return { tool: m[1]!, pattern: m[2]! };
  return { tool: rule };
}

/**
 * Generate the most specific auto-allow rule for a tool call.
 * For Bash commands, extracts the command prefix and suggests "Bash(cmd:*)".
 * For file tools, suggests matching the file path pattern.
 * For MCP tools, suggests matching the full tool name.
 */
export function suggestRule(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash": {
      const command = (input as unknown as BashInput).command ?? "";
      const parts = command.trimStart().split(/\s+/);
      const base = parts[0] ?? "";
      if (parts.length > 1) {
        const subcommand = parts[1] ?? "";
        if (/^[a-z]/.test(subcommand) && !subcommand.startsWith("-")) {
          return `Bash(${base} ${subcommand}:*)`;
        }
      }
      return `Bash(${base}:*)`;
    }
    case "Read": {
      const filePath = (input as { file_path?: string }).file_path ?? "";
      const dir = filePath.split("/").slice(0, -1).join("/");
      return `Read(${dir}/**)`;
    }
    case "Write": {
      const filePath = (input as { file_path?: string }).file_path ?? "";
      const ext = filePath.split(".").pop() ?? "";
      if (ext) return `Write(**.${ext})`;
      const dir = filePath.split("/").slice(0, -1).join("/");
      return `Write(${dir}/**)`;
    }
    case "Edit": {
      const filePath = (input as { file_path?: string }).file_path ?? "";
      const ext = filePath.split(".").pop() ?? "";
      if (ext) return `Edit(**.${ext})`;
      const dir = filePath.split("/").slice(0, -1).join("/");
      return `Edit(${dir}/**)`;
    }
    default: {
      if (toolName.startsWith("mcp__")) {
        const parts = toolName.split("__");
        if (parts.length >= 3) {
          return `${parts[0]}__${parts[1]}__*`;
        }
      }
      return toolName;
    }
  }
}

/**
 * Parse a rule pattern like "Bash(npm run *)" into { tool, innerPattern }.
 * Plain tool names like "Read" match with innerPattern = "*".
 * MCP-style patterns like "mcp__server__*" match tool name directly.
 */
function parseRulePattern(pattern: string): { tool: string; innerPattern: string } | null {
  // ToolName(pattern) format
  const m = pattern.match(/^(\w+)\((.+)\)$/);
  if (m) return { tool: m[1]!, innerPattern: m[2]! };

  // Plain tool name or wildcard like "mcp__*"
  if (/^[\w*_]+$/.test(pattern)) return { tool: pattern, innerPattern: "*" };

  return null;
}

/**
 * Simple glob match supporting * and ** wildcards.
 * - "*" matches any sequence except "/"
 * - "**" matches any sequence including "/"
 */
function globMatch(pattern: string, value: string): boolean {
  // Escape regex special chars except * and ?
  let regex = pattern.replace(/([.+^${}()|[\]\\])/g, "\\$1");
  // ** → match everything including /
  regex = regex.replace(/\*\*/g, "<<GLOBSTAR>>");
  // * → match everything except /
  regex = regex.replace(/\*/g, "[^/]*");
  regex = regex.replace(/<<GLOBSTAR>>/g, ".*");
  return new RegExp(`^${regex}$`).test(value);
}

/**
 * Extract the matchable value from a tool call for rule comparison.
 * - Bash → the full command string
 * - Edit/Write → the file_path
 * - WebFetch → "domain:<hostname>" or the full URL
 * - Others → the tool name
 */
function getToolMatchValue(tool: ToolUseBlock): string {
  switch (tool.name) {
    case "Bash": {
      const input = tool.input as unknown as BashInput;
      return input.command;
    }
    case "Write": {
      const input = tool.input as unknown as FileWriteInput;
      return input.file_path;
    }
    case "Edit": {
      const input = tool.input as unknown as FileEditInput;
      return input.file_path;
    }
    case "MultiEdit": {
      // Match against all files in the edits array — rule must match every path
      const input = tool.input as { edits?: Array<{ file_path?: string }> };
      const paths = (input.edits ?? []).map(e => e.file_path ?? "").filter(Boolean);
      return paths.join("\n") || "";
    }
    case "GrepReplace": {
      const input = tool.input as { path?: string };
      return input.path ?? "";
    }
    case "Rename": {
      const input = tool.input as { scope?: string; symbol?: string };
      return input.scope ?? input.symbol ?? "";
    }
    case "WebFetch": {
      const input = tool.input as { url?: string };
      if (input.url) {
        try {
          const u = new URL(input.url);
          return u.hostname;
        } catch { return input.url; }
      }
      return "";
    }
    case "Read": {
      const input = tool.input as { file_path?: string };
      return input.file_path ?? "";
    }
    case "Glob": {
      const input = tool.input as { pattern?: string; path?: string };
      return input.path ?? input.pattern ?? "";
    }
    case "Grep": {
      const input = tool.input as { path?: string; pattern?: string };
      return input.path ?? input.pattern ?? "";
    }
    case "WebSearch": {
      const input = tool.input as { query?: string };
      return input.query ?? "";
    }
    default:
      return tool.name;
  }
}

/**
 * Simple wildcard match for Bash command arguments.
 * Uses `*` to match any sequence of characters (including `/` and spaces),
 * since Bash args are flat strings, not file paths.
 */
function bashWildcardMatch(pattern: string, value: string): boolean {
  let regex = pattern.replace(/([.+^${}()|[\]\\])/g, "\\$1");
  regex = regex.replace(/\*/g, ".*");
  return new RegExp(`^${regex}$`).test(value);
}

/**
 * Match a Bash command against a compound "cmd:args" pattern.
 * "git add:*" matches "git add .", "git add -A", etc.
 * "npm:*" matches "npm install", "npm run test", etc.
 * "rm:-rf" matches "rm -rf" exactly (no trailing args).
 */
function matchBashCompound(pattern: string, command: string): boolean {
  const colonIdx = pattern.indexOf(":");
  if (colonIdx === -1) return globMatch(pattern, command);

  const cmdPrefix = pattern.slice(0, colonIdx);
  const argsPattern = pattern.slice(colonIdx + 1);
  const trimmedCmd = command.trimStart();

  if (!trimmedCmd.startsWith(cmdPrefix)) return false;

  const afterPrefix = trimmedCmd.slice(cmdPrefix.length);
  if (afterPrefix.length === 0) return argsPattern === "*" || argsPattern === "";
  if (afterPrefix[0] !== " ") return false;

  const actualArgs = afterPrefix.slice(1);
  return bashWildcardMatch(argsPattern, actualArgs);
}

/**
 * Evaluate permission rules against a tool call. First match wins.
 * Returns the action if a rule matches, or null for fallback to mode-based logic.
 *
 * Supports compound rules:
 *   Bash(git add:*)   - match git add with any args
 *   Bash(npm:*)        - match all npm commands
 *   Bash(rm:-rf)       - match rm -rf specifically
 *   Read(src/**)       - match reading files under src/
 *   Write(*.test.ts)   - match writing test files
 *   mcp__server__*     - match all tools from an MCP server
 */
export function evaluateRules(rules: PermissionRule[], tool: ToolUseBlock): PermissionRuleAction | null {
  const matchValue = getToolMatchValue(tool);

  for (const rule of rules) {
    const parsed = parseRulePattern(rule.pattern);
    if (!parsed) continue;

    // Check tool name match (supports wildcards for MCP tools)
    const toolMatches = parsed.tool === tool.name || globMatch(parsed.tool, tool.name);
    if (!toolMatches) continue;

    // Check inner pattern
    if (parsed.innerPattern === "*") return rule.action;

    // For WebFetch, inner pattern can be "domain:example.com"
    if (tool.name === "WebFetch" && parsed.innerPattern.startsWith("domain:")) {
      const domain = parsed.innerPattern.slice(7);
      if (globMatch(domain, matchValue)) return rule.action;
      continue;
    }

    // For Bash commands, support compound "cmd:args" patterns
    if (tool.name === "Bash" && parsed.innerPattern.includes(":")) {
      if (matchBashCompound(parsed.innerPattern, matchValue)) return rule.action;
      continue;
    }

    // For MultiEdit, matchValue contains newline-separated paths — rule must match ALL
    if (matchValue.includes("\n")) {
      const allMatch = matchValue.split("\n").every(v => globMatch(parsed.innerPattern, v));
      if (allMatch) return rule.action;
      continue;
    }

    // Match inner pattern against value
    if (globMatch(parsed.innerPattern, matchValue)) return rule.action;
  }

  return null;
}

// ─── Permission Manager ────────────────────────────────────────

export class PermissionManager {
  private mode: PermissionMode;
  private workingDirectory: string;
  private additionalDirs?: string[];
  private promptFn: PermissionPromptFn | null = null;
  private rules: PermissionRule[] = [];

  /** Allowlist of previously approved tool+pattern combos: "ToolName:pattern" */
  private allowlist = new Set<string>();

  constructor(mode: PermissionMode, workingDirectory: string, additionalDirs?: string[], rules?: PermissionRule[]) {
    this.mode = mode;
    this.workingDirectory = workingDirectory;
    this.additionalDirs = additionalDirs;
    this.rules = rules ?? [];
  }

  /** Get the current permission rules. */
  getRules(): PermissionRule[] {
    return this.rules;
  }

  /** Add a permission rule at runtime. */
  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  /** Set the callback used to prompt the user in "ask" mode. */
  setPromptFn(fn: PermissionPromptFn): void {
    this.promptFn = fn;
  }

  /** Get the current permission mode. */
  getMode(): PermissionMode {
    return this.mode;
  }

  /** Change the permission mode at runtime. */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** Add a tool+pattern combo to the permanent allowlist. */
  addToAllowlist(toolName: string, pattern: string): void {
    this.allowlist.add(`${toolName}:${pattern}`);
  }

  /** Check if a tool+pattern combo is in the allowlist. */
  isAllowlisted(toolName: string, pattern: string): boolean {
    return this.allowlist.has(`${toolName}:${pattern}`);
  }

  /** Clear the allowlist. */
  clearAllowlist(): void {
    this.allowlist.clear();
  }

  /**
   * Check whether a tool call is permitted.
   * This is the main entry point, called between receiving a tool_use block
   * and actually executing the tool.
   */
  async checkPermission(tool: ToolUseBlock): Promise<PermissionResult> {
    // Dynamic plan mode (via EnterPlanMode tool) — blocks write tools
    try {
      const { isPlanModeActive, PLAN_MODE_ALLOWED_TOOLS } = await import("../tools/plan-mode.js");
      if (isPlanModeActive() && !PLAN_MODE_ALLOWED_TOOLS.has(tool.name)) {
        return {
          allowed: false,
          reason: `Plan mode active: "${tool.name}" is blocked. Only read-only and planning tools are allowed. Use ExitPlanMode to return to normal mode.`,
        };
      }
    } catch {
      // plan-mode module not loaded yet, skip
    }

    // Deny mode blocks everything
    if (this.mode === "deny") {
      return { allowed: false, reason: "Permission mode is 'deny': all tool use is blocked" };
    }

    // Plan mode allows only read-only tools
    if (this.mode === "plan") {
      if (READ_ONLY_TOOLS.has(tool.name)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `Permission mode is 'plan': only read-only tools are allowed (tried: ${tool.name})`,
      };
    }

    // Evaluate per-tool rules (first match wins, before mode-based logic)
    if (this.rules.length > 0) {
      const ruleAction = evaluateRules(this.rules, tool);
      if (ruleAction === "deny") {
        return { allowed: false, reason: "Blocked by permission rule" };
      }
      if (ruleAction === "allow") {
        // Run full safety analysis even for "allow" rules — only skip the permission prompt
        const safetyResult = this.analyzeToolSafety(tool);
        if (!safetyResult.allowed) {
          return safetyResult;
        }
        return { allowed: true };
      }
      // ruleAction === "ask" falls through to normal mode-based logic
    }

    // For read-only tools, always allow (in ask, auto, or acceptEdits mode)
    if (READ_ONLY_TOOLS.has(tool.name)) {
      return { allowed: true };
    }

    // acceptEdits mode: auto-allow all tools except Bash, which requires prompting
    if (this.mode === "acceptEdits") {
      if (ACCEPT_EDITS_TOOLS.has(tool.name)) {
        // Still enforce hard safety checks for Write/Edit
        const safetyResult = this.analyzeToolSafety(tool);
        if (!safetyResult.allowed && safetyResult.reason?.includes("must be absolute")) {
          return safetyResult;
        }
        return { allowed: true };
      }
      // For Bash (and any unknown tools), fall through to ask-mode prompting below
    }

    // Run safety analysis for write tools
    const safetyResult = this.analyzeToolSafety(tool);

    // If safety analysis blocks it outright, deny regardless of mode
    if (!safetyResult.allowed && safetyResult.reason?.includes("must be absolute")) {
      return safetyResult;
    }

    // Auto mode allows everything that passes safety
    if (this.mode === "auto") {
      return safetyResult;
    }

    // Ask mode: check allowlist first
    const pattern = this.getToolPattern(tool);
    if (this.isAllowlisted(tool.name, pattern)) {
      // Still enforce hard safety blocks
      if (!safetyResult.allowed && safetyResult.reason?.includes("must be absolute")) {
        return safetyResult;
      }
      return { allowed: true };
    }

    // Prompt the user
    if (!this.promptFn) {
      return { allowed: false, reason: "No permission prompt function configured" };
    }

    const summary = this.summarizeTool(tool);
    const riskLevel = this.getToolRiskLevel(tool, safetyResult);

    log.debug("permission", `Prompting user for ${tool.name} (risk: ${riskLevel}): ${summary}`);

    const response = await this.promptFn({
      toolName: tool.name,
      toolInput: tool.input,
      summary,
      riskLevel,
    });

    if (response.granted) {
      if (response.alwaysAllow) {
        this.addToAllowlist(tool.name, pattern);
      }
      return { allowed: true };
    }

    log.debug("permission", `User denied ${tool.name}`);
    return { allowed: false, reason: "User denied permission" };
  }

  /** Analyze tool-specific safety concerns. */
  private analyzeToolSafety(tool: ToolUseBlock): PermissionResult {
    switch (tool.name) {
      case "Bash": {
        const input = tool.input as unknown as BashInput;
        const analysis = analyzeBashCommand(input.command);
        if (!analysis.safe) {
          return {
            allowed: false,
            reason: `Bash safety issue: ${analysis.issues.join("; ")}`,
          };
        }
        return { allowed: true };
      }

      case "Write": {
        const input = tool.input as unknown as FileWriteInput;
        return validateFileWritePath(input.file_path, this.workingDirectory, this.additionalDirs);
      }

      case "Edit": {
        const input = tool.input as unknown as FileEditInput;
        return validateFileWritePath(input.file_path, this.workingDirectory, this.additionalDirs);
      }

      case "MultiEdit": {
        const edits = (tool.input.edits ?? []) as Array<{ file_path?: string }>;
        for (const edit of edits) {
          if (!edit.file_path) continue;
          const result = validateFileWritePath(edit.file_path, this.workingDirectory, this.additionalDirs);
          if (!result.allowed) return result;
        }
        return { allowed: true };
      }

      // Cron tools modify system state — always require safety check
      case "CronCreate":
      case "CronDelete":
        return { allowed: true }; // Safe but will be prompted via permission mode

      // Worktree tools are safe (they use git internals)
      case "EnterWorktree":
      case "ExitWorktree":
        return { allowed: true };

      // Skill execution — safe (just expands templates)
      case "Skill":
        return { allowed: true };

      // Plan mode tools — always safe
      case "EnterPlanMode":
      case "ExitPlanMode":
        return { allowed: true };

      // Diff viewer — read-only, safe
      case "DiffView":
        return { allowed: true };

      // Test runner — executes tests, treated like Bash
      case "TestRunner":
        return { allowed: true }; // Safe but will be prompted via permission mode

      // Rename — modifies files, needs confirmation
      case "Rename":
        return { allowed: true }; // Will be prompted via permission mode like Write/Edit

      // Clipboard — safe, copies to clipboard
      case "Clipboard":
        return { allowed: true };

      // Undo — modifies files (restores previous state), needs confirmation
      case "Undo":
        return { allowed: true };

      // Git tools
      case "GitStatus":
      case "GitLog":
        return { allowed: true }; // Read-only, safe

      case "GitCommit":
        return { allowed: true }; // Write operation, prompted via permission mode

      // GrepReplace — modifies files, needs confirmation
      case "GrepReplace":
        return { allowed: true };

      // Stash — saves/restores conversation context (safe, in-memory only)
      case "Stash":
        return { allowed: true };

      // AskUser — prompts user for input (safe, no side effects)
      case "AskUser":
        return { allowed: true };

      // LSP — read-only code intelligence queries (safe)
      case "LSP":
        return { allowed: true };

      // ToolSearch — read-only tool schema lookup (safe)
      case "ToolSearch":
        return { allowed: true };

      default:
        return { allowed: true };
    }
  }

  /** Extract a pattern string for allowlist matching. */
  private getToolPattern(tool: ToolUseBlock): string {
    switch (tool.name) {
      case "Bash": {
        const input = tool.input as unknown as BashInput;
        return extractCommandPrefix(input.command);
      }
      case "MultiEdit": {
        const edits = ((tool.input as any).edits ?? []) as Array<{ file_path?: string }>;
        const firstPath = edits[0]?.file_path ?? "";
        const parts = firstPath.split("/");
        parts.pop();
        return parts.join("/") || "/";
      }
      case "Write":
      case "Edit": {
        const input = tool.input as { file_path?: string };
        // Use the directory as the pattern
        const filePath = input.file_path ?? "";
        const parts = filePath.split("/");
        parts.pop(); // remove filename
        return parts.join("/") || "/";
      }
      default:
        return tool.name;
    }
  }

  /** Create a human-readable summary of what the tool wants to do. */
  private summarizeTool(tool: ToolUseBlock): string {
    switch (tool.name) {
      case "Bash": {
        const input = tool.input as unknown as BashInput;
        const cmd = input.command.length > 120
          ? input.command.slice(0, 120) + "..."
          : input.command;
        return `Run command: ${cmd}`;
      }
      case "Write": {
        const input = tool.input as unknown as FileWriteInput;
        let summary = `Write file: ${input.file_path}`;
        try {
          if (existsSync(input.file_path)) {
            const oldContent = readFileSync(input.file_path, "utf-8");
            const diff = generateDiff(oldContent, input.content, input.file_path);
            if (diff.length > 0) {
              summary += "\n" + formatDiffPreview(diff, 30);
            }
          }
        } catch {
          // If we can't read the file, just show the basic summary
        }
        return summary;
      }
      case "Edit": {
        const input = tool.input as unknown as FileEditInput;
        let summary = `Edit file: ${input.file_path}`;
        try {
          if (existsSync(input.file_path)) {
            const oldContent = readFileSync(input.file_path, "utf-8");
            const updated = input.replace_all
              ? oldContent.replaceAll(input.old_string, input.new_string)
              : oldContent.replace(input.old_string, input.new_string);
            const diff = generateDiff(oldContent, updated, input.file_path);
            if (diff.length > 0) {
              summary += "\n" + formatDiffPreview(diff, 30);
            }
          }
        } catch {
          // If we can't read the file, just show the basic summary
        }
        return summary;
      }
      default:
        return `Execute ${tool.name}`;
    }
  }

  /** Determine the risk level for the UI prompt. */
  private getToolRiskLevel(
    tool: ToolUseBlock,
    safetyResult: PermissionResult,
  ): "safe" | "moderate" | "dangerous" {
    if (!safetyResult.allowed) return "dangerous";

    if (tool.name === "Bash") {
      const input = tool.input as unknown as BashInput;
      const analysis = analyzeBashCommand(input.command);

      // Elevate risk for security tools
      const cmdWords = input.command.trimStart().split(/\s+/);
      const baseCmd = (cmdWords[0] === "sudo" ? cmdWords[1] : cmdWords[0]) ?? "";
      const ELEVATED_RISK_TOOLS = new Set([
        "msfconsole", "nmap", "nikto", "sqlmap", "hydra", "john", "hashcat",
        "aircrack", "aircrack-ng", "gobuster", "masscan", "wireshark", "tshark",
        "responder", "crackmapexec", "enum4linux", "wfuzz", "dirb", "setoolkit",
        "tcpdump", "searchsploit", "metasploit", "beef",
      ]);
      if (ELEVATED_RISK_TOOLS.has(baseCmd)) {
        return "dangerous";
      }

      return analysis.riskLevel;
    }

    if (tool.name === "Write" || tool.name === "Edit") {
      return "moderate";
    }

    return "safe";
  }
}
