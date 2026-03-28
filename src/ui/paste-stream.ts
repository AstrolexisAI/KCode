// KCode - Stdin paste interceptor
// Uses prependListener on stdin to detect and capture multiline paste
// BEFORE Ink processes the characters. A pasting flag tells useInput
// to ignore all character events while the paste is being captured.
//
// This approach doesn't try to prevent Ink from seeing the data
// (which failed with Bun's emit handling). Instead, it captures the
// paste content first, and the useInput handler skips processing.

/** Shared pasting state — checked by InputPrompt's useInput handler */
export let isPasting = false;

/** Reset pasting flag (called after paste characters have been processed) */
let pasteTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Install a paste interceptor using prependListener on stdin.
 *
 * The handler fires BEFORE Ink's data listeners, detects multiline paste
 * by content analysis, and calls onPaste with the clean text.
 * Sets isPasting=true so useInput can skip character events.
 *
 * @returns cleanup function
 */
export function installPasteInterceptor(onPaste: (text: string) => void): () => void {
  // Enable bracketed paste mode
  process.stdout.write("\x1b[?2004h");

  const handler = (chunk: Buffer | string) => {
    const str = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");

    // Strip bracketed paste sequences (with or without \x1b prefix)
    const cleaned = str
      .replace(/\x1b\[200~/g, "")
      .replace(/\x1b\[201~/g, "")
      .replace(/\[200~/g, "")
      .replace(/\[201~/g, "");

    if (cleaned.length === 0) {
      // Only bracket sequences — mark as pasting to suppress Ink
      isPasting = true;
      if (pasteTimer) clearTimeout(pasteTimer);
      pasteTimer = setTimeout(() => { isPasting = false; }, 100);
      return;
    }

    // Detect multiline paste: data chunk with both printable chars and newlines.
    // Single keystrokes in raw mode never produce this pattern:
    // - Enter sends just \r (no printable chars)
    // - Regular keys send 1-8 bytes (no newlines)
    const hasNewline = cleaned.includes("\n") || cleaned.includes("\r");
    const printable = cleaned.replace(/[\r\n\x1b\x00-\x1f]/g, "");

    if (hasNewline && printable.length > 0) {
      const normalized = cleaned.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      isPasting = true;
      if (pasteTimer) clearTimeout(pasteTimer);

      try { onPaste(normalized); } catch { /* don't break stdin */ }

      // Keep isPasting true long enough for Ink's handlers to be skipped.
      // All chars from this chunk will hit useInput in the same event loop
      // tick; the timer fires after they've all been ignored.
      pasteTimer = setTimeout(() => { isPasting = false; }, 100);
    }
  };

  process.stdin.prependListener("data", handler);

  return () => {
    process.stdin.removeListener("data", handler);
    if (pasteTimer) { clearTimeout(pasteTimer); pasteTimer = null; }
    isPasting = false;
    process.stdout.write("\x1b[?2004l");
  };
}
