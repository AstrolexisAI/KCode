// KCode - Hooks System
// Loads and executes lifecycle hooks from .kcode/settings.json

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolUseBlock, ToolResult } from "./types";

// ─── Types ──────────────────────────────────────────────────────

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PreCompact"
  | "UserPromptSubmit"
  | "Stop"
  | "Notification";

export interface HookConfig {
  /** Regex pattern to match against (tool name for tool hooks, event name otherwise) */
  matcher: string;
  /** List of hook actions to execute */
  hooks: HookAction[];
}

export interface HookAction {
  type: "command";
  /** Shell command to execute. Receives JSON on stdin. */
  command: string;
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
}

/** Settings file shape (only the hooks portion) */
interface KCodeSettings {
  hooks?: Partial<Record<HookEvent, HookConfig[]>>;
}

// ─── Hook Execution ─────────────────────────────────────────────

const HOOK_TIMEOUT = 30_000; // 30 seconds

/** Execute a single hook command, passing context as JSON via stdin. */
async function executeHookCommand(
  command: string,
  stdinData: string,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const proc = spawn("sh", ["-c", command], {
      cwd,
      timeout: HOOK_TIMEOUT,
      env: { ...process.env },
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
  } catch {
    // Non-JSON output is ignored
  }

  return null;
}

// ─── Hook Manager ───────────────────────────────────────────────

export class HookManager {
  private settings: KCodeSettings = {};
  private workingDirectory: string;
  private loaded = false;

  constructor(workingDirectory: string) {
    this.workingDirectory = workingDirectory;
  }

  /** Load hooks from .kcode/settings.json. Safe to call multiple times. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;

    const settingsPath = join(this.workingDirectory, ".kcode", "settings.json");
    if (!existsSync(settingsPath)) return;

    try {
      const raw = readFileSync(settingsPath, "utf-8");
      this.settings = JSON.parse(raw) as KCodeSettings;
    } catch {
      // Silently ignore malformed settings
      this.settings = {};
    }
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

  /** Get hook configs that match a given target (e.g., tool name). */
  private getMatchingHooks(event: HookEvent, target: string): HookConfig[] {
    this.load();
    const configs = this.settings.hooks?.[event];
    if (!Array.isArray(configs)) return [];

    return configs.filter((config) => {
      try {
        const regex = new RegExp(config.matcher);
        return regex.test(target);
      } catch {
        return false;
      }
    });
  }

  // ─── PreToolUse ─────────────────────────────────────────────

  /**
   * Run PreToolUse hooks. These can:
   * - Allow the tool call (exit 0, decision "allow")
   * - Block the tool call (exit 2, or decision "deny"/"block")
   * - Modify the tool input (output updatedInput)
   * - Warn but allow (any other exit code)
   */
  async runPreToolUse(tool: ToolUseBlock): Promise<HookResult> {
    const matchingHooks = this.getMatchingHooks("PreToolUse", tool.name);
    if (matchingHooks.length === 0) {
      return { allowed: true, warnings: [] };
    }

    const stdinData = JSON.stringify({
      event: "PreToolUse",
      tool_name: tool.name,
      tool_id: tool.id,
      tool_input: tool.input,
    });

    const warnings: string[] = [];
    let currentInput = tool.input;

    for (const config of matchingHooks) {
      for (const action of config.hooks) {
        if (action.type !== "command") continue;

        const result = await executeHookCommand(
          action.command,
          stdinData,
          this.workingDirectory,
        );

        // Exit code 2 = block the tool call
        if (result.exitCode === 2) {
          const output = parseHookOutput(result.stdout);
          return {
            allowed: false,
            reason: output?.reason ?? `Hook blocked: ${action.command}`,
            warnings,
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
              };
            }
            if (output.updatedInput) {
              currentInput = output.updatedInput;
            }
          }
        } else {
          // Non-zero, non-2 exit code = warning only
          const message = result.stderr || result.stdout || `Hook "${action.command}" exited with code ${result.exitCode}`;
          warnings.push(message);
        }
      }
    }

    const inputChanged = currentInput !== tool.input;
    return {
      allowed: true,
      updatedInput: inputChanged ? currentInput : undefined,
      warnings,
    };
  }

  // ─── PostToolUse ────────────────────────────────────────────

  /** Run PostToolUse hooks for logging/notification. These cannot block. */
  async runPostToolUse(tool: ToolUseBlock, result: ToolResult): Promise<{ warnings: string[] }> {
    const matchingHooks = this.getMatchingHooks("PostToolUse", tool.name);
    if (matchingHooks.length === 0) return { warnings: [] };

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

    for (const config of matchingHooks) {
      for (const action of config.hooks) {
        if (action.type !== "command") continue;

        const hookResult = await executeHookCommand(
          action.command,
          stdinData,
          this.workingDirectory,
        );

        if (hookResult.exitCode !== 0) {
          const message = hookResult.stderr || hookResult.stdout || `PostToolUse hook "${action.command}" exited with code ${hookResult.exitCode}`;
          warnings.push(message);
        }
      }
    }

    return { warnings };
  }

  // ─── Generic Event Hooks ────────────────────────────────────

  /**
   * Run hooks for non-tool events (PreCompact, UserPromptSubmit, Stop, Notification).
   * Returns warnings only; these hooks cannot block execution.
   */
  async runEventHook(
    event: Exclude<HookEvent, "PreToolUse" | "PostToolUse">,
    context: Record<string, unknown> = {},
  ): Promise<{ warnings: string[] }> {
    const matchingHooks = this.getMatchingHooks(event, event);
    if (matchingHooks.length === 0) return { warnings: [] };

    const stdinData = JSON.stringify({
      event,
      ...context,
    });

    const warnings: string[] = [];

    for (const config of matchingHooks) {
      for (const action of config.hooks) {
        if (action.type !== "command") continue;

        const result = await executeHookCommand(
          action.command,
          stdinData,
          this.workingDirectory,
        );

        if (result.exitCode !== 0) {
          const message = result.stderr || result.stdout || `${event} hook "${action.command}" exited with code ${result.exitCode}`;
          warnings.push(message);
        }
      }
    }

    return { warnings };
  }
}
