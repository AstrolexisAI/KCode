// KCode - Conversation State Access
// Extracted from conversation.ts to reduce file size

import type { ConversationState, Message, TokenUsage, TurnCostEntry } from "./types";

export function getRecentMessageText(messages: Message[]): string {
  // Extract text from last 4 messages for routing heuristics
  const parts: string[] = [];
  const recent = messages.slice(-4);
  for (const msg of recent) {
    if (typeof msg.content === "string") {
      parts.push(msg.content);
    } else {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push(block.text);
        } else if (block.type === "tool_result") {
          if (typeof block.content === "string") {
            parts.push(block.content);
          } else if (Array.isArray(block.content)) {
            for (const sub of block.content) {
              if (sub.type === "text") {
                parts.push(sub.text);
              }
            }
          }
        }
      }
    }
  }
  return parts.join("\n");
}

export function accumulateUsage(
  cumulative: TokenUsage,
  usage: TokenUsage,
  state: ConversationState,
): void {
  cumulative.inputTokens += usage.inputTokens;
  cumulative.outputTokens += usage.outputTokens;
  cumulative.cacheCreationInputTokens += usage.cacheCreationInputTokens;
  cumulative.cacheReadInputTokens += usage.cacheReadInputTokens;
  state.tokenCount = cumulative.inputTokens + cumulative.outputTokens;
}

export function getModifiedFiles(messages: Message[]): string[] {
  const files: string[] = [];
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && (block.name === "Write" || block.name === "Edit")) {
          const fp = String((block.input as Record<string, unknown>)?.file_path ?? "");
          if (fp && !files.includes(fp)) files.push(fp);
        }
      }
    }
  }
  return files;
}

/** Fast string hash for cache comparison (djb2). */
export function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}
