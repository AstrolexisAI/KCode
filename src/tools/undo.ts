// KCode - Undo Tool
// Exposes the undo system as a tool for the LLM to revert file changes

import type { ToolDefinition, ToolResult } from "../core/types";
import type { UndoManager } from "../core/undo";

// The UndoManager instance is injected at registration time
let _undoManager: UndoManager | null = null;

export function setUndoManager(manager: UndoManager): void {
  _undoManager = manager;
}

export const undoDefinition: ToolDefinition = {
  name: "Undo",
  description:
    "Undo the last file modification (Edit, Write, MultiEdit, or Rename). " +
    "Reverts files to their state before the tool was executed. " +
    "Use action='peek' to see what would be undone without reverting. " +
    "Use action='list' to see all undoable actions.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["undo", "peek", "list"],
        description: "Action to perform (default: undo)",
      },
      count: {
        type: "number",
        description: "Number of actions to undo (default: 1, max: 5)",
      },
    },
  },
};

export async function executeUndo(input: Record<string, unknown>): Promise<ToolResult> {
  if (!_undoManager) {
    return { tool_use_id: "", content: "Error: Undo system not initialized.", is_error: true };
  }

  const action = String(input.action ?? "undo").trim();

  if (action === "peek") {
    const top = _undoManager.peek();
    if (!top) {
      return { tool_use_id: "", content: "Nothing to undo." };
    }
    const age = Math.round((Date.now() - top.timestamp) / 1000);
    return {
      tool_use_id: "",
      content: [
        `Next undo: ${top.description}`,
        `  Tool: ${top.toolName}`,
        `  Files: ${top.snapshots.map((s) => s.filePath).join(", ")}`,
        `  Age: ${age}s ago`,
        `  Stack depth: ${_undoManager.size}`,
      ].join("\n"),
    };
  }

  if (action === "list") {
    const all = _undoManager.list();
    if (all.length === 0) {
      return { tool_use_id: "", content: "Undo stack is empty." };
    }
    const lines: string[] = [`Undo stack (${all.length} action${all.length === 1 ? "" : "s"}, most recent first):`];
    for (let i = 0; i < Math.min(all.length, 10); i++) {
      const a = all[i]!;
      const age = Math.round((Date.now() - a.timestamp) / 1000);
      const files = a.snapshots.length <= 2
        ? a.snapshots.map((s) => s.filePath.split("/").pop()).join(", ")
        : `${a.snapshots.length} files`;
      lines.push(`  ${i + 1}. ${a.description} (${a.toolName}, ${age}s ago) [${files}]`);
    }
    if (all.length > 10) {
      lines.push(`  ... and ${all.length - 10} more`);
    }
    return { tool_use_id: "", content: lines.join("\n") };
  }

  // Undo action(s)
  const count = Math.max(1, Math.min(5, Number(input.count ?? 1)));
  const results: string[] = [];

  for (let i = 0; i < count; i++) {
    const result = _undoManager.undo();
    if (!result) {
      if (i === 0) return { tool_use_id: "", content: "Nothing to undo." };
      break;
    }
    results.push(result);
  }

  return {
    tool_use_id: "",
    content: results.join("\n\n"),
  };
}
