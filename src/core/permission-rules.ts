// KCode - Permission Rule Matching Engine
// Glob pattern matching for files/commands, permission rule evaluation, first-match-wins logic.

import { log } from "./logger";
import type {
  BashInput,
  FileEditInput,
  FileWriteInput,
  PermissionRule,
  PermissionRuleAction,
  ToolUseBlock,
} from "./types";

// ─── Types ──────────────────────────────────────────────────────

export interface ParsedToolRule {
  tool: string;
  pattern?: string;
}

// ─── Rule Parsing ───────────────────────────────────────────────

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

// ─── Internal Pattern Matching ──────────────────────────────────

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
      const paths = (input.edits ?? []).map((e) => e.file_path ?? "").filter(Boolean);
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
        } catch (err) {
          log.debug("permissions", `Failed to parse WebFetch URL: ${err}`);
          return input.url;
        }
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

// ─── Rule Evaluation ────────────────────────────────────────────

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
export function evaluateRules(
  rules: PermissionRule[],
  tool: ToolUseBlock,
): PermissionRuleAction | null {
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
      const allMatch = matchValue.split("\n").every((v) => globMatch(parsed.innerPattern, v));
      if (allMatch) return rule.action;
      continue;
    }

    // Match inner pattern against value
    if (globMatch(parsed.innerPattern, matchValue)) return rule.action;
  }

  return null;
}
