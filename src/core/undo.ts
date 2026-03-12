// KCode - Undo System
// Tracks file modifications and allows reverting the last tool action

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export interface FileSnapshot {
  filePath: string;
  /** Original content before modification, or null if file didn't exist */
  previousContent: string | null;
  /** Whether the file existed before the action */
  existed: boolean;
}

export interface UndoAction {
  toolName: string;
  timestamp: number;
  snapshots: FileSnapshot[];
  description: string;
}

// ─── Undo Manager ───────────────────────────────────────────────

const MAX_UNDO_STACK = 20;

export class UndoManager {
  private stack: UndoAction[] = [];

  /**
   * Capture a file snapshot before modification.
   * Call this before the tool writes/edits the file.
   */
  captureSnapshot(filePath: string): FileSnapshot {
    let previousContent: string | null = null;
    let existed = false;

    try {
      if (existsSync(filePath)) {
        previousContent = readFileSync(filePath, "utf-8");
        existed = true;
      }
    } catch {
      // If we can't read the file, we can't undo
    }

    return { filePath, previousContent, existed };
  }

  /**
   * Record an undoable action (after the tool has executed).
   */
  pushAction(toolName: string, snapshots: FileSnapshot[], description: string): void {
    this.stack.push({
      toolName,
      timestamp: Date.now(),
      snapshots,
      description,
    });

    // Trim stack if too large
    if (this.stack.length > MAX_UNDO_STACK) {
      this.stack.shift();
    }
  }

  /**
   * Undo the most recent action. Returns a description of what was undone, or null if nothing to undo.
   */
  undo(): string | null {
    const action = this.stack.pop();
    if (!action) return null;

    const restored: string[] = [];

    for (const snapshot of action.snapshots) {
      try {
        if (snapshot.existed && snapshot.previousContent !== null) {
          // Restore original content
          writeFileSync(snapshot.filePath, snapshot.previousContent, "utf-8");
          restored.push(`Restored ${snapshot.filePath}`);
        } else if (!snapshot.existed) {
          // File was created by the action — remove it
          if (existsSync(snapshot.filePath)) {
            unlinkSync(snapshot.filePath);
            restored.push(`Removed ${snapshot.filePath} (was newly created)`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        restored.push(`Failed to restore ${snapshot.filePath}: ${msg}`);
        log.error("undo", `Failed to restore ${snapshot.filePath}: ${msg}`);
      }
    }

    const summary = `Undid ${action.toolName}: ${action.description}\n${restored.join("\n")}`;
    log.info("undo", summary);
    return summary;
  }

  /**
   * Peek at the most recent undoable action without removing it.
   */
  peek(): UndoAction | undefined {
    return this.stack[this.stack.length - 1];
  }

  /**
   * Number of actions in the undo stack.
   */
  get size(): number {
    return this.stack.length;
  }

  /**
   * Clear the entire undo stack.
   */
  clear(): void {
    this.stack = [];
  }
}
