// KCode - Message Converters
// Convert internal Message[] format to provider-specific API formats (OpenAI, Anthropic)

import type {
  Message,
  OpenAIMessage,
  OpenAIToolCall,
  OpenAIToolDefinition,
} from "./types";

// ─── Anthropic Types ─────────────────────────────────────────────

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// ─── OpenAI Message Conversion ───────────────────────────────────

/**
 * Convert internal Message[] to OpenAI-compatible message format.
 */
export function convertToOpenAIMessages(
  systemPrompt: string,
  messages: Message[],
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  // System message first
  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Complex content blocks
    if (msg.role === "assistant") {
      // Collect text and tool_calls from assistant blocks
      const textParts: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "thinking") {
          // Include thinking as text prefix (local models don't have thinking blocks)
          textParts.push(`<thinking>${block.thinking}</thinking>`);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        }
      }

      const assistantMsg: OpenAIMessage = {
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("\n") : null,
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      result.push(assistantMsg);
    } else if (msg.role === "user") {
      // User messages may contain tool_result blocks
      const textParts: string[] = [];
      const toolResults: OpenAIMessage[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_result") {
          const content =
            typeof block.content === "string"
              ? block.content
              : block.content
                  .map((b) => {
                    if (b.type === "text") return b.text;
                    return JSON.stringify(b);
                  })
                  .join("\n");
          toolResults.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: content,
          });
        }
      }

      // Tool results go as separate "tool" role messages
      for (const tr of toolResults) {
        result.push(tr);
      }

      // Any plain text from the user block
      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("\n") });
      }
    }
  }

  return result;
}

/**
 * Convert tool definitions to OpenAI function-calling format.
 */
export function convertToOpenAITools(
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[],
): OpenAIToolDefinition[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// ─── Anthropic Message Conversion ────────────────────────────────

/**
 * Convert internal Message[] to Anthropic Messages API format.
 * Key differences from OpenAI:
 * - System prompt is NOT a message — goes in top-level `system` field
 * - tool_use/tool_result are content blocks inside user/assistant messages (not separate roles)
 * - Strict user/assistant alternation required
 */
export function convertToAnthropicMessages(
  messages: Message[],
): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      // Merge consecutive same-role messages (Anthropic requires strict alternation)
      const last = result[result.length - 1];
      if (last && last.role === msg.role) {
        if (typeof last.content === "string") {
          last.content = last.content + "\n\n" + msg.content;
        } else {
          last.content.push({ type: "text", text: msg.content });
        }
      } else {
        result.push({ role: msg.role, content: msg.content });
      }
      continue;
    }

    // Complex content blocks — convert to Anthropic format
    const blocks: AnthropicContentBlock[] = [];

    for (const block of msg.content) {
      if (block.type === "text") {
        blocks.push({ type: "text", text: block.text });
      } else if (block.type === "thinking") {
        // Include thinking as text (Anthropic extended thinking is model-native, we just pass text)
        blocks.push({ type: "text", text: `<thinking>${block.thinking}</thinking>` });
      } else if (block.type === "tool_use") {
        blocks.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
      } else if (block.type === "tool_result") {
        const content = typeof block.content === "string"
          ? block.content
          : block.content.map((b) => b.type === "text" ? b.text : JSON.stringify(b)).join("\n");
        blocks.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content,
          is_error: block.is_error,
        });
      }
    }

    if (blocks.length === 0) continue; // Skip empty content

    // Merge consecutive same-role messages
    const last = result[result.length - 1];
    if (last && last.role === msg.role) {
      if (typeof last.content === "string") {
        last.content = [{ type: "text", text: last.content }, ...blocks];
      } else {
        last.content.push(...blocks);
      }
    } else {
      result.push({ role: msg.role, content: blocks });
    }
  }

  // Anthropic requires conversation to start with user message
  if (result.length > 0 && result[0]!.role !== "user") {
    result.unshift({ role: "user", content: "Hello." });
  }

  return result;
}

/**
 * Convert tool definitions to Anthropic format.
 * Anthropic uses { name, description, input_schema } — which is already our internal format.
 */
export function convertToAnthropicTools(
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[],
): AnthropicToolDefinition[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}
