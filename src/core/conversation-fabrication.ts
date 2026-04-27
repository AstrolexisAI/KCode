// KCode - Conversation Fabrication Guard
// Extracted from conversation.ts — Phase 13 anti-fabrication guard:
// inspect tool-result error blocks for file-path-bearing tools
// (Read / Edit / Write / MultiEdit), run the fabrication heuristic
// against the reference corpus, and if the path looks fabricated,
// wrap the error content with a STOP warning.

import { log } from "./logger";
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "./types";

/**
 * Inspect `toolResultBlocks` for errors on file-path-bearing tools and,
 * if the attempted path looks fabricated against `messages`, wrap the
 * error content with a STOP warning.
 *
 * Mutates the blocks in place and returns the same array for fluent
 * chaining. Zero-cost on successful tool calls (is_error=false blocks
 * short-circuit before the heuristic runs).
 */
export function augmentFabricationWarnings(
  messages: Message[],
  toolResultBlocks: ContentBlock[],
  toolCalls: ToolUseBlock[],
): ContentBlock[] {
  try {
    const { collectReferenceTexts, isLikelyFabricated, wrapFabricatedError } =
      require("./anti-fabrication.js") as typeof import("./anti-fabrication.js");
    let referenceTexts: string[] | null = null;
    for (const block of toolResultBlocks) {
      const b = block as ToolResultBlock;
      if (b.type !== "tool_result" || !b.is_error) continue;
      const call = toolCalls.find((tc) => tc.id === b.tool_use_id);
      if (!call) continue;
      const name = call.name;
      if (name !== "Read" && name !== "Edit" && name !== "Write" && name !== "MultiEdit") {
        continue;
      }
      const input = call.input as Record<string, unknown>;
      const attemptedPath = String(input.file_path ?? "");
      if (!attemptedPath) continue;
      const errorText = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      if (referenceTexts === null) {
        referenceTexts = collectReferenceTexts(messages);
      }
      const verdict = isLikelyFabricated(attemptedPath, errorText, referenceTexts);
      if (verdict.fabricated) {
        const originalContent = typeof b.content === "string" ? b.content : errorText;
        b.content = wrapFabricatedError(originalContent, attemptedPath, verdict.unreferencedTokens);
        log.info(
          "anti-fabrication",
          `fabricated path detected: ${attemptedPath} — unreferenced tokens [${verdict.unreferencedTokens.join(",")}]`,
        );
      }
    }
  } catch (err) {
    log.debug("anti-fabrication", `augment failed (non-fatal): ${err}`);
  }
  return toolResultBlocks;
}
