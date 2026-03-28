// KCode - Stdin paste interceptor
// Detects multiline paste at the stdin byte level, BEFORE Ink processes
// the data. Paste content is captured atomically and delivered via callback.
//
// Detection methods (belt-and-suspenders):
// 1. Bracketed paste sequences (\x1b[200~ ... \x1b[201~) — deterministic
// 2. Byte heuristic: a single stdin `data` event with both printable
//    characters AND newlines is a multiline paste. Single keystrokes
//    never produce this pattern.
//
// When a paste is detected, the `data` event is consumed (Ink never sees
// it), and the complete paste text is delivered via the onPaste callback.

type PasteCallback = (text: string) => void;

/**
 * Install a paste interceptor on process.stdin.
 *
 * Monkey-patches `process.stdin.emit` to detect paste content before
 * Ink's input handler sees it. Returns a cleanup function.
 *
 * @param onPaste Called with the complete paste text (newlines normalized to \n)
 */
export function installPasteInterceptor(onPaste: PasteCallback): () => void {
  const originalEmit = process.stdin.emit.bind(process.stdin);

  // Enable bracketed paste mode (terminal will wrap pastes in escape sequences)
  process.stdout.write("\x1b[?2004h");

  // Track bracketed paste state across data events (paste may span multiple chunks)
  let inBracketedPaste = false;
  let bracketBuffer = "";

  (process.stdin as any).emit = function (event: string, ...args: any[]): boolean {
    if (event !== "data") {
      return originalEmit(event, ...args);
    }

    const chunk = args[0] as Buffer;
    const str = chunk.toString("utf-8");

    // ── Bracketed paste: deterministic detection ──────────────
    if (str.includes("\x1b[200~") || inBracketedPaste) {
      let data = str;

      if (!inBracketedPaste) {
        // Start of bracketed paste — strip start sequence
        const startIdx = data.indexOf("\x1b[200~");
        // Pass through anything before the start bracket
        const before = data.slice(0, startIdx);
        if (before.length > 0) {
          originalEmit("data", Buffer.from(before, "utf-8"));
        }
        data = data.slice(startIdx + 6); // "\x1b[200~".length = 6
        inBracketedPaste = true;
        bracketBuffer = "";
      }

      const endIdx = data.indexOf("\x1b[201~");
      if (endIdx !== -1) {
        // End of bracketed paste — deliver content
        bracketBuffer += data.slice(0, endIdx);
        inBracketedPaste = false;
        const normalized = bracketBuffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        onPaste(normalized);
        bracketBuffer = "";

        // Pass through anything after the end bracket
        const after = data.slice(endIdx + 6);
        if (after.length > 0) {
          originalEmit("data", Buffer.from(after, "utf-8"));
        }
      } else {
        // Middle of bracketed paste — accumulate
        bracketBuffer += data;
      }

      return true;
    }

    // ── Byte heuristic: fallback for terminals without bracketed paste ──
    // A single stdin data event with both printable content AND newlines
    // is a multiline paste. Single keystrokes never produce this pattern:
    // - Enter key sends just \r (1 byte, no printable chars)
    // - Regular key sends 1-8 bytes (no newlines)
    const hasNewline = str.includes("\n") || str.includes("\r");
    const printableContent = str.replace(/[\r\n\x1b]/g, "");
    if (hasNewline && printableContent.length > 0) {
      const normalized = str.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      onPaste(normalized);
      return true;
    }

    // ── Normal input — let Ink handle it ─────────────────────
    return originalEmit(event, ...args);
  };

  return () => {
    // Restore original emit
    (process.stdin as any).emit = originalEmit;
    // Disable bracketed paste mode
    process.stdout.write("\x1b[?2004l");
  };
}
