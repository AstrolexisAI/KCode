// KCode - Image Stripper Strategy
// Pre-processor that removes base64 images from older messages to free tokens

import type { ContentBlock, Message } from "../../types.js";
import type { ImageStripConfig, ImageStripResult } from "../types.js";

/** Estimated tokens per image block (base64 images are typically 1000-2000 tokens). */
const TOKENS_PER_IMAGE = 1500;

/**
 * Check if a message array contains any image or document content blocks.
 */
export function hasImages(messages: Message[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (isImageBlock(block)) return true;
    }
  }
  return false;
}

/**
 * Strip image and document blocks from older messages, replacing them with
 * text markers. Preserves the most recent messages (configurable).
 */
export function stripImages(
  messages: Message[],
  config?: Partial<ImageStripConfig>,
): ImageStripResult {
  const preserveRecent = config?.preserveRecent ?? 4;
  let strippedCount = 0;
  let tokensRecovered = 0;

  // Don't modify the input array — create a shallow copy
  const result: Message[] = messages.map((msg, index) => {
    // Preserve recent messages
    if (index >= messages.length - preserveRecent) {
      return msg;
    }

    if (!Array.isArray(msg.content)) return msg;

    let hasImageBlock = false;
    for (const block of msg.content) {
      if (isImageBlock(block)) {
        hasImageBlock = true;
        break;
      }
    }

    if (!hasImageBlock) return msg;

    // Replace image blocks with text markers
    const newContent: ContentBlock[] = [];
    for (const block of msg.content) {
      if (isImageBlock(block)) {
        const altText = getAltText(block);
        const marker = altText
          ? `[imagen removida por compactacion: ${altText}]`
          : "[imagen removida por compactacion]";
        newContent.push({ type: "text", text: marker });
        strippedCount++;
        tokensRecovered += TOKENS_PER_IMAGE;
      } else {
        newContent.push(block);
      }
    }

    return { ...msg, content: newContent };
  });

  return { messages: result, strippedCount, tokensRecovered };
}

// ─── Helpers ────────────────────────────────────────────────────

/** Check if a content block is an image or document type. */
function isImageBlock(block: ContentBlock | Record<string, unknown>): boolean {
  const b = block as Record<string, unknown>;
  return b.type === "image" || b.type === "document";
}

/** Extract alt-text from an image block if present. */
function getAltText(block: ContentBlock | Record<string, unknown>): string | null {
  const b = block as Record<string, unknown>;
  if (typeof b.alt === "string" && b.alt.length > 0) return b.alt;
  if (typeof b.title === "string" && b.title.length > 0) return b.title;
  return null;
}
