// KCode - Full Compact Strategy
// LLM-based compaction that summarizes older messages into a narrative.
// Improved over the original compaction.ts with round-grouping and better prompts.

import { log } from "../../logger.js";
import type { ContentBlock, Message, TextBlock, ToolUseBlock } from "../../types.js";
import type { FullCompactConfig, FullCompactResult, LlmSummarizer } from "../types.js";

// ─── Summarization Prompt ───────────────────────────────────────

const FULL_COMPACT_SYSTEM_PROMPT =
  "You are a conversation summarizer for a coding assistant. " +
  "Produce a concise summary preserving the essential context.";

const FULL_COMPACT_USER_PROMPT_TEMPLATE =
  "Resume esta conversacion preservando:\n" +
  "- Decisiones tomadas y su razon\n" +
  "- Archivos creados o modificados (paths exactos)\n" +
  "- Errores encontrados y como se resolvieron\n" +
  "- Estado actual del trabajo (que falta por hacer)\n" +
  "- Preferencias del usuario expresadas\n\n" +
  "NO incluyas:\n" +
  "- Contenido literal de archivos (se restaurara por separado)\n" +
  "- Outputs completos de herramientas\n" +
  "- Detalles de implementacion que estan en el codigo\n\n" +
  "Formato: Narrativa concisa en primera persona, max 2000 tokens.\n\n" +
  "---\n\n";

// ─── Full Compact ───────────────────────────────────────────────

/**
 * Perform LLM-based compaction on a set of messages.
 *
 * @param messages - All conversation messages
 * @param keepFirst - Number of initial messages to preserve
 * @param keepLast - Number of recent messages to preserve
 * @param summarizer - Injected LLM call function (for testability)
 * @param config - Full compact configuration
 * @returns Result with the compacted messages and metadata
 */
export async function fullCompact(
  messages: Message[],
  keepFirst: number,
  keepLast: number,
  summarizer: LlmSummarizer,
  config?: Partial<FullCompactConfig>,
): Promise<FullCompactResult> {
  const maxSummaryTokens = config?.maxSummaryTokens ?? 2000;
  const groupByRounds = config?.groupByRounds ?? true;

  if (messages.length <= keepFirst + keepLast) {
    return { messages: [...messages], compactedMessages: [], summaryTokens: 0 };
  }

  // Extract the messages to compact (middle section)
  const toCompact = messages.slice(keepFirst, messages.length - keepLast);
  const preserved = messages.slice(0, keepFirst);
  const recent = messages.slice(messages.length - keepLast);

  // Build the summarization input
  const conversationText = groupByRounds
    ? groupMessagesIntoRounds(toCompact)
    : messagesToText(toCompact);

  const prompt = FULL_COMPACT_USER_PROMPT_TEMPLATE + conversationText;

  const summaryText = await summarizer(prompt, FULL_COMPACT_SYSTEM_PROMPT, maxSummaryTokens);

  if (!summaryText) {
    throw new Error("LLM summarizer returned null — compaction failed");
  }

  // Cap summary length to prevent context pollution
  const safeSummary =
    summaryText.length > 10_000
      ? summaryText.slice(0, 10_000) + "\n[summary truncated]"
      : summaryText;

  // Create the summary message
  const summaryMessage: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text:
          `[Conversation Summary - Full Compaction]\n` +
          `The following is a summary of ${toCompact.length} earlier messages ` +
          `that were compacted to save context space:\n\n${safeSummary}`,
      } as TextBlock,
    ],
  };

  const compactedMessages = [...preserved, summaryMessage, ...recent];
  const summaryTokens = Math.ceil(safeSummary.length / 3.5);

  return {
    messages: compactedMessages,
    compactedMessages: toCompact,
    summaryTokens,
  };
}

// ─── Extract File Paths ─────────────────────────────────────────

/**
 * Extract file paths from compacted messages by scanning tool_use blocks
 * for Read, Glob, Grep, Edit, Write calls.
 */
export function extractFilePaths(messages: Message[]): string[] {
  const paths = new Set<string>();
  const fileTools = new Set(["Read", "Glob", "Grep", "Edit", "Write", "MultiEdit"]);

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      const toolUse = block as ToolUseBlock;
      if (!fileTools.has(toolUse.name)) continue;

      const input = toolUse.input;
      if (typeof input.file_path === "string") paths.add(input.file_path);
      if (typeof input.path === "string") paths.add(input.path);
    }
  }

  return Array.from(paths);
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Group messages into logical "rounds" (user request + assistant response + tool results).
 */
function groupMessagesIntoRounds(messages: Message[]): string {
  const rounds: string[] = [];
  let currentRound: string[] = [];
  let roundIndex = 1;

  for (const msg of messages) {
    if (msg.role === "user" && currentRound.length > 0) {
      rounds.push(`[Ronda ${roundIndex}]\n${currentRound.join("\n")}`);
      roundIndex++;
      currentRound = [];
    }
    currentRound.push(messageToLine(msg));
  }

  if (currentRound.length > 0) {
    rounds.push(`[Ronda ${roundIndex}]\n${currentRound.join("\n")}`);
  }

  return rounds.join("\n\n");
}

function messagesToText(messages: Message[]): string {
  return messages.map(messageToLine).join("\n");
}

function messageToLine(msg: Message): string {
  const role = msg.role.toUpperCase();

  if (typeof msg.content === "string") {
    return `${role}: ${msg.content.slice(0, 500)}`;
  }

  if (!Array.isArray(msg.content)) return `${role}: [empty]`;

  const parts: string[] = [];
  for (const block of msg.content) {
    switch (block.type) {
      case "text":
        parts.push(block.text.slice(0, 300));
        break;
      case "tool_use":
        parts.push(`[tool_use ${block.name}]: ${JSON.stringify(block.input).slice(0, 200)}`);
        break;
      case "tool_result": {
        const content =
          typeof block.content === "string" ? block.content.slice(0, 200) : "[complex result]";
        parts.push(`[tool_result${block.is_error ? " ERROR" : ""}]: ${content}`);
        break;
      }
    }
  }

  return `${role}: ${parts.join(" | ")}`;
}
