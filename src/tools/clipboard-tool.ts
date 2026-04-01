// KCode - Clipboard Tool
// Exposes clipboard copy as a registered tool for the LLM

import { copyToClipboard, getClipboardCommand } from "../core/clipboard";
import type { ToolDefinition, ToolResult } from "../core/types";

export const clipboardDefinition: ToolDefinition = {
  name: "Clipboard",
  description:
    "Copy text to the system clipboard. Useful for sharing code snippets, commands, or output with the user. " +
    "Requires xclip, xsel, or wl-copy to be installed.",
  input_schema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text to copy to the clipboard",
      },
    },
    required: ["text"],
  },
};

export async function executeClipboard(input: Record<string, unknown>): Promise<ToolResult> {
  const text = String(input.text ?? "");

  if (!text) {
    return { tool_use_id: "", content: "Error: text is required.", is_error: true };
  }

  // Check clipboard availability first
  const cmd = getClipboardCommand();
  if (!cmd) {
    return {
      tool_use_id: "",
      content: "Error: No clipboard command found. Install xclip, xsel, or wl-copy.",
      is_error: true,
    };
  }

  const success = await copyToClipboard(text);
  if (!success) {
    return {
      tool_use_id: "",
      content: "Error: Failed to copy to clipboard.",
      is_error: true,
    };
  }

  const preview = text.length > 100 ? `${text.slice(0, 100)}...` : text;
  const charCount = text.length;
  const lineCount = text.split("\n").length;

  return {
    tool_use_id: "",
    content: `Copied to clipboard (${charCount} chars, ${lineCount} line${lineCount === 1 ? "" : "s"}):\n${preview}`,
  };
}
