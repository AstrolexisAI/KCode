// KCode - Continuation merge engine
// Centralizes dedup logic for truncated response continuations.
// Uses line-level, paragraph-level, and char-level matching.

export interface MergeResult {
  merged: string;
  strippedChars: number;
  strippedLines: number;
  repeatedPrefixDetected: boolean;
}

/**
 * Merge a continuation with the previous response text, stripping
 * any duplicated content. Uses multiple strategies in order:
 *
 * 1. Heading restart detection (model restarted from a section header)
 * 2. Line-level overlap (continuation starts with lines from the tail)
 * 3. Paragraph-level overlap (repeated whole paragraphs)
 * 4. Char-level suffix/prefix overlap (classic dedup)
 * 5. Truncated fragment cleanup (incomplete words/sentences at junction)
 */
export function mergeContinuation(previousText: string, continuation: string): MergeResult {
  if (previousText.length === 0) {
    return { merged: continuation, strippedChars: 0, strippedLines: 0, repeatedPrefixDetected: false };
  }
  if (continuation.length === 0) {
    return { merged: "", strippedChars: 0, strippedLines: 0, repeatedPrefixDetected: false };
  }

  const origLen = continuation.length;
  let result = continuation;
  let repeatedPrefixDetected = false;

  // Strategy 1: Heading restart detection
  // If continuation starts with a markdown header that exists in the previous text,
  // the model restarted from that section — strip everything up to new content.
  const headingMatch = result.match(/^(#{1,4}\s+.+)/m);
  if (headingMatch) {
    const heading = headingMatch[1]!.trim();
    if (heading.length >= 8 && previousText.includes(heading)) {
      repeatedPrefixDetected = true;
      // Find where the previous text's version of this section ends
      const prevLines = previousText.split("\n");
      const headingIdx = prevLines.findIndex(l => l.trim() === heading);
      if (headingIdx >= 0) {
        // Strip from continuation: everything from the repeated heading
        // until we find content not in the previous text
        const contLines = result.split("\n");
        const headingContIdx = contLines.findIndex(l => l.trim() === heading);
        if (headingContIdx >= 0) {
          // Find first line in continuation that's genuinely new
          let newContentStart = headingContIdx;
          for (let i = headingContIdx; i < contLines.length; i++) {
            const line = contLines[i]!.trim();
            if (line.length < 5) continue;
            if (!previousText.includes(line)) {
              newContentStart = i;
              break;
            }
            newContentStart = i + 1;
          }
          result = contLines.slice(newContentStart).join("\n").trim();
        }
      }
    }
  }

  // Strategy 2: Line-level overlap
  // Count consecutive matching lines from the overlap point
  if (result.length > 0) {
    const tailLines = previousText.split("\n").slice(-15);
    const newLines = result.split("\n");
    for (let i = 0; i < Math.min(newLines.length, 10); i++) {
      const line = newLines[i]!.trim();
      if (line.length < 10) continue;
      const tailIdx = tailLines.findIndex(tl => tl.trim() === line);
      if (tailIdx >= 0) {
        // Count how many consecutive lines actually match
        let matchCount = 0;
        for (let j = 0; j < newLines.length - i && tailIdx + j < tailLines.length; j++) {
          const tl = tailLines[tailIdx + j]?.trim() ?? "";
          const nl = newLines[i + j]?.trim() ?? "";
          if (tl === nl || (tl.length === 0 && nl.length === 0)) {
            matchCount++;
          } else {
            break;
          }
        }
        if (matchCount >= 1) {
          result = newLines.slice(i + matchCount).join("\n").trim();
          break;
        }
      }
    }
  }

  // Strategy 3: Paragraph overlap
  // If the continuation starts with a paragraph that appears near the end of previous text
  if (result.length > 0) {
    const contParagraphs = result.split(/\n\n+/);
    if (contParagraphs.length >= 2) {
      const firstPara = contParagraphs[0]!.trim();
      // Only strip if the paragraph is in the LAST portion of previous text
      const prevTail = previousText.slice(-Math.max(500, firstPara.length * 2));
      if (firstPara.length >= 20 && prevTail.includes(firstPara)) {
        result = contParagraphs.slice(1).join("\n\n").trim();
      }
    }
  }

  // Strategy 4: Char-level suffix/prefix overlap
  if (result.length > 0) {
    const tailToMatch = previousText.slice(-200);
    for (let overlapLen = Math.min(tailToMatch.length, result.length); overlapLen >= 20; overlapLen--) {
      if (result.startsWith(tailToMatch.slice(-overlapLen))) {
        result = result.slice(overlapLen);
        break;
      }
    }
  }

  // Strategy 5: Clean up truncated fragments at junction
  // If result starts with a partial word (no space or punctuation before first word)
  if (result.length > 0 && /^[a-záéíóúñ]/i.test(result) && previousText.length > 0) {
    const lastChar = previousText[previousText.length - 1];
    if (lastChar && /[a-záéíóúñ]/i.test(lastChar)) {
      // Previous text ended mid-word, continuation starts mid-word
      // Find the first space/newline and strip the fragment
      const spaceIdx = result.search(/[\s\n]/);
      if (spaceIdx > 0 && spaceIdx < 30) {
        result = result.slice(spaceIdx).trimStart();
      }
    }
  }

  const strippedChars = origLen - result.length;
  const strippedLines = continuation.split("\n").length - result.split("\n").length;

  return {
    merged: result,
    strippedChars: Math.max(0, strippedChars),
    strippedLines: Math.max(0, strippedLines),
    repeatedPrefixDetected,
  };
}

/**
 * Check if text ends in a way that looks like a truncated question
 * or confirmation prompt (e.g., "¿Deseas proceder con est").
 * These should be suppressed from final output.
 */
export function isTruncatedQuestion(text: string): boolean {
  const trimmed = text.trimEnd();
  const lastLine = trimmed.split("\n").pop() ?? "";
  // Open Spanish question mark without closing
  if (/¿[^?]+$/.test(lastLine)) return true;
  // Confirmation/question words followed by truncated text (no terminal punctuation)
  if (/\b(proceder|proceed|deseas|desea|want to|would you|shall I|shall we)\b.{0,30}$/i.test(lastLine) && !/[.!?]$/.test(lastLine)) return true;
  return false;
}
