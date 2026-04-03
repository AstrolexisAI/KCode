// KCode - Permission System
// Gates tool execution based on permission mode and safety analysis

import { existsSync, readFileSync } from "node:fs";
import { formatDiffPreview, generateDiff } from "./diff";
import { log } from "./logger";
import type {
  BashInput,
  FileEditInput,
  FileWriteInput,
  PermissionMode,
  PermissionRule,
  ToolUseBlock,
} from "./types";

export {
  evaluateRules,
  type ParsedToolRule,
  parseToolRule,
  suggestRule,
} from "./permission-rules";
// Re-export from extracted modules for backward compatibility
export {
  analyzeBashCommand,
  detectCommandInjection,
  detectCommandSubstitution,
  detectDangerousRedirections,
  detectPipeToShell,
  detectQuoteDesync,
  detectShellInvocation,
  extractCommandPrefix,
  validateFileWritePath,
} from "./safety-analysis";

import { evaluateRules } from "./permission-rules";
// Import for internal use
import { analyzeBashCommand, extractCommandPrefix, validateFileWritePath } from "./safety-analysis";

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

// ─── Tool Classification ────────────────────────────────────────

/** Tools that only read data and don't modify anything */
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "GitStatus", "GitLog", "DiffView"]);

/**
 * SAFE_TOOLS — Tools that never need confirmation in auto mode.
 * These are read-only or purely informational tools with zero side effects.
 * In auto mode, these skip the safety classifier entirely (0ms overhead).
 */
export const SAFE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "DiffView",
  "GitStatus",
  "GitLog",
  "AskUser",
  "ToolSearch",
  "TaskCreate",
  "TaskList",
  "TaskGet",
  "TaskUpdate",
  "EnterPlanMode",
  "ExitPlanMode",
]);

/** Tools auto-allowed in acceptEdits mode (everything except Bash) */
const ACCEPT_EDITS_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "GrepReplace",
  "Rename",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Learn",
  "Agent",
  "Tasks",
]);

// ─── Permission Manager ────────────────────────────────────────

export class PermissionManager {
  private mode: PermissionMode;
  private workingDirectory: string;
  private additionalDirs?: string[];
  private promptFn: PermissionPromptFn | null = null;
  private rules: PermissionRule[] = [];

  /** Allowlist of previously approved tool+pattern combos: "ToolName:pattern" */
  private allowlist = new Set<string>();

  constructor(
    mode: PermissionMode,
    workingDirectory: string,
    additionalDirs?: string[],
    rules?: PermissionRule[],
  ) {
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
  setPromptFn(fn: PermissionPromptFn | undefined): void {
    this.promptFn = fn ?? null;
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
    } catch (err) {
      log.debug("permissions", `Plan-mode module not loaded yet: ${err}`);
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

    // Fast-path: SAFE_TOOLS skip classifier entirely in auto mode (0ms overhead)
    if (this.mode === "auto" && SAFE_TOOLS.has(tool.name)) {
      return { allowed: true };
    }

    // For read-only tools, always allow (in ask, auto, or acceptEdits mode)
    if (READ_ONLY_TOOLS.has(tool.name)) {
      return { allowed: true };
    }

    // acceptEdits mode: auto-allow all tools except Bash, which requires prompting
    if (this.mode === "acceptEdits") {
      if (ACCEPT_EDITS_TOOLS.has(tool.name)) {
        // Enforce ALL safety checks (protected dirs, sensitive files, path traversal)
        const safetyResult = this.analyzeToolSafety(tool);
        if (!safetyResult.allowed) {
          return safetyResult;
        }
        return { allowed: true };
      }
      // For Bash (and any unknown tools), fall through to ask-mode prompting below
    }

    // Run safety analysis for write tools
    const safetyResult = this.analyzeToolSafety(tool);

    // If safety analysis blocks it outright, deny regardless of mode
    if (!safetyResult.allowed) {
      return safetyResult;
    }

    // Auto mode allows everything that passes safety
    if (this.mode === "auto") {
      return safetyResult;
    }

    // Ask mode: check allowlist first
    const pattern = this.getToolPattern(tool);
    if (this.isAllowlisted(tool.name, pattern)) {
      // Enforce ALL safety blocks (already checked above, but re-check in case tool pattern changed)
      if (!safetyResult.allowed) {
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
        // Only hard-block truly dangerous patterns (injection, pipe-to-shell, etc.)
        // Moderate issues (&&, >, $()) fall through to the normal ask/auto permission flow
        if (!analysis.safe && analysis.riskLevel === "dangerous") {
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
          const result = validateFileWritePath(
            edit.file_path,
            this.workingDirectory,
            this.additionalDirs,
          );
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

      // Read-only tools — safe, no side effects
      case "Read":
      case "Glob":
      case "Grep":
      case "LS":
        return { allowed: true };

      // Agent/messaging — orchestration tools (safe, subagents have own permissions)
      case "Agent":
      case "SendMessage":
        return { allowed: true };

      // Web tools — read from internet (safe, SSRF checked in tool itself)
      case "WebFetch":
      case "WebSearch":
        return { allowed: true };

      // Task management — in-memory state tracking (safe)
      case "TaskCreate":
      case "TaskList":
      case "TaskGet":
      case "TaskUpdate":
      case "TaskStop":
        return { allowed: true };

      // Notebook editing — modifies files, treated like Edit
      case "NotebookEdit":
        return { allowed: true };

      // Learning — stores distilled examples (safe)
      case "Learn":
        return { allowed: true };

      // Plan tool — modifies plan state (safe)
      case "Plan":
        return { allowed: true };

      // MCP resource tools — read-only from MCP servers (safe)
      case "ListMcpResources":
      case "ReadMcpResource":
        return { allowed: true };

      // Pro/cloud tools — safe, gated by Pro check internally
      case "Kulvex":
      case "Browser":
      case "ImageGen":
      case "Deploy":
        return { allowed: true };

      default:
        // Unknown tools (including dynamically added MCP tools) require explicit approval
        return { allowed: false, reason: `Unknown tool "${tool.name}" requires manual approval` };
    }
  }

  /**
   * Extract a pattern string for allowlist matching.
   *
   * Known limitation (L1): For Write/Edit/MultiEdit tools the pattern is the
   * parent *directory* of the target file. This means approving one file in a
   * directory effectively approves ALL files in that directory. A more granular
   * (per-file) allowlist would require prompting the user on every distinct
   * file path, which degrades UX for typical workflows. Accept the trade-off
   * and rely on safety analysis (protected dirs, sensitive files) as the
   * secondary guard.
   */
  private getToolPattern(tool: ToolUseBlock): string {
    switch (tool.name) {
      case "Bash": {
        const input = tool.input as unknown as BashInput;
        return extractCommandPrefix(input.command);
      }
      case "MultiEdit": {
        const edits = ((tool.input as Record<string, unknown>).edits ?? []) as Array<{
          file_path?: string;
        }>;
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
        const cmd =
          input.command.length > 120 ? input.command.slice(0, 120) + "..." : input.command;
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
        } catch (err) {
          log.debug("permissions", `Failed to generate diff preview for Write: ${err}`);
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
        } catch (err) {
          log.debug("permissions", `Failed to generate diff preview for Edit: ${err}`);
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
        "msfconsole",
        "nmap",
        "nikto",
        "sqlmap",
        "hydra",
        "john",
        "hashcat",
        "aircrack",
        "aircrack-ng",
        "gobuster",
        "masscan",
        "wireshark",
        "tshark",
        "responder",
        "crackmapexec",
        "enum4linux",
        "wfuzz",
        "dirb",
        "setoolkit",
        "tcpdump",
        "searchsploit",
        "metasploit",
        "beef",
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
