// KCode - Conversation Checkpoint Module
// Extracted from conversation.ts — checkpoint save/rewind/list/count logic

import type { UndoManager } from "./undo";

// ─── Types ───────────────────────────────────────────────────────

export interface Checkpoint {
  label: string;
  messageIndex: number;
  undoSize: number;
  timestamp: number;
}

export interface CheckpointListEntry {
  index: number;
  label: string;
  messageIndex: number;
  timestamp: number;
  age: string;
}

export const MAX_CHECKPOINTS = 10;

// ─── Functions ───────────────────────────────────────────────────

/**
 * Save a checkpoint of the current conversation state.
 * @param checkpoints Current checkpoint array (mutated in place)
 * @param messagesLength Current message count
 * @param undoSize Current undo stack size
 * @param label Optional label for the checkpoint (defaults to auto-generated)
 */
export function saveCheckpoint(
  checkpoints: Checkpoint[],
  messagesLength: number,
  undoSize: number,
  label?: string,
): void {
  const cpLabel = label ?? `checkpoint-${checkpoints.length + 1}`;
  // Only checkpoint if message count is reasonable (avoid OOM)
  if (messagesLength > 500) return;

  checkpoints.push({
    label: cpLabel,
    messageIndex: messagesLength,
    undoSize,
    timestamp: Date.now(),
  });
  if (checkpoints.length > MAX_CHECKPOINTS) {
    checkpoints.shift();
  }
}

/**
 * Rewind conversation to a specific checkpoint by index.
 * If no index is provided, rewinds to the most recent checkpoint.
 * Also undoes file changes back to that point.
 * Returns a description of what was rewound, or null if no checkpoints.
 */
export function rewindToCheckpoint(
  checkpoints: Checkpoint[],
  messages: unknown[],
  undoManager: UndoManager,
  index?: number,
): { description: string | null; updatedCheckpoints: Checkpoint[]; updatedMessages: unknown[] } {
  if (checkpoints.length === 0) {
    return { description: null, updatedCheckpoints: checkpoints, updatedMessages: messages };
  }

  // Determine which checkpoint to rewind to
  let cpIndex: number;
  if (index === undefined) {
    cpIndex = checkpoints.length - 1;
  } else if (index < 0 || index >= checkpoints.length) {
    return {
      description: `Invalid checkpoint index ${index}. Available: 0-${checkpoints.length - 1}`,
      updatedCheckpoints: checkpoints,
      updatedMessages: messages,
    };
  } else {
    cpIndex = index;
  }

  const cp = checkpoints[cpIndex]!;

  // Remove this checkpoint and all after it
  const updatedCheckpoints = checkpoints.slice(0, cpIndex);

  // Undo file changes back to checkpoint's undo stack size
  const undosNeeded = undoManager.size - cp.undoSize;
  const undone: string[] = [];
  for (let i = 0; i < undosNeeded; i++) {
    const result = undoManager.undo();
    if (result) undone.push(result);
  }

  // Truncate messages back to checkpoint's message index (clamped to current length in case pruning shortened the array)
  const safeIndex = Math.min(cp.messageIndex, messages.length);
  const updatedMessages = messages.slice(0, safeIndex);
  const age = Math.round((Date.now() - cp.timestamp) / 1000);

  const description = [
    `Rewound to checkpoint "${cp.label}" (${age}s ago, message index ${cp.messageIndex})`,
    undone.length > 0 ? `File changes undone:\n${undone.join("\n")}` : "No file changes to undo.",
    `Remaining checkpoints: ${updatedCheckpoints.length}`,
  ].join("\n");

  return { description, updatedCheckpoints, updatedMessages };
}

/**
 * List all saved checkpoints with their labels and timestamps.
 */
export function listCheckpoints(checkpoints: Checkpoint[]): CheckpointListEntry[] {
  return checkpoints.map((cp, i) => {
    const ageMs = Date.now() - cp.timestamp;
    const ageSec = Math.round(ageMs / 1000);
    let age: string;
    if (ageSec < 60) age = `${ageSec}s ago`;
    else if (ageSec < 3600) age = `${Math.round(ageSec / 60)}m ago`;
    else age = `${Math.round(ageSec / 3600)}h ago`;

    return {
      index: i,
      label: cp.label,
      messageIndex: cp.messageIndex,
      timestamp: cp.timestamp,
      age,
    };
  });
}

/**
 * Get number of available checkpoints.
 */
export function getCheckpointCount(checkpoints: Checkpoint[]): number {
  return checkpoints.length;
}
