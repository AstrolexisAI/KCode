// KCode - Session Snapshot System
// Captures complete session state for reproducibility and debugging.
// Snapshots are saved as JSON to ~/.kcode/snapshots/{id}.json

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { Message, KCodeConfig, ConversationState, TokenUsage, ContentBlock } from "./types";
import { log } from "./logger";

// ─── Constants ───────────────────────────────────────────────────

const SNAPSHOTS_DIR = join(homedir(), ".kcode", "snapshots");
const MAX_SNAPSHOTS = 200;

// ─── Types ───────────────────────────────────────────────────────

export interface SessionSnapshot {
  // Metadata
  id: string;
  createdAt: string;
  version: string;

  // Environment
  model: string;
  provider: string;
  contextWindowSize: number;
  workingDirectory: string;
  gitBranch?: string;
  gitCommit?: string;

  // Configuration
  config: {
    thinking: boolean;
    effortLevel?: string;
    permissionMode: string;
    reasoningBudget?: number;
  };

  // Session content
  systemPromptHash: string;
  systemPromptLength: number;
  messages: SnapshotMessage[];

  // Metrics
  totalTokens: number;
  totalCost?: number;
  turnCount: number;
  toolsUsed: string[];
  filesModified: string[];
  duration: number;
}

export interface SnapshotMessage {
  role: "user" | "assistant" | "tool";
  type: "text" | "thinking" | "tool_use" | "tool_result";
  content: string;
  timestamp: number;
  tokenEstimate?: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  isError?: boolean;
}

export interface SnapshotDiff {
  configChanges: string[];
  messageCountDelta: number;
  tokenDelta: number;
  costDelta?: number;
  newTools: string[];
  removedTools: string[];
  newFiles: string[];
  removedFiles: string[];
  durationDelta: number;
}

// ─── Helpers ─────────────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(SNAPSHOTS_DIR)) {
    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }
}

function hashString(str: string): string {
  return createHash("sha256").update(str).digest("hex").slice(0, 16);
}

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `snap-${ts}-${rand}`;
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4);
}

/**
 * Convert internal Message[] to flat SnapshotMessage[] for serialization.
 */
function flattenMessages(messages: Message[], startTime: number): SnapshotMessage[] {
  const result: SnapshotMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({
        role: msg.role as "user" | "assistant",
        type: "text",
        content: msg.content,
        timestamp: 0, // relative timestamps not available from state alone
        tokenEstimate: estimateTokens(msg.content),
      });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === "text") {
          result.push({
            role: msg.role as "user" | "assistant",
            type: "text",
            content: block.text,
            timestamp: 0,
            tokenEstimate: estimateTokens(block.text),
          });
        } else if (block.type === "thinking") {
          result.push({
            role: "assistant",
            type: "thinking",
            content: block.thinking,
            timestamp: 0,
            tokenEstimate: estimateTokens(block.thinking),
          });
        } else if (block.type === "tool_use") {
          result.push({
            role: "assistant",
            type: "tool_use",
            content: block.name,
            timestamp: 0,
            toolName: block.name,
            toolInput: block.input,
          });
        } else if (block.type === "tool_result") {
          const contentStr = typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
          result.push({
            role: "tool",
            type: "tool_result",
            content: contentStr.slice(0, 2000), // truncate large results
            timestamp: 0,
            isError: block.is_error,
          });
        }
      }
    }
  }

  return result;
}

/**
 * Extract unique tool names used from messages.
 */
function extractToolsUsed(messages: Message[]): string[] {
  const tools = new Set<string>();
  for (const msg of messages) {
    if (typeof msg.content !== "string" && Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === "tool_use") {
          tools.add(block.name);
        }
      }
    }
  }
  return [...tools].sort();
}

/**
 * Extract files modified (from Edit/Write/MultiEdit tool calls).
 */
function extractFilesModified(messages: Message[]): string[] {
  const files = new Set<string>();
  for (const msg of messages) {
    if (typeof msg.content !== "string" && Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === "tool_use") {
          if (block.name === "Edit" || block.name === "Write" || block.name === "MultiEdit") {
            const filePath = block.input?.file_path as string | undefined;
            if (filePath) files.add(filePath);
          }
        }
      }
    }
  }
  return [...files].sort();
}

/**
 * Count user turns (messages with role "user").
 */
function countTurns(messages: Message[]): number {
  return messages.filter((m) => m.role === "user").length;
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Capture a snapshot of the current session state.
 */
export function captureSnapshot(
  config: KCodeConfig,
  state: ConversationState,
  usage: TokenUsage,
  startTime: number,
  opts?: {
    provider?: string;
    gitBranch?: string;
    gitCommit?: string;
    totalCost?: number;
  },
): SessionSnapshot {
  const now = Date.now();
  const systemPrompt = config.systemPrompt ?? "";

  return {
    id: generateId(),
    createdAt: new Date().toISOString(),
    version: config.version ?? "unknown",

    model: config.model,
    provider: opts?.provider ?? "openai",
    contextWindowSize: config.contextWindowSize ?? 32000,
    workingDirectory: config.workingDirectory,
    gitBranch: opts?.gitBranch,
    gitCommit: opts?.gitCommit,

    config: {
      thinking: config.thinking ?? false,
      effortLevel: config.effortLevel,
      permissionMode: config.permissionMode,
      reasoningBudget: config.reasoningBudget,
    },

    systemPromptHash: hashString(systemPrompt),
    systemPromptLength: systemPrompt.length,
    messages: flattenMessages(state.messages, startTime),

    totalTokens: usage.inputTokens + usage.outputTokens,
    totalCost: opts?.totalCost,
    turnCount: countTurns(state.messages),
    toolsUsed: extractToolsUsed(state.messages),
    filesModified: extractFilesModified(state.messages),
    duration: now - startTime,
  };
}

/**
 * Export a snapshot in the specified format.
 */
export function exportSnapshot(
  snapshot: SessionSnapshot,
  format: "json" | "markdown" = "json",
): string {
  if (format === "json") {
    return JSON.stringify(snapshot, null, 2);
  }

  // Markdown format
  const lines: string[] = [
    `# Session Snapshot: ${snapshot.id}`,
    "",
    `**Created:** ${snapshot.createdAt}`,
    `**KCode Version:** ${snapshot.version}`,
    `**Model:** ${snapshot.model} (${snapshot.provider})`,
    `**Working Directory:** ${snapshot.workingDirectory}`,
  ];

  if (snapshot.gitBranch) {
    lines.push(`**Git Branch:** ${snapshot.gitBranch}`);
  }
  if (snapshot.gitCommit) {
    lines.push(`**Git Commit:** ${snapshot.gitCommit}`);
  }

  lines.push("");
  lines.push("## Configuration");
  lines.push("");
  lines.push(`- Thinking: ${snapshot.config.thinking}`);
  lines.push(`- Permission Mode: ${snapshot.config.permissionMode}`);
  if (snapshot.config.effortLevel) {
    lines.push(`- Effort Level: ${snapshot.config.effortLevel}`);
  }
  if (snapshot.config.reasoningBudget !== undefined) {
    lines.push(`- Reasoning Budget: ${snapshot.config.reasoningBudget}`);
  }

  lines.push("");
  lines.push("## Metrics");
  lines.push("");
  lines.push(`- Messages: ${snapshot.messages.length}`);
  lines.push(`- Turns: ${snapshot.turnCount}`);
  lines.push(`- Total Tokens: ${snapshot.totalTokens.toLocaleString()}`);
  if (snapshot.totalCost !== undefined) {
    lines.push(`- Total Cost: $${snapshot.totalCost.toFixed(4)}`);
  }
  lines.push(`- Duration: ${Math.round(snapshot.duration / 1000)}s`);
  lines.push(`- Context Window: ${snapshot.contextWindowSize.toLocaleString()}`);
  lines.push(`- System Prompt: ${snapshot.systemPromptLength.toLocaleString()} chars (hash: ${snapshot.systemPromptHash})`);

  if (snapshot.toolsUsed.length > 0) {
    lines.push("");
    lines.push("## Tools Used");
    lines.push("");
    for (const tool of snapshot.toolsUsed) {
      lines.push(`- ${tool}`);
    }
  }

  if (snapshot.filesModified.length > 0) {
    lines.push("");
    lines.push("## Files Modified");
    lines.push("");
    for (const file of snapshot.filesModified) {
      lines.push(`- ${file}`);
    }
  }

  lines.push("");
  lines.push("## Messages");
  lines.push("");
  for (let i = 0; i < snapshot.messages.length; i++) {
    const msg = snapshot.messages[i];
    const prefix = `${i + 1}.`;
    if (msg.type === "tool_use") {
      lines.push(`${prefix} [${msg.role}] Tool: ${msg.toolName ?? msg.content}`);
    } else if (msg.type === "tool_result") {
      const errTag = msg.isError ? " (ERROR)" : "";
      lines.push(`${prefix} [tool] Result${errTag}: ${msg.content.slice(0, 100)}${msg.content.length > 100 ? "..." : ""}`);
    } else if (msg.type === "thinking") {
      lines.push(`${prefix} [assistant] (thinking) ${msg.content.slice(0, 80)}...`);
    } else {
      lines.push(`${prefix} [${msg.role}] ${msg.content.slice(0, 120)}${msg.content.length > 120 ? "..." : ""}`);
    }
  }

  return lines.join("\n");
}

/**
 * Save a snapshot to disk at ~/.kcode/snapshots/{id}.json.
 */
export function saveSnapshot(snapshot: SessionSnapshot): string {
  ensureDir();

  const filePath = join(SNAPSHOTS_DIR, `${snapshot.id}.json`);
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf-8");

  // Prune old snapshots if over limit
  pruneSnapshots();

  return filePath;
}

/**
 * Load a snapshot by ID.
 */
export function loadSnapshot(id: string): SessionSnapshot | null {
  ensureDir();

  const filePath = join(SNAPSHOTS_DIR, `${id}.json`);
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as SessionSnapshot;
  } catch (err) {
    log.debug("snapshot", `Failed to load snapshot ${id}: ${err}`);
    return null;
  }
}

/**
 * List saved snapshots, newest first.
 */
export function listSnapshots(limit = 20): Array<{
  id: string;
  createdAt: string;
  model: string;
  turnCount: number;
  duration: number;
  messageCount: number;
}> {
  ensureDir();

  const files = readdirSync(SNAPSHOTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();

  const results: Array<{
    id: string;
    createdAt: string;
    model: string;
    turnCount: number;
    duration: number;
    messageCount: number;
  }> = [];

  for (const file of files.slice(0, limit)) {
    try {
      const content = readFileSync(join(SNAPSHOTS_DIR, file), "utf-8");
      const snap = JSON.parse(content) as SessionSnapshot;
      results.push({
        id: snap.id,
        createdAt: snap.createdAt,
        model: snap.model,
        turnCount: snap.turnCount,
        duration: snap.duration,
        messageCount: snap.messages.length,
      });
    } catch (err) {
      log.debug("snapshot", `Failed to read snapshot ${file}: ${err}`);
    }
  }

  return results;
}

/**
 * Compare two snapshots and return their differences.
 */
export function diffSnapshots(a: SessionSnapshot, b: SessionSnapshot): SnapshotDiff {
  const configChanges: string[] = [];

  if (a.model !== b.model) {
    configChanges.push(`model: ${a.model} -> ${b.model}`);
  }
  if (a.provider !== b.provider) {
    configChanges.push(`provider: ${a.provider} -> ${b.provider}`);
  }
  if (a.config.thinking !== b.config.thinking) {
    configChanges.push(`thinking: ${a.config.thinking} -> ${b.config.thinking}`);
  }
  if (a.config.effortLevel !== b.config.effortLevel) {
    configChanges.push(`effortLevel: ${a.config.effortLevel ?? "default"} -> ${b.config.effortLevel ?? "default"}`);
  }
  if (a.config.permissionMode !== b.config.permissionMode) {
    configChanges.push(`permissionMode: ${a.config.permissionMode} -> ${b.config.permissionMode}`);
  }
  if (a.contextWindowSize !== b.contextWindowSize) {
    configChanges.push(`contextWindowSize: ${a.contextWindowSize} -> ${b.contextWindowSize}`);
  }
  if (a.systemPromptHash !== b.systemPromptHash) {
    configChanges.push(`systemPrompt changed (hash: ${a.systemPromptHash} -> ${b.systemPromptHash})`);
  }

  const aToolSet = new Set(a.toolsUsed);
  const bToolSet = new Set(b.toolsUsed);
  const newTools = b.toolsUsed.filter((t) => !aToolSet.has(t));
  const removedTools = a.toolsUsed.filter((t) => !bToolSet.has(t));

  const aFileSet = new Set(a.filesModified);
  const bFileSet = new Set(b.filesModified);
  const newFiles = b.filesModified.filter((f) => !aFileSet.has(f));
  const removedFiles = a.filesModified.filter((f) => !bFileSet.has(f));

  return {
    configChanges,
    messageCountDelta: b.messages.length - a.messages.length,
    tokenDelta: b.totalTokens - a.totalTokens,
    costDelta: (b.totalCost !== undefined && a.totalCost !== undefined)
      ? b.totalCost - a.totalCost
      : undefined,
    newTools,
    removedTools,
    newFiles,
    removedFiles,
    durationDelta: b.duration - a.duration,
  };
}

/**
 * Prune oldest snapshots to stay under MAX_SNAPSHOTS.
 */
function pruneSnapshots(): void {
  try {
    const files = readdirSync(SNAPSHOTS_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort(); // oldest first

    const excess = files.length - MAX_SNAPSHOTS;
    if (excess > 0) {
      const { unlinkSync } = require("node:fs");
      for (let i = 0; i < excess; i++) {
        try {
          unlinkSync(join(SNAPSHOTS_DIR, files[i]));
        } catch (err) {
          log.debug("snapshot", `Failed to delete old snapshot ${files[i]}: ${err}`);
        }
      }
    }
  } catch (err) {
    log.debug("snapshot", `Failed to prune snapshots: ${err}`);
  }
}

/** Exposed for testing: the directory where snapshots are stored. */
export const SNAPSHOTS_DIR_PATH = SNAPSHOTS_DIR;
