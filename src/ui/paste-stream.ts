// KCode - Stdin paste interceptor
// Detects multiline paste at the stdin byte level, BEFORE Ink processes it.
//
// Detection methods:
// 1. Bracketed paste sequences — with or without \x1b prefix (Bun may
//    consume the escape char before our handler sees it)
// 2. Byte heuristic: a single stdin data event with both printable
//    characters AND newlines is a multiline paste

type PasteCallback = (text: string) => void;

// Bracketed paste sequences — detect with and without \x1b prefix
const PASTE_STARTS = ["\x1b[200~", "[200~"];
const PASTE_ENDS = ["\x1b[201~", "[201~"];

function findSequence(str: string, sequences: string[]): { index: number; length: number } | null {
  for (const seq of sequences) {
    const idx = str.indexOf(seq);
    if (idx !== -1) return { index: idx, length: seq.length };
  }
  return null;
}

export function installPasteInterceptor(onPaste: PasteCallback): () => void {
  const originalEmit = process.stdin.emit.bind(process.stdin);

  // Enable bracketed paste mode
  process.stdout.write("\x1b[?2004h");

  let inBracketedPaste = false;
  let bracketBuffer = "";

  const safePaste = (text: string) => {
    try { onPaste(text); } catch { /* don't break stdin */ }
  };

  (process.stdin as any).emit = function (event: string, ...args: any[]): boolean {
    if (event !== "data") {
      return originalEmit(event, ...args);
    }

    const raw = args[0];
    const str = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");

    // ── Continue buffering if inside a bracketed paste ────────
    if (inBracketedPaste) {
      const end = findSequence(str, PASTE_ENDS);
      if (end) {
        bracketBuffer += str.slice(0, end.index);
        inBracketedPaste = false;
        const normalized = bracketBuffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        safePaste(normalized);
        bracketBuffer = "";
        // Pass through anything after the end bracket
        const after = str.slice(end.index + end.length);
        if (after.length > 0) {
          return originalEmit("data", Buffer.from(after, "utf-8"));
        }
      } else {
        bracketBuffer += str;
      }
      return true;
    }

    // ── Detect bracketed paste start ─────────────────────────
    const start = findSequence(str, PASTE_STARTS);
    if (start) {
      // Pass through anything before the start bracket
      const before = str.slice(0, start.index);
      if (before.length > 0) {
        originalEmit("data", Buffer.from(before, "utf-8"));
      }

      const afterStart = str.slice(start.index + start.length);

      // Check if end bracket is in the same chunk
      const end = findSequence(afterStart, PASTE_ENDS);
      if (end) {
        // Complete paste in one chunk
        const content = afterStart.slice(0, end.index);
        const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        safePaste(normalized);
        // Pass through anything after the end bracket
        const after = afterStart.slice(end.index + end.length);
        if (after.length > 0) {
          return originalEmit("data", Buffer.from(after, "utf-8"));
        }
      } else {
        // Paste spans multiple chunks
        inBracketedPaste = true;
        bracketBuffer = afterStart;
      }
      return true;
    }

    // ── Byte heuristic: detect multiline paste without brackets ──
    const hasNewline = str.includes("\n") || str.includes("\r");
    const printable = str.replace(/[\r\n\x1b\x00-\x1f]/g, "");
    if (hasNewline && printable.length > 0) {
      const normalized = str.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      safePaste(normalized);
      return true;
    }

    // ── Normal input — let Ink handle it ─────────────────────
    return originalEmit(event, ...args);
  };

  return () => {
    (process.stdin as any).emit = originalEmit;
    process.stdout.write("\x1b[?2004l");
  };
}
