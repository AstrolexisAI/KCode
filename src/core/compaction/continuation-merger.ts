// Continuation Merger — Handles responses that were cut mid-stream.
// When the LLM response is truncated (e.g., max_tokens hit), this module
// detects the truncation and merges the continuation into a single coherent message.

export interface MergeResult {
  merged: boolean;
  originalParts: number;
  finalContent: string;
}

interface Message {
  role: string;
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  finish_reason?: string;
  [key: string]: unknown;
}

function getTextContent(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((c) => c.text ?? "").join("");
  }
  return "";
}

/** Detect if a message was likely truncated mid-stream */
export function isTruncated(msg: Message): boolean {
  // Explicit finish_reason check
  if (msg.finish_reason === "length" || msg.finish_reason === "max_tokens") {
    return true;
  }

  const text = getTextContent(msg);
  if (!text) return false;

  // Heuristic: ends mid-sentence (no terminal punctuation)
  const trimmed = text.trimEnd();
  if (trimmed.length < 10) return false;

  const lastChar = trimmed.at(-1);
  const terminalChars = new Set([".", "!", "?", "}", "]", ")", "`", '"', "\n"]);
  if (terminalChars.has(lastChar!)) return false;

  // Ends with open code block
  const codeBlockCount = (trimmed.match(/```/g) || []).length;
  if (codeBlockCount % 2 !== 0) return true;

  return false;
}

/**
 * Merge consecutive assistant messages that form a continuation.
 * This happens when a response is truncated and the model continues
 * in a new message.
 */
export function mergeConsecutiveAssistant(messages: Message[]): {
  messages: Message[];
  mergeCount: number;
} {
  if (messages.length < 2) return { messages, mergeCount: 0 };

  const output: Message[] = [];
  let mergeCount = 0;

  for (const msg of messages) {
    const prev = output.at(-1);

    if (prev && prev.role === "assistant" && msg.role === "assistant" && isTruncated(prev)) {
      // Merge into previous
      const prevText = getTextContent(prev);
      const currText = getTextContent(msg);
      const merged = smartJoin(prevText, currText);

      if (typeof prev.content === "string") {
        prev.content = merged;
      } else if (Array.isArray(prev.content) && prev.content.length > 0) {
        const first = prev.content[0]!;
        prev.content[0] = { ...first, type: first.type ?? "text", text: merged };
      }

      // Update finish_reason to the continuation's
      prev.finish_reason = msg.finish_reason;
      mergeCount++;
    } else {
      output.push({ ...msg });
    }
  }

  return { messages: output, mergeCount };
}

/** Smart join: avoid double spaces/newlines at the boundary */
function smartJoin(a: string, b: string): string {
  const trimmedA = a.trimEnd();
  const trimmedB = b.trimStart();

  // If A ends mid-word and B starts with lowercase, join directly
  if (/[a-z]$/.test(trimmedA) && /^[a-z]/.test(trimmedB)) {
    return trimmedA + trimmedB;
  }

  // If A ends mid-code-block, continue directly
  const openBlocks = (trimmedA.match(/```/g) || []).length;
  if (openBlocks % 2 !== 0) {
    return trimmedA + "\n" + trimmedB;
  }

  // Default: join with single newline
  return trimmedA + "\n" + trimmedB;
}

/**
 * Merge a truncated response with its continuation.
 */
export function mergeParts(parts: string[]): MergeResult {
  if (parts.length <= 1) {
    return {
      merged: false,
      originalParts: parts.length,
      finalContent: parts[0] ?? "",
    };
  }

  let result = parts[0]!;
  for (let i = 1; i < parts.length; i++) {
    result = smartJoin(result, parts[i]!);
  }

  return {
    merged: true,
    originalParts: parts.length,
    finalContent: result,
  };
}
