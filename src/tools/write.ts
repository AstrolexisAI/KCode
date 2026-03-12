// KCode - Write Tool
// Creates or overwrites files

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolDefinition, ToolResult, FileWriteInput } from "../core/types";

export const writeDefinition: ToolDefinition = {
  name: "Write",
  description: "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["file_path", "content"],
  },
};

export async function executeWrite(input: Record<string, unknown>): Promise<ToolResult> {
  const { file_path, content } = input as FileWriteInput;

  try {
    mkdirSync(dirname(file_path), { recursive: true });
    writeFileSync(file_path, content, "utf-8");

    const lineCount = content.split("\n").length;
    return {
      tool_use_id: "",
      content: `File written successfully: ${file_path} (${lineCount} lines)`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      tool_use_id: "",
      content: `Error writing file: ${msg}`,
      is_error: true,
    };
  }
}
