// Emergency Pruner — Last-resort context reduction when compaction fails.
//
// Activated when:
// 1. Normal compaction failed or didn't free enough space
// 2. Context is at >95% capacity
// 3. Model returned context-length-exceeded error
//
// Strategies (escalating aggressiveness):
// 1. Truncate tool results to headChars + tailChars (except pinned)
// 2. Remove old turns (keep last 20%)
// 3. Strip tool results entirely (replace with "[truncated]")
// 4. Nuclear: keep only system prompt + last turn

export type PruneStrategy =
  | "truncate-tools"
  | "remove-old-turns"
  | "strip-tool-results"
  | "nuclear";

export interface PruneResult {
  strategy: PruneStrategy;
  messagesRemoved: number;
  estimatedTokensFreed: number;
  warning: string;
}

export interface Message {
  role: string;
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface PruneOptions {
  /** Indices of messages that must never be removed or truncated */
  pinnedIndices: Set<number>;
  /** Estimated current token count */
  currentTokens: number;
  /** Target token count to reach */
  targetTokens: number;
  /** Max chars to keep in tool result head */
  headChars?: number;
  /** Max chars to keep in tool result tail */
  tailChars?: number;
}

const DEFAULT_HEAD_CHARS = 1000;
const DEFAULT_TAIL_CHARS = 500;

/** Estimate tokens from string length (~4 chars per token) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function getMessageText(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => c.text ?? "")
      .join("\n");
  }
  return "";
}

function setMessageText(msg: Message, text: string): Message {
  if (typeof msg.content === "string") {
    return { ...msg, content: text };
  }
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

/** Truncate a tool result preserving head and tail */
function truncateText(
  text: string,
  headChars: number,
  tailChars: number,
): { text: string; charsSaved: number } {
  const minLength = headChars + tailChars + 50;
  if (text.length <= minLength) return { text, charsSaved: 0 };

  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const omitted = text.length - headChars - tailChars;
  return {
    text: `${head}\n\n[... ${omitted} chars omitted ...]\n\n${tail}`,
    charsSaved: omitted - 40, // account for the placeholder text
  };
}

/** Strategy 1: Truncate large tool results */
function truncateTools(
  messages: Message[],
  opts: PruneOptions,
): { messages: Message[]; result: PruneResult } {
  const headChars = opts.headChars ?? DEFAULT_HEAD_CHARS;
  const tailChars = opts.tailChars ?? DEFAULT_TAIL_CHARS;
  let totalCharsSaved = 0;

  const output = messages.map((msg, i) => {
    if (opts.pinnedIndices.has(i)) return msg;
    if (msg.role !== "tool" && msg.role !== "function") return msg;

    const text = getMessageText(msg);
    if (text.length <= headChars + tailChars + 50) return msg;

    const { text: truncated, charsSaved } = truncateText(text, headChars, tailChars);
    totalCharsSaved += charsSaved;
    return setMessageText(msg, truncated);
  });

  return {
    messages: output,
    result: {
      strategy: "truncate-tools",
      messagesRemoved: 0,
      estimatedTokensFreed: estimateTokens(" ".repeat(totalCharsSaved)),
      warning: "Tool results truncated to reduce context size",
    },
  };
}

/** Strategy 2: Remove old turns (keep last 20%) */
function removeOldTurns(
  messages: Message[],
  opts: PruneOptions,
): { messages: Message[]; result: PruneResult } {
  const keepCount = Math.max(4, Math.ceil(messages.length * 0.2));
  const cutIndex = messages.length - keepCount;
  let removedTokens = 0;
  let removedCount = 0;

  const output: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    // Always keep system messages (index 0 typically) and pinned
    if (i === 0 || opts.pinnedIndices.has(i) || i >= cutIndex) {
      output.push(messages[i]);
    } else {
      removedTokens += estimateTokens(getMessageText(messages[i]));
      removedCount++;
    }
  }

  return {
    messages: output,
    result: {
      strategy: "remove-old-turns",
      messagesRemoved: removedCount,
      estimatedTokensFreed: removedTokens,
      warning: `Removed ${removedCount} old messages to reduce context`,
    },
  };
}

/** Strategy 3: Strip all tool results */
function stripToolResults(
  messages: Message[],
  opts: PruneOptions,
): { messages: Message[]; result: PruneResult } {
  let freedTokens = 0;

  const output = messages.map((msg, i) => {
    if (opts.pinnedIndices.has(i)) return msg;
    if (msg.role !== "tool" && msg.role !== "function") return msg;

    const text = getMessageText(msg);
    freedTokens += estimateTokens(text);
    return setMessageText(msg, "[result truncated]");
  });

  return {
    messages: output,
    result: {
      strategy: "strip-tool-results",
      messagesRemoved: 0,
      estimatedTokensFreed: freedTokens,
      warning: "All tool results stripped to emergency-reduce context",
    },
  };
}

/** Strategy 4: Nuclear — keep only system prompt + last user/assistant turn */
function nuclearPrune(
  messages: Message[],
  opts: PruneOptions,
): { messages: Message[]; result: PruneResult } {
  const systemMsg = messages.find((m) => m.role === "system");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");

  const output: Message[] = [];
  if (systemMsg) output.push(systemMsg);
  if (lastUser) output.push(lastUser);
  if (lastAssistant) output.push(lastAssistant);

  const removedCount = messages.length - output.length;
  const removedTokens = messages
    .filter((m) => !output.includes(m))
    .reduce((sum, m) => sum + estimateTokens(getMessageText(m)), 0);

  return {
    messages: output,
    result: {
      strategy: "nuclear",
      messagesRemoved: removedCount,
      estimatedTokensFreed: removedTokens,
      warning:
        "NUCLEAR PRUNE: Only system prompt and last turn preserved. Context history lost.",
    },
  };
}

/**
 * Emergency prune — tries strategies in escalating order of aggressiveness.
 * Stops as soon as estimated freed tokens meet the target.
 */
export function emergencyPrune(
  messages: Message[],
  options: PruneOptions,
): { messages: Message[]; result: PruneResult } {
  const needed = options.currentTokens - options.targetTokens;
  if (needed <= 0) {
    return {
      messages,
      result: {
        strategy: "truncate-tools",
        messagesRemoved: 0,
        estimatedTokensFreed: 0,
        warning: "No pruning needed",
      },
    };
  }

  // Try each strategy in order
  const strategies = [truncateTools, removeOldTurns, stripToolResults, nuclearPrune];

  let current = messages;
  for (const strategy of strategies) {
    const { messages: pruned, result } = strategy(current, options);
    if (result.estimatedTokensFreed >= needed) {
      return { messages: pruned, result };
    }
    current = pruned;
  }

  // If we got here, nuclear was applied
  return nuclearPrune(current, options);
}
