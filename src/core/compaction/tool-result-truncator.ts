// Tool Result Truncator — Pre-compaction truncation of large tool outputs.
// Runs BEFORE sending messages to the LLM, reducing context pressure
// without losing the conversation flow.

export interface TruncationConfig {
  /** Max chars per tool result before truncation */
  maxChars: number;
  /** Max chars in aggressive mode */
  aggressiveMaxChars: number;
  /** Preserve first N chars */
  headChars: number;
  /** Preserve last N chars */
  tailChars: number;
  /** Tools that are never truncated (e.g., pinned file reads) */
  protectedTools: string[];
}

export const DEFAULT_TRUNCATION_CONFIG: TruncationConfig = {
  maxChars: 10000,
  aggressiveMaxChars: 2000,
  headChars: 1000,
  tailChars: 500,
  protectedTools: [],
};

interface Message {
  role: string;
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  name?: string;
  [key: string]: unknown;
}

interface TruncationResult {
  messages: Message[];
  truncatedCount: number;
  charsSaved: number;
}

function getTextContent(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((c) => c.text ?? "").join("\n");
  }
  return "";
}

function setTextContent(msg: Message, text: string): Message {
  if (typeof msg.content === "string") return { ...msg, content: text };
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    return {
      ...msg,
      content: msg.content.map((c, i) =>
        i === 0 ? { ...c, text } : c,
      ),
    };
  }
  return { ...msg, content: text };
}

/**
 * Truncate tool results in a message array.
 *
 * @param messages - Conversation messages
 * @param config - Truncation configuration
 * @param aggressive - Use aggressiveMaxChars instead of maxChars
 */
export function truncateToolResults(
  messages: Message[],
  config: Partial<TruncationConfig> = {},
  aggressive = false,
): TruncationResult {
  const cfg = { ...DEFAULT_TRUNCATION_CONFIG, ...config };
  const maxChars = aggressive ? cfg.aggressiveMaxChars : cfg.maxChars;
  let truncatedCount = 0;
  let charsSaved = 0;

  const output = messages.map((msg) => {
    // Only truncate tool/function results
    if (msg.role !== "tool" && msg.role !== "function") return msg;

    // Skip protected tools
    if (msg.name && cfg.protectedTools.includes(msg.name)) return msg;

    const text = getTextContent(msg);
    if (text.length <= maxChars) return msg;

    // Truncate preserving head + tail
    const head = text.slice(0, cfg.headChars);
    const tail = text.slice(-cfg.tailChars);
    const omitted = text.length - cfg.headChars - cfg.tailChars;
    const truncated = `${head}\n\n[... ${omitted} chars omitted ...]\n\n${tail}`;

    truncatedCount++;
    charsSaved += text.length - truncated.length;
    return setTextContent(msg, truncated);
  });

  return { messages: output, truncatedCount, charsSaved };
}
