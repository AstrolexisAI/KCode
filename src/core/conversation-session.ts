// KCode - Conversation Session Module
// Extracted from conversation.ts — fork, restore, session data collection, cost formatting, reset

import { getBranchManager } from "./branch-manager";
import { log } from "./logger";
import { CHARS_PER_TOKEN } from "./token-budget";
import { TranscriptManager } from "./transcript";
import type { ConversationState, KCodeConfig, Message, TokenUsage, TurnCostEntry } from "./types";

// ─── Message Sanitization ────────────────────────────────────────

/**
 * Sanitize tool_use/tool_result pairing in restored messages.
 * Removes orphaned tool_result blocks (no matching tool_use in previous assistant message)
 * and strips tool_use blocks from assistant messages that have no tool_result in the next message.
 * This prevents 400 errors from Anthropic when restoring sessions with corrupted history.
 */
/**
 * Strip stale [SYSTEM CONTEXT] messages from restored sessions.
 * These messages contain file snippets/references that may point to files
 * that no longer exist or are from a different project than the current cwd.
 */
function stripStaleSystemContext(messages: Message[]): Message[] {
  return messages.filter((msg) => {
    if (msg.role !== "user") return true;
    const content = typeof msg.content === "string" ? msg.content : "";
    // Strip auto-injected context messages from previous sessions
    if (content.startsWith("[SYSTEM CONTEXT]")) return false;
    return true;
  });
}

function sanitizeToolPairing(messages: Message[]): Message[] {
  // Collect all tool_use IDs from assistant messages, paired with their position
  const toolUseIds = new Map<string, number>(); // id → message index
  const toolResultIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && msg.role === "assistant") {
        toolUseIds.set(block.id, i);
      }
      if (block.type === "tool_result" && msg.role === "user") {
        toolResultIds.add(block.tool_use_id);
      }
    }
  }

  // Find orphaned tool_use (no matching tool_result) and orphaned tool_result (no matching tool_use)
  const orphanedToolUseIds = new Set<string>();
  const orphanedToolResultIds = new Set<string>();

  for (const [id] of toolUseIds) {
    if (!toolResultIds.has(id)) orphanedToolUseIds.add(id);
  }
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) orphanedToolResultIds.add(id);
  }

  if (orphanedToolUseIds.size === 0 && orphanedToolResultIds.size === 0) {
    return messages; // No orphans — messages are clean
  }

  log.warn(
    "session",
    `Sanitizing restored messages: ${orphanedToolUseIds.size} orphaned tool_use, ${orphanedToolResultIds.size} orphaned tool_result`,
  );

  // Filter out orphaned blocks
  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    const filtered = msg.content.filter((block) => {
      if (block.type === "tool_use" && orphanedToolUseIds.has(block.id)) return false;
      if (block.type === "tool_result" && orphanedToolResultIds.has(block.tool_use_id)) return false;
      return true;
    });
    // If all blocks were removed, replace with a placeholder text
    if (filtered.length === 0) {
      return { ...msg, content: "[Session restored — some tool data was cleaned up]" };
    }
    return { ...msg, content: filtered };
  }).filter((msg) => {
    // Remove completely empty messages
    if (typeof msg.content === "string") return msg.content.length > 0;
    return Array.isArray(msg.content) && msg.content.length > 0;
  });
}

// ─── Functions ───────────────────────────────────────────────────

/**
 * Fork the conversation: keep current messages but start a new transcript.
 * Optionally truncate to a specific message count (fork from a point in history).
 */
export function forkConversation(
  messages: Message[],
  previousSessionId: string,
  config: KCodeConfig,
  keepMessages?: number,
): {
  forkedMessages: Message[];
  newTranscript: TranscriptManager;
  newSessionId: string;
  messageCount: number;
} {
  const msgs = keepMessages ? messages.slice(0, keepMessages) : [...messages];

  // Start a new transcript (only if session persistence is enabled)
  const newTranscript = new TranscriptManager();
  const summary =
    msgs.length > 0
      ? (typeof msgs[0]!.content === "string" ? msgs[0]!.content : "[forked session]").slice(0, 80)
      : "forked session";
  if (!config.noSessionPersistence) {
    newTranscript.startSession(`[FORK] ${summary}`);
  }

  // Generate new session ID for the fork
  const newSessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Persist branch relationship (only if session persistence is enabled)
  if (!config.noSessionPersistence) {
    try {
      const bm = getBranchManager();
      // Ensure parent branch is registered (if not already)
      const parentBranch = bm.getBranch(previousSessionId);
      if (!parentBranch) {
        bm.saveBranch(
          previousSessionId,
          null,
          summary,
          `session-${previousSessionId}`,
          msgs.length,
        );
      }
      bm.saveBranch(
        newSessionId,
        previousSessionId,
        `[FORK] ${summary}`,
        `session-${newSessionId}`,
        msgs.length,
      );
    } catch (err) {
      log.warn("branch", "Failed to persist branch data during fork: " + err);
    }
  }

  return {
    forkedMessages: msgs,
    newTranscript,
    newSessionId,
    messageCount: msgs.length,
  };
}

/**
 * Restore messages from a previous session (for --continue).
 * Returns the restored messages and estimated token count.
 */
export function restoreMessages(messages: Message[]): {
  restoredMessages: Message[];
  estimatedTokenCount: number;
} {
  // Strip stale [SYSTEM CONTEXT] messages from previous sessions first,
  // then sanitize tool_use/tool_result pairing
  const restoredMessages = sanitizeToolPairing(stripStaleSystemContext([...messages]));
  // Estimate token count from content length
  let totalChars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      totalChars += msg.content.length;
    } else {
      for (const block of msg.content) {
        if (block.type === "text") {
          totalChars += block.text.length;
        } else if (block.type === "thinking") {
          totalChars += block.thinking.length;
        } else if (block.type === "tool_use") {
          totalChars += JSON.stringify(block.input).length;
        } else if (block.type === "tool_result") {
          totalChars +=
            typeof block.content === "string"
              ? block.content.length
              : JSON.stringify(block.content).length;
        }
      }
    }
  }
  return {
    restoredMessages,
    estimatedTokenCount: Math.ceil(totalChars / CHARS_PER_TOKEN),
  };
}

/**
 * Collect session data for the narrative system (Layer 10).
 */
export function collectSessionData(
  messages: Message[],
  workingDirectory: string,
  toolUseCount: number,
): {
  project: string;
  messagesCount: number;
  toolsUsed: string[];
  actionsCount: number;
  topicsDiscussed: string[];
  errorsEncountered: number;
  filesModified: string[];
} {
  const toolsUsed: string[] = [];
  const filesModifiedSet = new Set<string>();
  let errorsEncountered = 0;

  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          toolsUsed.push(block.name);
          if (block.name === "Write" || block.name === "Edit") {
            const fp = String((block.input as Record<string, unknown>)?.file_path ?? "");
            if (fp) filesModifiedSet.add(fp);
          }
        }
        if (block.type === "tool_result" && block.is_error) {
          errorsEncountered++;
        }
      }
    }
  }

  return {
    project: workingDirectory,
    messagesCount: messages.length,
    toolsUsed,
    actionsCount: toolUseCount,
    topicsDiscussed: [],
    errorsEncountered,
    filesModified: [...filesModifiedSet],
  };
}

/**
 * Format a turn-by-turn cost breakdown as a string.
 */
export function formatCostBreakdown(turnCosts: TurnCostEntry[]): string {
  if (turnCosts.length === 0) return "";
  const lines: string[] = ["", "Turn-by-turn breakdown:"];
  for (const t of turnCosts) {
    const toolSuffix =
      t.toolCalls.length > 0
        ? ` (${t.toolCalls.length} tool${t.toolCalls.length !== 1 ? "s" : ""})`
        : "";
    const costStr =
      t.costUsd > 0
        ? t.costUsd < 0.01
          ? `$${t.costUsd.toFixed(4)}`
          : `$${t.costUsd.toFixed(2)}`
        : "$0.00";
    lines.push(
      `  Turn ${t.turnIndex}: ${t.model}${toolSuffix} — ${t.inputTokens.toLocaleString()} in / ${t.outputTokens.toLocaleString()} out — ${costStr}`,
    );
  }
  return lines.join("\n");
}

/**
 * Create a fresh conversation state and cumulative usage (for reset).
 */
export function createFreshState(): {
  state: ConversationState;
  cumulativeUsage: TokenUsage;
} {
  return {
    state: {
      messages: [],
      tokenCount: 0,
      toolUseCount: 0,
    },
    cumulativeUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  };
}
