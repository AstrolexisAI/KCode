// KCode - Edit Tool
// Performs exact string replacements in files

import { readFileSync, writeFileSync } from "node:fs";
import type { ToolDefinition, ToolResult, FileEditInput } from "../core/types";

export const editDefinition: ToolDefinition = {
  name: "Edit",
  description: "Perform exact string replacement in a file. The old_string must be unique unless replace_all is true.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file" },
      old_string: { type: "string", description: "The exact text to find and replace" },
      new_string: { type: "string", description: "The replacement text" },
      replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
};

export async function executeEdit(input: Record<string, unknown>): Promise<ToolResult> {
  const { file_path, old_string, new_string, replace_all } = input as FileEditInput;

  try {
    const content = readFileSync(file_path, "utf-8");

    if (old_string === new_string) {
      return {
        tool_use_id: "",
        content: "Error: old_string and new_string are identical. STOP: Do NOT retry this Edit. If the file already contains the desired content, no edit is needed. Move on to the next task.",
        is_error: true,
      };
    }

    const occurrences = content.split(old_string).length - 1;

    if (occurrences === 0) {
      return {
        tool_use_id: "",
        content: `Error: old_string not found in ${file_path}`,
        is_error: true,
      };
    }

    if (occurrences > 1 && !replace_all) {
      return {
        tool_use_id: "",
        content: `Error: old_string found ${occurrences} times. Use replace_all=true to replace all, or provide more context to make it unique.`,
        is_error: true,
      };
    }

    const updated = replace_all ? content.replaceAll(old_string, new_string) : content.replace(old_string, new_string);

    writeFileSync(file_path, updated, "utf-8");

    const replacements = replace_all ? occurrences : 1;
    return {
      tool_use_id: "",
      content: `Edited ${file_path}: replaced ${replacements} occurrence(s)`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      tool_use_id: "",
      content: `Error editing file: ${msg}`,
      is_error: true,
    };
  }
}
