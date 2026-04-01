// KCode - Hooks System
// Loads and executes lifecycle hooks from .kcode/settings.json and ~/.kcode/settings.json

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateHookifyRules } from "./hookify";
import { log } from "./logger";
import { kcodePath } from "./paths";
import type { ToolResult, ToolUseBlock } from "./types";

// ─── Re-exports from extracted modules ──────────────────────────
// These maintain the public API so existing imports from "./hooks" continue to work.

export {
  _resetTrustCache,
  isWorkspaceTrusted,
  setTrustPromptCallback,
  trustWorkspace,
  untrustWorkspace,
} from "./hook-trust";
export type {
  HookAction,
  HookConfig,
  HookEntry,
  HookEvent,
  HookMatcher,
  HookOutput,
  HookResult,
  KCodeSettings,
  PromptHookConfig,
} from "./hook-types";

// ─── Internal imports from extracted modules ────────────────────

import {
  executeHookAction,
  executeHookEntry,
  isHookEntry,
  isLegacyHookConfig,
  matcherMatches,
  parseHookOutput,
  safeRegexTest,
} from "./hook-executor";
import {
  getTrustPromptCallback,
  isWorkspaceTrusted,
  normalizePath,
  trustWorkspace,
} from "./hook-trust";
import type {
  HookConfig,
  HookEntry,
  HookEvent,
  HookResult,
  HookSource,
  KCodeSettings,
  TaggedHook,
} from "./hook-types";
import { HOOK_SOURCE } from "./hook-types";

// ─── Hook Configuration Loading ─────────────────────────────────

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
    const userSettingsPath = kcodePath("settings.json");
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
    const command =
      (hook as HookEntry).command ??
      (hook as HookConfig).hooks?.[0]?.command ??
      (hook as HookConfig).hooks?.[0]?.url ??
      "unknown";

    const trustPromptCallback = getTrustPromptCallback();
    if (trustPromptCallback) {
      const trusted = await trustPromptCallback(this.workingDirectory, command);
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
        const result = await executeHookAction(action, stdinData, this.workingDirectory);

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
          const message =
            result.stderr || result.stdout || `Hook "${label}" exited with code ${result.exitCode}`;
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
        const message =
          result.stderr || result.stdout || `Hook "${label}" exited with code ${result.exitCode}`;
        warnings.push(message);
      }
    }

    // Evaluate hookify rules (lower priority than explicit hooks)
    try {
      const hookifyResult = await evaluateHookifyRules(
        tool.name,
        currentInput as Record<string, unknown>,
        "PreToolUse",
      );
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
  async runPostToolUse(
    tool: ToolUseBlock,
    result: ToolResult,
  ): Promise<{ warnings: string[]; contextOutput?: string[] }> {
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
        const hookResult = await executeHookAction(action, stdinData, this.workingDirectory);

        if (hookResult.exitCode !== 0) {
          const label = action.command ?? action.url ?? "unknown";
          const message =
            hookResult.stderr ||
            hookResult.stdout ||
            `PostToolUse hook "${label}" exited with code ${hookResult.exitCode}`;
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
        warnings.push(
          hookResult.stderr ||
            hookResult.stdout ||
            `PostToolUse hook "${label}" exited with code ${hookResult.exitCode}`,
        );
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
          warnings.push(
            hookResult.stderr ||
              hookResult.stdout ||
              `PostToolUseFailure hook "${label}" exited with code ${hookResult.exitCode}`,
          );
        }
      }
    }

    for (const entry of entryHooks) {
      if (!(await this.checkHookTrust(entry as TaggedHook))) continue;
      if (entry.type === "prompt") continue; // Prompt hooks don't apply to failure events
      const hookResult = await executeHookEntry(entry, stdinData, this.workingDirectory);
      if (hookResult.exitCode !== 0) {
        const label = entry.command ?? "unknown";
        warnings.push(
          hookResult.stderr ||
            hookResult.stdout ||
            `PostToolUseFailure hook "${label}" exited with code ${hookResult.exitCode}`,
        );
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
        const result = await executeHookAction(action, stdinData, this.workingDirectory);

        if (result.exitCode !== 0) {
          const label = action.command ?? action.url ?? "unknown";
          const message =
            result.stderr ||
            result.stdout ||
            `${event} hook "${label}" exited with code ${result.exitCode}`;
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
        warnings.push(
          result.stderr ||
            result.stdout ||
            `${event} hook "${label}" exited with code ${result.exitCode}`,
        );
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
      log.warn(
        "hooks",
        `Fire-and-forget hook "${event}" error: ${err instanceof Error ? err.message : err}`,
      );
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
            reason:
              output?.reason ?? `Stop hook blocked: ${action.command ?? action.url ?? "unknown"}`,
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
          warnings.push(
            result.stderr || `${event} hook "${label}" exited with code ${result.exitCode}`,
          );
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
        warnings.push(
          result.stderr || `${event} hook "${label}" exited with code ${result.exitCode}`,
        );
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
    const entryHooks = this.getMatchingHookEntries(event, toolName, {
      tool_name: toolName,
      ...input,
    });

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
            reason:
              output?.reason ??
              `${event} hook blocked: ${action.command ?? action.url ?? "unknown"}`,
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
          warnings.push(
            result.stderr || `${event} hook "${label}" exited with code ${result.exitCode}`,
          );
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
        warnings.push(
          result.stderr || `${event} hook "${label}" exited with code ${result.exitCode}`,
        );
      }
    }

    return {
      allowed: true,
      warnings,
      contextOutput: contextOutput.length > 0 ? contextOutput : undefined,
    };
  }
}
