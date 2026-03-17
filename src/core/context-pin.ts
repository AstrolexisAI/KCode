// KCode - Context Pinning
// Pin files to always be included in the conversation context

import { readFileSync, existsSync } from "node:fs";
import { relative } from "node:path";
import { log } from "./logger";

// ─── In-memory pinned files ─────────────────────────────────────

const _pinnedFiles = new Map<string, string>(); // path → content snapshot
const MAX_PINNED_FILES = 10;
const MAX_PIN_SIZE = 8_000; // max chars per pinned file

/**
 * Pin a file to the context. Its content will be included in every LLM call.
 */
export function pinFile(filePath: string, cwd: string): { success: boolean; message: string } {
  if (_pinnedFiles.size >= MAX_PINNED_FILES) {
    return { success: false, message: `Cannot pin more than ${MAX_PINNED_FILES} files. Unpin one first.` };
  }

  if (!existsSync(filePath)) {
    return { success: false, message: `File not found: ${filePath}` };
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    if (content.length > MAX_PIN_SIZE) {
      return { success: false, message: `File too large to pin (${content.length} chars, max ${MAX_PIN_SIZE}). Pin a smaller file or a specific section.` };
    }

    _pinnedFiles.set(filePath, content);
    const rel = relative(cwd, filePath) || filePath;
    log.info("session", `Pinned file: ${rel}`);
    return { success: true, message: `Pinned: ${rel} (${content.length} chars)` };
  } catch (err) {
    return { success: false, message: `Error reading file: ${err instanceof Error ? err.message : err}` };
  }
}

/**
 * Unpin a file from the context.
 */
export function unpinFile(filePath: string, cwd: string): { success: boolean; message: string } {
  if (_pinnedFiles.delete(filePath)) {
    const rel = relative(cwd, filePath) || filePath;
    return { success: true, message: `Unpinned: ${rel}` };
  }
  return { success: false, message: `File not pinned: ${filePath}` };
}

/**
 * List all pinned files.
 */
export function listPinnedFiles(): Array<{ path: string; size: number }> {
  return Array.from(_pinnedFiles.entries()).map(([path, content]) => ({
    path,
    size: content.length,
  }));
}

/**
 * Refresh pinned file contents from disk (call before prompt build).
 */
export function refreshPinnedFiles(): void {
  for (const [path] of _pinnedFiles) {
    try {
      if (existsSync(path)) {
        _pinnedFiles.set(path, readFileSync(path, "utf-8").slice(0, MAX_PIN_SIZE));
      } else {
        _pinnedFiles.delete(path);
      }
    } catch {
      _pinnedFiles.delete(path);
    }
  }
}

/**
 * Format pinned files for injection into the system prompt.
 * Returns null if no files are pinned.
 */
export function formatPinnedForPrompt(cwd: string): string | null {
  if (_pinnedFiles.size === 0) return null;

  refreshPinnedFiles();

  const lines: string[] = ["# Pinned Files", "", "These files are pinned to the context by the user:"];

  for (const [path, content] of _pinnedFiles) {
    const rel = relative(cwd, path) || path;
    const ext = path.split(".").pop() ?? "";
    lines.push("");
    lines.push(`## ${rel}`);
    lines.push(`\`\`\`${ext}`);
    lines.push(content);
    lines.push("```");
  }

  return lines.join("\n");
}

/**
 * Clear all pinned files.
 */
export function clearPinnedFiles(): void {
  _pinnedFiles.clear();
}
