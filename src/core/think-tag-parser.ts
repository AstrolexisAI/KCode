// KCode - Think Tag Parser
// Stateful streaming parser that extracts <think>/<reasoning> blocks from content deltas.
// Used by SSE parsers to separate model thinking from visible output.

export interface ThinkTagEvent {
  type: "thinking" | "content";
  text: string;
}

const OPEN_TAGS = ["<think>", "<thinking>", "<reasoning>"];
const CLOSE_MAP: Record<string, string> = {
  "<think>": "</think>",
  "<thinking>": "</thinking>",
  "<reasoning>": "</reasoning>",
};
const MAX_TAG_LEN = 12; // length of "</reasoning>"

/**
 * Stateful parser that splits a stream of content deltas into thinking and content events.
 * Handles partial tags that span across multiple deltas.
 *
 * Usage:
 *   const parser = createThinkTagParser();
 *   for (const delta of deltas) {
 *     for (const event of parser.feed(delta)) { ... }
 *   }
 *   for (const event of parser.flush()) { ... }
 */
export function createThinkTagParser() {
  let buf = "";
  let inside = false;
  let closeTag = "";

  function* feed(text: string): Generator<ThinkTagEvent> {
    buf += text;

    while (buf.length > 0) {
      if (inside) {
        // Inside thinking block: look for close tag
        const closeIdx = buf.indexOf(closeTag);
        if (closeIdx !== -1) {
          const thinkText = buf.slice(0, closeIdx);
          if (thinkText) yield { type: "thinking", text: thinkText };
          buf = buf.slice(closeIdx + closeTag.length);
          inside = false;
          closeTag = "";
        } else if (buf.length > MAX_TAG_LEN) {
          // Flush safe portion, keep tail for potential partial close tag
          const safe = buf.slice(0, -MAX_TAG_LEN);
          if (safe) yield { type: "thinking", text: safe };
          buf = buf.slice(-MAX_TAG_LEN);
          break;
        } else {
          break; // wait for more data
        }
      } else {
        // Outside: look for any open tag
        let bestIdx = -1;
        let bestTag = "";
        for (const tag of OPEN_TAGS) {
          const idx = buf.indexOf(tag);
          if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
            bestIdx = idx;
            bestTag = tag;
          }
        }
        if (bestIdx !== -1) {
          const beforeText = buf.slice(0, bestIdx);
          if (beforeText) yield { type: "content", text: beforeText };
          buf = buf.slice(bestIdx + bestTag.length);
          inside = true;
          closeTag = CLOSE_MAP[bestTag]!;
        } else if (buf.length > MAX_TAG_LEN) {
          const safe = buf.slice(0, -MAX_TAG_LEN);
          if (safe) yield { type: "content", text: safe };
          buf = buf.slice(-MAX_TAG_LEN);
          break;
        } else {
          break; // wait for more data
        }
      }
    }
  }

  /** Flush remaining buffer at end of stream. */
  function* flush(): Generator<ThinkTagEvent> {
    if (buf.length > 0) {
      yield { type: inside ? "thinking" : "content", text: buf };
      buf = "";
    }
    inside = false;
    closeTag = "";
  }

  /** Reset parser state. */
  function reset(): void {
    buf = "";
    inside = false;
    closeTag = "";
  }

  return { feed, flush, reset };
}
