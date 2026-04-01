// KCode - Post-Compact File Restoration
// After full compaction, re-inject the most recently read files so the model
// retains working context about the codebase.

import { log } from "../../logger.js";
import { CHARS_PER_TOKEN } from "../../token-budget.js";
import type { Message, TextBlock } from "../../types.js";
import type { FullCompactConfig } from "../types.js";
import { extractFilePaths } from "./full-compact.js";

/**
 * Read a file's content for restoration. Returns null if the file can't be read
 * or exceeds the size limit.
 */
async function readFileForRestore(filePath: string, maxBytes: number): Promise<string | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    if (file.size > maxBytes) {
      // Read only the first maxBytes
      const buffer = await file.slice(0, maxBytes).text();
      return buffer + `\n... [truncated at ${maxBytes} bytes]`;
    }
    return await file.text();
  } catch (err) {
    log.debug("compaction", `Failed to read file for restoration: ${filePath}: ${err}`);
    return null;
  }
}

/**
 * After a full compaction, restore the most recently accessed files by
 * injecting their current content as context messages.
 *
 * @param messages - The post-compaction message array
 * @param compactedMessages - The messages that were compacted (to scan for file paths)
 * @param config - Full compact configuration with restoration budget
 * @param fileReader - Optional custom file reader (for testing)
 * @returns Messages with restored file context injected
 */
export async function restoreRecentFiles(
  messages: Message[],
  compactedMessages: Message[],
  config?: Partial<FullCompactConfig>,
  fileReader?: (path: string, maxBytes: number) => Promise<string | null>,
): Promise<Message[]> {
  const maxFiles = config?.maxFilesToRestore ?? 5;
  const maxBytesPerFile = config?.maxBytesPerFile ?? 5120;
  const budgetTokens = config?.fileRestoreBudget ?? 50_000;
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;

  // Extract file paths from compacted messages (most recent last)
  const allPaths = extractFilePaths(compactedMessages);
  if (allPaths.length === 0) return messages;

  // Take the last N paths (most recently accessed)
  const candidates = allPaths.slice(-maxFiles);
  const reader = fileReader ?? readFileForRestore;

  const restorations: Message[] = [];
  let totalChars = 0;

  for (const filePath of candidates) {
    if (totalChars >= budgetChars) break;

    const content = await reader(filePath, maxBytesPerFile);
    if (!content) continue;

    // Check budget
    if (totalChars + content.length > budgetChars) continue;

    restorations.push(
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `[Contexto restaurado] Contenido actual de ${filePath}:\n\`\`\`\n${content}\n\`\`\``,
          } as TextBlock,
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Entendido, tengo el contexto actualizado.",
          } as TextBlock,
        ],
      },
    );

    totalChars += content.length;
  }

  if (restorations.length > 0) {
    log.info(
      "compaction",
      `Restored ${restorations.length / 2} files post-compaction (${Math.ceil(totalChars / CHARS_PER_TOKEN)} tokens)`,
    );
  }

  // Insert restorations after the summary message but before recent messages.
  // The summary message is typically the second message (after the first preserved user msg).
  // Find insertion point: right after the summary message
  const summaryIndex = messages.findIndex(
    (m) =>
      m.role === "user" &&
      Array.isArray(m.content) &&
      m.content.some(
        (b) => b.type === "text" && (b as TextBlock).text.includes("[Conversation Summary"),
      ),
  );

  if (summaryIndex >= 0) {
    const result = [...messages];
    result.splice(summaryIndex + 1, 0, ...restorations);
    return result;
  }

  // Fallback: insert near the beginning
  return [...messages.slice(0, 1), ...restorations, ...messages.slice(1)];
}
