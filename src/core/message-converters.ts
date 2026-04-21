// KCode - Message Converters
// Convert internal Message[] format to provider-specific API formats (OpenAI, Anthropic)

import type { Message, OpenAIMessage, OpenAIToolCall, OpenAIToolDefinition } from "./types";

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
 *
 * OpenAI o1/o3/o4 (reasoning models) reject the "system" role — they require
 * "developer" instead. Pass systemRole: "developer" for those models.
 */
export function convertToOpenAIMessages(
  systemPrompt: string,
  messages: Message[],
  systemRole: "system" | "developer" = "system",
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  // System message first (role depends on provider/model capability)
  if (systemPrompt) {
    result.push({ role: systemRole, content: systemPrompt });
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

      let reasoningContent: string | undefined;
      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "thinking") {
          // Some providers (Kimi/Moonshot, DeepSeek-R1) require reasoning_content as a
          // separate field in the assistant message — not embedded in text content.
          // We collect it here; the caller decides whether to use it via includeReasoning.
          reasoningContent = (reasoningContent ?? "") + block.thinking;
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
      // Include reasoning_content when present so providers that require it
      // (Kimi, DeepSeek-R1) don't reject the conversation history with 400.
      if (reasoningContent) {
        (assistantMsg as Record<string, unknown>).reasoning_content = reasoningContent;
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
export function convertToAnthropicMessages(messages: Message[]): AnthropicMessage[] {
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
        const content =
          typeof block.content === "string"
            ? block.content
            : block.content.map((b) => (b.type === "text" ? b.text : JSON.stringify(b))).join("\n");
        blocks.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content,
          is_error: block.is_error,
        });
      }
    }

    if (blocks.length === 0) continue; // Skip empty content

    // Merge consecutive same-role messages — BUT never merge tool_result blocks
    // into a message that doesn't already have tool_result blocks (or vice versa).
    // Anthropic requires tool_result blocks to be in the message immediately after
    // the assistant message containing the corresponding tool_use blocks.
    const hasToolResult = blocks.some((b) => b.type === "tool_result");
    const hasToolUse = blocks.some((b) => b.type === "tool_use");
    const last = result[result.length - 1];
    const lastHasToolResult = last && Array.isArray(last.content) &&
      last.content.some((b: { type: string }) => b.type === "tool_result");
    const lastHasToolUse = last && Array.isArray(last.content) &&
      last.content.some((b: { type: string }) => b.type === "tool_use");

    // Only merge if neither side has tool blocks (safe text-only merge)
    const canMerge = last && last.role === msg.role &&
      !hasToolResult && !hasToolUse && !lastHasToolResult && !lastHasToolUse;

    if (canMerge) {
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

  // Sanitize orphan tool_use blocks. Anthropic enforces that every tool_use
  // in an assistant message must be immediately followed by a matching
  // tool_result in the next user message — or the request 400s with
  // "tool_use ids were found without tool_result blocks immediately after".
  // This was catastrophic on the NEXUS Telemetry session where Opus 4.6 and
  // Sonnet 4.6 both died after phase-20 blocked a pkill and some code path
  // failed to emit the synthetic tool_result (either an early-return in the
  // stop-condition handlers with updatedContent undefined, or a partial
  // stream that crashed before the executor ran). Rather than track down
  // every possible source of orphans, we sanitize at the serialization
  // boundary: any orphan tool_use gets a synthetic "(execution not
  // completed)" tool_result wedged in right after. Grok/OpenAI-compatible
  // APIs are more lenient but running this for all providers keeps the
  // invariant airtight.
  sanitizeOrphanToolUses(result);

  return result;
}

/**
 * Walk an Anthropic-format message array and ensure every assistant tool_use
 * has a matching tool_result in the next user message. Mutates the array.
 *
 * Behavior:
 * - If the next message is user + content-array, append synthetic tool_result
 *   blocks for any missing tool_use_ids at the front (order-stable).
 * - If the next message is missing, user+string, or assistant, insert a new
 *   user message containing the synthetic tool_results right after.
 * - Every injected block is_error=true with a short diagnostic so the model
 *   sees why its tool didn't run.
 */
function sanitizeOrphanToolUses(messages: AnthropicMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    const toolUseIds: string[] = [];
    for (const block of msg.content as Array<{ type: string; id?: string }>) {
      if (block.type === "tool_use" && typeof block.id === "string") {
        toolUseIds.push(block.id);
      }
    }
    if (toolUseIds.length === 0) continue;

    const next = messages[i + 1];
    const matched = new Set<string>();
    if (next && next.role === "user" && Array.isArray(next.content)) {
      for (const block of next.content as Array<{ type: string; tool_use_id?: string }>) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          matched.add(block.tool_use_id);
        }
      }
    }

    const orphans = toolUseIds.filter((id) => !matched.has(id));
    if (orphans.length === 0) continue;

    const synthetic = orphans.map((id) => ({
      type: "tool_result" as const,
      tool_use_id: id,
      content: "(execution not completed: tool run was interrupted before a result could be produced)",
      is_error: true,
    }));

    if (next && next.role === "user" && Array.isArray(next.content)) {
      // Prepend so synthetic results come before any unrelated user text
      // blocks — Anthropic only requires they be in the message, not first.
      // Prepending keeps it visually clear what kcode injected.
      (next.content as unknown[]).unshift(...synthetic);
    } else {
      messages.splice(i + 1, 0, {
        role: "user",
        content: synthetic as unknown as AnthropicContentBlock[],
      });
      // Don't advance past the inserted message — the outer for-loop
      // increment will skip it naturally since the next assistant message
      // is now at i+2.
    }
  }
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
