// KCode - SendMessage Tool
// Lets the agent send a status message to the user without expecting a response

import type { ToolDefinition, ToolResult } from "../core/types";

export const sendMessageDefinition: ToolDefinition = {
  name: "SendMessage",
  description:
    "Send a status message to the user without waiting for a response. " +
    "Use this for progress updates, warnings, or informational messages " +
    "when you don't need user input. For questions requiring a response, use AskUser instead.",
  input_schema: {
    type: "object" as const,
    properties: {
      message: {
        type: "string",
        description: "The message to display to the user",
      },
      level: {
        type: "string",
        enum: ["info", "warning", "error"],
        description: "Message severity level (default: info)",
      },
    },
    required: ["message"],
  },
};

export async function executeSendMessage(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const message = String(input.message ?? "");
  const level = (input.level as string) ?? "info";

  if (!message.trim()) {
    return {
      tool_use_id: "",
      content: "Error: message is required",
      is_error: true,
    };
  }

  const prefixes: Record<string, string> = {
    info: "[INFO]",
    warning: "[WARNING]",
    error: "[ERROR]",
  };

  const prefix = prefixes[level] ?? prefixes.info;

  // The message is returned as tool output and will be displayed in the UI
  return {
    tool_use_id: "",
    content: `${prefix} ${message}`,
  };
}
