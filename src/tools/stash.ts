// KCode - Stash Tool
// Save and restore conversation context snapshots for branching exploration

import type { ToolDefinition, ToolResult, Message } from "../core/types";

// ─── Types ──────────────────────────────────────────────────────

interface StashEntry {
  name: string;
  messages: Message[];
  messageCount: number;
  savedAt: number;
  description: string;
}

// ─── Stash State ────────────────────────────────────────────────

const MAX_STASHES = 5;
const MAX_STASH_SIZE_BYTES = 2 * 1024 * 1024; // 2MB per stash (UTF-16 estimate)
const stashes = new Map<string, StashEntry>();

/** Clear all stashes. Useful for freeing memory. */
export function clearStashes(): void {
  stashes.clear();
}

// Injected getters/setters for conversation state
let _getMessages: (() => Message[]) | null = null;
let _setMessages: ((messages: Message[]) => void) | null = null;

export function setStashCallbacks(
  getMessages: () => Message[],
  setMessages: (messages: Message[]) => void,
): void {
  _getMessages = getMessages;
  _setMessages = setMessages;
}

// ─── Tool Definition ────────────────────────────────────────────

export const stashDefinition: ToolDefinition = {
  name: "Stash",
  description:
    "Save or restore conversation context snapshots. " +
    "Use action='save' to snapshot current context, 'list' to see saved stashes, " +
    "'restore' to load a snapshot, 'drop' to delete one. Max 5 slots.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["save", "list", "restore", "drop"],
        description: "Action to perform",
      },
      name: {
        type: "string",
        description: "Stash name (required for save/restore/drop)",
      },
      description: {
        type: "string",
        description: "Optional description when saving",
      },
    },
    required: ["action"],
  },
};

// ─── Execute ────────────────────────────────────────────────────

export async function executeStash(input: Record<string, unknown>): Promise<ToolResult> {
  const action = String(input.action ?? "").trim();
  const name = String(input.name ?? "").trim();

  if (action === "list") {
    if (stashes.size === 0) {
      return { tool_use_id: "", content: "No stashes saved." };
    }

    const lines: string[] = [`Saved stashes (${stashes.size}/${MAX_STASHES}):`];
    for (const [key, entry] of stashes) {
      const age = Math.round((Date.now() - entry.savedAt) / 1000);
      const desc = entry.description ? ` — ${entry.description}` : "";
      lines.push(`  ${key}: ${entry.messageCount} messages, ${age}s ago${desc}`);
    }
    return { tool_use_id: "", content: lines.join("\n") };
  }

  if (!name) {
    return { tool_use_id: "", content: "Error: name is required for save/restore/drop.", is_error: true };
  }

  // Validate name: alphanumeric, dashes, underscores only
  if (!/^[\w-]{1,30}$/.test(name)) {
    return { tool_use_id: "", content: "Error: name must be 1-30 alphanumeric characters, dashes, or underscores.", is_error: true };
  }

  if (action === "save") {
    if (!_getMessages) {
      return { tool_use_id: "", content: "Error: Stash system not initialized.", is_error: true };
    }

    if (stashes.size >= MAX_STASHES && !stashes.has(name)) {
      return { tool_use_id: "", content: `Error: Maximum ${MAX_STASHES} stashes reached. Drop one first.`, is_error: true };
    }

    const messages = _getMessages();

    // Check approximate size before cloning (UTF-16: each char ≈ 2 bytes)
    let serialized: string;
    try {
      serialized = JSON.stringify(messages);
    } catch (err) {
      return { tool_use_id: "", content: `Error: Failed to serialize conversation state: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }

    const estimatedBytes = serialized.length * 2;
    if (estimatedBytes > MAX_STASH_SIZE_BYTES) {
      const sizeMB = (estimatedBytes / (1024 * 1024)).toFixed(1);
      const limitMB = (MAX_STASH_SIZE_BYTES / (1024 * 1024)).toFixed(0);
      return { tool_use_id: "", content: `Error: Conversation is too large to stash (~${sizeMB}MB, limit is ${limitMB}MB). Use /compact first to reduce context size.`, is_error: true };
    }

    let clonedMessages: Message[];
    try {
      clonedMessages = JSON.parse(serialized);
    } catch (err) {
      return { tool_use_id: "", content: `Error: Failed to deserialize conversation state: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }

    const entry: StashEntry = {
      name,
      messages: clonedMessages,
      messageCount: messages.length,
      savedAt: Date.now(),
      description: String(input.description ?? "").trim(),
    };

    stashes.set(name, entry);
    return { tool_use_id: "", content: `Stash "${name}" saved with ${messages.length} messages.` };
  }

  if (action === "restore") {
    if (!_setMessages) {
      return { tool_use_id: "", content: "Error: Stash system not initialized.", is_error: true };
    }

    const entry = stashes.get(name);
    if (!entry) {
      const available = stashes.size > 0
        ? ` Available: ${[...stashes.keys()].join(", ")}`
        : " No stashes saved.";
      return { tool_use_id: "", content: `Error: Stash "${name}" not found.${available}`, is_error: true };
    }

    const restoredMessages = JSON.parse(JSON.stringify(entry.messages));
    _setMessages(restoredMessages);
    const age = Math.round((Date.now() - entry.savedAt) / 1000);
    return { tool_use_id: "", content: `Restored stash "${name}" (${entry.messageCount} messages, saved ${age}s ago).` };
  }

  if (action === "drop") {
    if (!stashes.has(name)) {
      return { tool_use_id: "", content: `Error: Stash "${name}" not found.`, is_error: true };
    }
    stashes.delete(name);
    return { tool_use_id: "", content: `Stash "${name}" dropped.` };
  }

  return { tool_use_id: "", content: `Error: Unknown action "${action}". Use save, list, restore, or drop.`, is_error: true };
}
