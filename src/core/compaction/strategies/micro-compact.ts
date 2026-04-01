// KCode - Micro-Compact Strategy
// Instant, no-LLM compaction that truncates old tool results and long messages.
// More aggressive than simple tool-result compression: also handles text messages
// and generates structured JSON summaries for tool calls.

import type { Message, ContentBlock, ToolUseBlock, ToolResultBlock, TextBlock } from "../../types.js";
import type { MicroCompactConfig, MicroCompactResult } from "../types.js";
import { HEAVY_OUTPUT_TOOLS, COHERENCE_TOOLS } from "../types.js";
import { CHARS_PER_TOKEN } from "../../token-budget.js";

/**
 * Micro-compact messages: truncate tool results and long text in older messages.
 * Does NOT use the LLM — purely structural compression.
 */
export function microCompact(
  messages: Message[],
  config?: Partial<MicroCompactConfig>,
): MicroCompactResult {
  const preserveRecent = config?.preserveRecent ?? 10;
  const toolResultThreshold = config?.toolResultThreshold ?? 300;
  const assistantThreshold = config?.assistantThreshold ?? 500;

  // Tool-aware compaction: only compact heavy tools, preserve coherence tools
  const compactableTools = config?.compactableTools
    ? new Set(config.compactableTools)
    : HEAVY_OUTPUT_TOOLS;
  const preserveTools = config?.preserveTools
    ? new Set(config.preserveTools)
    : COHERENCE_TOOLS;

  let compressedCount = 0;
  let charsRecovered = 0;

  const compressibleEnd = Math.max(0, messages.length - preserveRecent);

  const result: Message[] = messages.map((msg, index) => {
    // Preserve recent messages
    if (index >= compressibleEnd) return msg;

    // Handle string content (both user and assistant)
    if (typeof msg.content === "string") {
      const threshold = msg.role === "assistant" ? assistantThreshold : toolResultThreshold;
      if (msg.content.length > threshold) {
        const truncLen = Math.min(200, Math.floor(threshold * 0.6));
        const original = msg.content;
        const newContent = original.slice(0, truncLen) + `... [compactado, ${original.length} chars originales]`;
        charsRecovered += original.length - newContent.length;
        compressedCount++;
        return { ...msg, content: newContent };
      }
      return msg;
    }

    if (!Array.isArray(msg.content)) return msg;

    // Process array content blocks
    let modified = false;
    const newContent: ContentBlock[] = [];

    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i]!;

      if (block.type === "tool_use") {
        // Skip compaction for coherence tools (Edit, Write, etc.)
        if (preserveTools.has(block.name)) {
          newContent.push(block);
          continue;
        }
        // Only compact results from heavy-output tools
        if (!compactableTools.has(block.name)) {
          newContent.push(block);
          continue;
        }
        // Look for the corresponding tool_result in this message or nearby
        const toolResult = findToolResult(msg.content, block.id, i);
        if (toolResult && typeof toolResult.content === "string" && toolResult.content.length > toolResultThreshold) {
          // Generate structured JSON summary
          const summary = buildToolSummary(block, toolResult);
          const summaryText = JSON.stringify(summary);
          charsRecovered += toolResult.content.length - summaryText.length;
          // Keep the tool_use but replace tool_result content
          newContent.push(block);
          compressedCount++;
          modified = true;
          continue;
        }
        newContent.push(block);
        continue;
      }

      if (block.type === "tool_result") {
        // Check if we already processed this via a paired tool_use
        const alreadyHandled = newContent.some(
          (b) => b.type === "tool_use" && (b as ToolUseBlock).id === block.tool_use_id,
        );

        // Find the associated tool_use to determine tool name
        const pairedToolUse = findToolUse(msg.content, block.tool_use_id);
        if (pairedToolUse && preserveTools.has(pairedToolUse.name)) {
          newContent.push(block);
          continue;
        }
        if (pairedToolUse && !compactableTools.has(pairedToolUse.name)) {
          newContent.push(block);
          continue;
        }

        if (typeof block.content === "string" && block.content.length > toolResultThreshold) {
          const summary = {
            summary: `tool_result for ${block.tool_use_id}`,
            result: block.is_error ? "error" : "exito",
            output_preview: block.content.slice(0, 100),
          };
          const summaryText = JSON.stringify(summary);
          charsRecovered += block.content.length - summaryText.length;
          newContent.push({
            ...block,
            content: summaryText,
          } as ToolResultBlock);
          if (!alreadyHandled) compressedCount++;
          modified = true;
          continue;
        }
        newContent.push(block);
        continue;
      }

      if (block.type === "text") {
        const threshold = msg.role === "assistant" ? assistantThreshold : toolResultThreshold;
        if (block.text.length > threshold) {
          const truncLen = Math.min(200, Math.floor(threshold * 0.6));
          const newText = block.text.slice(0, truncLen) + `... [compactado, ${block.text.length} chars originales]`;
          charsRecovered += block.text.length - newText.length;
          newContent.push({ type: "text", text: newText } as TextBlock);
          compressedCount++;
          modified = true;
          continue;
        }
        newContent.push(block);
        continue;
      }

      // Pass through other block types (thinking, etc.)
      newContent.push(block);
    }

    return modified ? { ...msg, content: newContent } : msg;
  });

  const tokensRecovered = Math.floor(charsRecovered / CHARS_PER_TOKEN);

  return { messages: result, compressedCount, tokensRecovered };
}

// ─── Helpers ────────────────────────────────────────────────────

function findToolUse(
  blocks: ContentBlock[],
  toolUseId: string,
): ToolUseBlock | null {
  for (const b of blocks) {
    if (b.type === "tool_use" && (b as ToolUseBlock).id === toolUseId) {
      return b as ToolUseBlock;
    }
  }
  return null;
}

function findToolResult(
  blocks: ContentBlock[],
  toolUseId: string,
  startIndex: number,
): ToolResultBlock | null {
  for (let i = startIndex + 1; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.type === "tool_result" && b.tool_use_id === toolUseId) {
      return b;
    }
  }
  return null;
}

function buildToolSummary(
  toolUse: ToolUseBlock,
  toolResult: ToolResultBlock,
): Record<string, string> {
  const target = extractTarget(toolUse);
  return {
    summary: `Ejecuto ${toolUse.name}${target ? ` en ${target}` : ""}`,
    result: toolResult.is_error ? "error" : "exito",
    output_preview: typeof toolResult.content === "string" ? toolResult.content.slice(0, 100) : "[complex]",
  };
}

function extractTarget(toolUse: ToolUseBlock): string | null {
  const input = toolUse.input;
  if (typeof input.file_path === "string") return input.file_path as string;
  if (typeof input.path === "string") return input.path as string;
  if (typeof input.command === "string") return (input.command as string).slice(0, 60);
  if (typeof input.pattern === "string") return input.pattern as string;
  return null;
}
