// KCode - Permission System
// Gates tool execution based on permission mode and safety analysis

import type { PermissionMode, ToolUseBlock, BashInput, FileWriteInput, FileEditInput } from "./types";
import { resolve, isAbsolute } from "node:path";
import { readFileSync, existsSync } from "node:fs";
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

  const riskLevel =
    issues.length === 0 ? "safe" :
    issues.some((i) =>
      i.includes("injection") || i.includes("shell invocation") || i.includes("sensitive system path") || i.includes("pipes to shell")
    )
      ? "dangerous"
      : "moderate";

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

  const resolved = resolve(filePath);

  // Block writes outside the working directory (unless explicitly to /tmp or an additional dir)
  const inAdditionalDir = additionalDirs?.some((d) => resolved.startsWith(d)) ?? false;
  if (!resolved.startsWith(workingDirectory) && !resolved.startsWith("/tmp") && !inAdditionalDir) {
    return {
      allowed: false,
      reason: `Write blocked: path "${resolved}" is outside working directory "${workingDirectory}"`,
    };
  }

  // Block writes to dotfiles that control tool behavior
  const basename = resolved.split("/").pop() ?? "";
  const sensitiveFiles = [".env", ".bashrc", ".zshrc", ".profile", ".bash_profile"];
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
  "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Learn", "Agent", "Tasks",
]);

// ─── Permission Manager ────────────────────────────────────────

export class PermissionManager {
  private mode: PermissionMode;
  private workingDirectory: string;
  private additionalDirs?: string[];
  private promptFn: PermissionPromptFn | null = null;

  /** Allowlist of previously approved tool+pattern combos: "ToolName:pattern" */
  private allowlist = new Set<string>();

  constructor(mode: PermissionMode, workingDirectory: string, additionalDirs?: string[]) {
    this.mode = mode;
    this.workingDirectory = workingDirectory;
    this.additionalDirs = additionalDirs;
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
      return analysis.riskLevel;
    }

    if (tool.name === "Write" || tool.name === "Edit") {
      return "moderate";
    }

    return "safe";
  }
}
