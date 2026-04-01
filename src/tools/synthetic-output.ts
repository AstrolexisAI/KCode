// KCode - Synthetic Output Tool
// Injects content into the conversation stream without executing external actions.

import type { ToolDefinition, ToolResult } from "../core/types";

export interface SyntheticOutputInput {
  content: string;
  type?: "text" | "json" | "markdown" | "error";
  visible?: boolean;
}

export const syntheticOutputDefinition: ToolDefinition = {
  name: "SyntheticOutput",
  description:
    "Insert synthetic content into the conversation stream without executing an external action. " +
    "Useful for injecting context, simulated results, or structured data. " +
    "Content with visible=false is recorded in the conversation but not shown to the user.",
  input_schema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "Content to inject into the stream",
      },
      type: {
        type: "string",
        enum: ["text", "json", "markdown", "error"],
        description: "Content type (default: text)",
      },
      visible: {
        type: "boolean",
        description: "Whether the user sees this output (default: true)",
      },
    },
    required: ["content"],
  },
};

export async function executeSyntheticOutput(input: Record<string, unknown>): Promise<ToolResult> {
  const opts = input as unknown as SyntheticOutputInput;
  const contentType = opts.type ?? "text";
  const visible = opts.visible !== false;
  const content = opts.content ?? "";

  // Validate JSON if type is json
  if (contentType === "json") {
    try {
      JSON.parse(content);
    } catch {
      return {
        tool_use_id: "",
        content: "Error: content is not valid JSON",
        is_error: true,
      };
    }
  }

  // For error type, mark as error result
  if (contentType === "error") {
    return {
      tool_use_id: "",
      content,
      is_error: true,
    };
  }

  // If not visible, prefix with metadata marker so the UI can hide it
  const output = visible ? content : `[synthetic:hidden] ${content}`;

  return {
    tool_use_id: "",
    content: output,
  };
}
