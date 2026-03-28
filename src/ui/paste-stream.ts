// KCode - Bracketed paste stdin wrapper
// Intercepts bracketed paste sequences (\x1b[200~ ... \x1b[201~) from stdin
// and delivers the paste content as a single atomic data event, preventing
// Ink's useInput from breaking it into individual character/key events.
//
// Without this, pasted newlines are interpreted as key.return (submit),
// and Ink's escape sequence parser may corrupt the character stream.

import { Transform, type TransformCallback } from "node:stream";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * A Transform stream that detects bracketed paste mode sequences.
 *
 * Normal input passes through unchanged. When a paste bracket is detected,
 * all content is buffered until the end bracket, then emitted via the
 * 'bracketed-paste' event on the stream. The paste data is NOT passed
 * through to stdout/Ink — the consumer must handle it separately.
 */
export class PasteInterceptStream extends Transform {
  private pasteBuffer: string = "";
  private inPaste: boolean = false;
  private pending: string = "";

  // Ink requires these TTY/raw-mode properties on its stdin stream.
  // Proxy them from the real process.stdin so Ink can enable raw mode.
  get isTTY(): boolean { return !!(process.stdin as any).isTTY; }
  get isRaw(): boolean { return !!(process.stdin as any).isRaw; }
  setRawMode(mode: boolean): this {
    if (typeof (process.stdin as any).setRawMode === "function") {
      (process.stdin as any).setRawMode(mode);
    }
    return this;
  }

  override _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    let data = this.pending + chunk.toString("utf-8");
    this.pending = "";

    while (data.length > 0) {
      if (this.inPaste) {
        const endIdx = data.indexOf(PASTE_END);
        if (endIdx === -1) {
          // Partial paste end sequence at the tail?
          if (data.length < PASTE_END.length && PASTE_END.startsWith(data)) {
            this.pending = data;
            data = "";
          } else {
            // Check if the tail could be a partial match for PASTE_END
            let partialLen = Math.min(data.length, PASTE_END.length - 1);
            while (partialLen > 0) {
              if (PASTE_END.startsWith(data.slice(data.length - partialLen))) break;
              partialLen--;
            }
            if (partialLen > 0) {
              this.pasteBuffer += data.slice(0, data.length - partialLen);
              this.pending = data.slice(data.length - partialLen);
            } else {
              this.pasteBuffer += data;
            }
            data = "";
          }
        } else {
          // Found end bracket
          this.pasteBuffer += data.slice(0, endIdx);
          this.inPaste = false;
          this.emit("bracketed-paste", this.pasteBuffer);
          this.pasteBuffer = "";
          data = data.slice(endIdx + PASTE_END.length);
        }
      } else {
        const startIdx = data.indexOf(PASTE_START);
        if (startIdx === -1) {
          // Check for partial start sequence at the tail
          let partialLen = Math.min(data.length, PASTE_START.length - 1);
          while (partialLen > 0) {
            if (PASTE_START.startsWith(data.slice(data.length - partialLen))) break;
            partialLen--;
          }
          if (partialLen > 0) {
            this.push(Buffer.from(data.slice(0, data.length - partialLen), "utf-8"));
            this.pending = data.slice(data.length - partialLen);
          } else {
            this.push(Buffer.from(data, "utf-8"));
          }
          data = "";
        } else {
          // Found start bracket — pass through everything before it
          if (startIdx > 0) {
            this.push(Buffer.from(data.slice(0, startIdx), "utf-8"));
          }
          this.inPaste = true;
          this.pasteBuffer = "";
          data = data.slice(startIdx + PASTE_START.length);
        }
      }
    }

    callback();
  }

  override _flush(callback: TransformCallback): void {
    // Flush any remaining pending data
    if (this.pending.length > 0) {
      if (this.inPaste) {
        this.pasteBuffer += this.pending;
      } else {
        this.push(Buffer.from(this.pending, "utf-8"));
      }
      this.pending = "";
    }
    // If we're still in a paste (no end bracket), emit what we have
    if (this.inPaste && this.pasteBuffer.length > 0) {
      this.emit("bracketed-paste", this.pasteBuffer);
      this.pasteBuffer = "";
      this.inPaste = false;
    }
    callback();
  }
}

/**
 * Enable bracketed paste mode on the terminal and create an intercept stream.
 *
 * Returns the intercept stream (pipe process.stdin through it) and a cleanup
 * function that disables bracketed paste mode.
 *
 * Usage:
 *   const { stream, cleanup } = enableBracketedPaste();
 *   process.stdin.pipe(stream);
 *   stream.on('bracketed-paste', (text: string) => { ... });
 *   // Pass `stream` as Ink's stdin
 *   // On exit: cleanup();
 */
export function enableBracketedPaste(): {
  stream: PasteInterceptStream;
  cleanup: () => void;
} {
  // Enable bracketed paste mode
  process.stdout.write("\x1b[?2004h");

  const stream = new PasteInterceptStream();

  const cleanup = () => {
    // Disable bracketed paste mode
    process.stdout.write("\x1b[?2004l");
  };

  return { stream, cleanup };
}
