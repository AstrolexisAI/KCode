// KCode - Phase 27: Edit location mismatch warning
//
// Non-blocking proactive warning that fires when an Edit's target
// line is far from where the user's recent messages said the bug
// lives. Catches the Orbital chart-fix failure mode: the user
// says "la gráfica" or "Mars Surface Temperature chart" and the
// model edits random CSS 500 lines away from the real code.
//
// Design principles:
//   - Non-blocking. Edits still apply. Warning is appended to the
//     success message so the model sees it and can course-correct
//     on the next turn (or the user can redirect).
//   - Cheap. Regex + indexOf, no LLM calls.
//   - Quiet when uncertain. If the user didn't mention any specific
//     location, the detector returns null.
//   - Lenient thresholds. Default ±50-line window, ±30-line window
//     for symbol proximity. False positives are cheap; false
//     negatives (missing a real mismatch) cost tokens.

import { basename } from "node:path";

// ─── Location hint extraction ────────────────────────────────────

export interface LocationHint {
  /** "line" for explicit line numbers, "range" for N-M, "symbol" for function/class/component names. */
  kind: "line" | "range" | "symbol";
  /** The line number or function/class name. */
  value: string;
  /** For ranges, the end line. */
  endValue?: string;
  /** The original phrase that matched, for the warning report. */
  phrase: string;
  /** Which user message this hint came from (newest = last). */
  messageIndex: number;
}

export interface LocationHints {
  lineHints: LocationHint[];
  symbolHints: LocationHint[];
  /** File paths mentioned (e.g., "orbital.html", "server.js"). */
  fileHints: string[];
}

// Regexes for location mentions in user prose. LINE_RANGE_REGEX
// already matches "line 800" via the `lines?` group — LINE_AT_REGEX
// only exists to help English "at line 42" phrasing survive, but it
// overlaps with LINE_RANGE on the same position. We dedupe line hints
// by numeric value + messageIndex to avoid double-counting.
const LINE_RANGE_REGEX = /\blines?\s+(\d{1,5})\s*(?:[-–—]\s*(\d{1,5}))?\b/gi;
const LINE_AT_REGEX = /\bat\s+line\s+(\d{1,5})\b/gi;
const SPANISH_LINE_REGEX = /\bl[ií]nea\s+(\d{1,5})\b/gi;
// function foo / def bar / fn baz / const quux
const SYMBOL_REGEX =
  /\b(?:function|def|fn|class|const|let|var|method|component|m[oó]dulo|module)\s+([A-Za-z_$][A-Za-z0-9_$]{2,})/g;
// Backtick-quoted or double-quoted identifiers: `renderMarsGallery` / "Dashboard"
const QUOTED_ID_REGEX = /[`"']([A-Za-z_$][A-Za-z0-9_$]{4,})[`"']/g;
// Bare long camelCase/PascalCase identifiers (≥14 chars). Catches
// things like `updateMarsChartWithRealData is broken` where the
// user didn't quote or prefix the name. 14+ chars avoids matching
// ordinary English / Spanish words.
const BARE_LONG_IDENT_REGEX =
  /\b([a-z][a-zA-Z0-9_$]*[A-Z][a-zA-Z0-9_$]*|[A-Z][a-zA-Z0-9_$]*[A-Z][a-zA-Z0-9_$]*)\b/g;
// File mentions with extensions: orbital.html, server.js, app.tsx
const FILE_REGEX =
  /\b([A-Za-z0-9_\-.]+\.(?:html|htm|js|jsx|ts|tsx|mjs|cjs|py|rs|go|java|rb|php|cs|swift|kt|scala|vue|svelte|astro|md|json|yml|yaml|toml|css|scss|sass|less))\b/g;

/**
 * Noise-filter: identifiers that are too generic to be useful
 * location hints. If the user says "fix the component" we can't
 * narrow the Edit location from that.
 */
const GENERIC_IDENTIFIERS = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "console",
  "window",
  "document",
  "event",
  "props",
  "state",
  "value",
  "element",
  "target",
  "result",
  "data",
  "error",
  "response",
  "request",
  "item",
  "index",
  "this",
  "self",
  "args",
  "params",
  "options",
  "config",
  "callback",
  "handler",
  "function",
  "class",
  "module",
  "Component",
  "Element",
  "File",
  "Directory",
]);

/**
 * Extract location hints from the last N user messages. Looks for
 * explicit line numbers, ranges, symbol names, and file paths.
 */
export function extractLocationHints(
  userTexts: readonly string[],
  lookback = 3,
): LocationHints {
  const window = userTexts.slice(-lookback);
  const lineHints: LocationHint[] = [];
  const symbolHints: LocationHint[] = [];
  const fileHints = new Set<string>();

  // Dedupe by "${value}@${messageIndex}" so two overlapping regexes
  // matching the same position don't create duplicate hints.
  const seenLineKey = new Set<string>();
  const seenSymbolKey = new Set<string>();
  const pushLine = (h: LocationHint) => {
    const k = `${h.value}@${h.messageIndex}`;
    if (seenLineKey.has(k)) return;
    seenLineKey.add(k);
    lineHints.push(h);
  };
  const pushSymbol = (h: LocationHint) => {
    const k = `${h.value}@${h.messageIndex}`;
    if (seenSymbolKey.has(k)) return;
    seenSymbolKey.add(k);
    symbolHints.push(h);
  };

  for (let idx = 0; idx < window.length; idx++) {
    const text = window[idx];
    if (!text) continue;

    // Line numbers (English: "line 800", "lines 100-120", "at line 42")
    LINE_RANGE_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINE_RANGE_REGEX.exec(text)) !== null) {
      const kind = m[2] ? "range" : "line";
      pushLine({
        kind,
        value: m[1]!,
        endValue: m[2],
        phrase: m[0],
        messageIndex: idx,
      });
    }

    LINE_AT_REGEX.lastIndex = 0;
    while ((m = LINE_AT_REGEX.exec(text)) !== null) {
      pushLine({
        kind: "line",
        value: m[1]!,
        phrase: m[0],
        messageIndex: idx,
      });
    }

    // Spanish línea
    SPANISH_LINE_REGEX.lastIndex = 0;
    while ((m = SPANISH_LINE_REGEX.exec(text)) !== null) {
      pushLine({
        kind: "line",
        value: m[1]!,
        phrase: m[0],
        messageIndex: idx,
      });
    }

    // Symbol names introduced by function/class/etc
    SYMBOL_REGEX.lastIndex = 0;
    while ((m = SYMBOL_REGEX.exec(text)) !== null) {
      const name = m[1]!;
      if (GENERIC_IDENTIFIERS.has(name)) continue;
      pushSymbol({
        kind: "symbol",
        value: name,
        phrase: m[0],
        messageIndex: idx,
      });
    }

    // Backtick / quoted identifiers
    QUOTED_ID_REGEX.lastIndex = 0;
    while ((m = QUOTED_ID_REGEX.exec(text)) !== null) {
      const name = m[1]!;
      if (GENERIC_IDENTIFIERS.has(name)) continue;
      if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) continue;
      pushSymbol({
        kind: "symbol",
        value: name,
        phrase: `"${name}"`,
        messageIndex: idx,
      });
    }

    // Bare long camelCase/PascalCase identifiers (≥14 chars): catches
    // the "updateMarsChartWithRealData is broken" case where the user
    // drops a function name in prose without quoting it.
    BARE_LONG_IDENT_REGEX.lastIndex = 0;
    while ((m = BARE_LONG_IDENT_REGEX.exec(text)) !== null) {
      const name = m[1]!;
      if (name.length < 14) continue;
      if (GENERIC_IDENTIFIERS.has(name)) continue;
      pushSymbol({
        kind: "symbol",
        value: name,
        phrase: name,
        messageIndex: idx,
      });
    }

    // File paths
    FILE_REGEX.lastIndex = 0;
    while ((m = FILE_REGEX.exec(text)) !== null) {
      fileHints.add(m[1]!);
    }
  }

  return {
    lineHints,
    symbolHints,
    fileHints: Array.from(fileHints),
  };
}

// ─── Mismatch detection ──────────────────────────────────────────

export interface LocationMismatchVerdict {
  isMismatch: boolean;
  /** The edit line. */
  editLine: number;
  /** Line hints the edit is far from. */
  unmatchedLineHints: LocationHint[];
  /** Symbol hints whose position (if found) is far from the edit. */
  unmatchedSymbolHints: Array<LocationHint & { symbolLine: number }>;
  /** File hints that don't match the target file path. */
  fileMismatch: string | null;
  /** Human-friendly summary of the mismatch for the warning. */
  reason: string;
}

const LINE_PROXIMITY_WINDOW = 50;
const SYMBOL_PROXIMITY_WINDOW = 30;

/**
 * Find the 1-based line number of the first occurrence of a symbol
 * in the file content. Returns -1 if the symbol isn't found.
 *
 * Uses a word-boundary match so `render` doesn't match `renderingHat`.
 */
export function findSymbolLine(fileContent: string, symbol: string): number {
  // Escape regex metacharacters
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`);
  const m = fileContent.match(re);
  if (!m || m.index === undefined) return -1;
  return fileContent.slice(0, m.index).split("\n").length;
}

/**
 * Decide whether the Edit's target line is far from anywhere the
 * user's recent messages pointed at. Returns isMismatch=false when
 * there are no usable hints (no warning is better than a noisy one).
 */
export function checkEditLocationMismatch(
  hints: LocationHints,
  editLine: number,
  filePath: string,
  fileContent: string,
): LocationMismatchVerdict {
  const fileBase = basename(filePath);

  // File-level mismatch: did the user mention a different file?
  let fileMismatch: string | null = null;
  if (hints.fileHints.length > 0) {
    const exactHit = hints.fileHints.some(
      (f) => basename(f) === fileBase,
    );
    if (!exactHit) {
      // Only report if there's exactly one file hint — ambiguous
      // cases (user mentioned 3 files, model picked one) are fine
      if (hints.fileHints.length === 1) {
        fileMismatch = hints.fileHints[0]!;
      }
    }
  }

  // Partition line hints into "near" vs "far" from the edit. If ANY
  // line hint is near the edit, the user's intent is satisfied — we
  // don't warn. Only emit a mismatch when every line hint is far.
  const unmatchedLineHints: LocationHint[] = [];
  let anyLineHintNear = false;
  for (const h of hints.lineHints) {
    const lineNum = parseInt(h.value, 10);
    if (Number.isNaN(lineNum)) continue;
    const endNum = h.endValue ? parseInt(h.endValue, 10) : lineNum;
    const distance = Math.min(
      Math.abs(editLine - lineNum),
      Math.abs(editLine - endNum),
    );
    if (distance <= LINE_PROXIMITY_WINDOW) {
      anyLineHintNear = true;
    } else {
      unmatchedLineHints.push(h);
    }
  }

  // Same logic for symbols: if any mentioned symbol exists in the
  // file AND is near the edit, we're probably on target.
  const unmatchedSymbolHints: Array<LocationHint & { symbolLine: number }> = [];
  let anySymbolNear = false;
  let anySymbolFoundInFile = false;
  for (const h of hints.symbolHints) {
    const symbolLine = findSymbolLine(fileContent, h.value);
    if (symbolLine === -1) continue; // symbol not in this file — ignore
    anySymbolFoundInFile = true;
    if (Math.abs(editLine - symbolLine) <= SYMBOL_PROXIMITY_WINDOW) {
      anySymbolNear = true;
    } else {
      unmatchedSymbolHints.push({ ...h, symbolLine });
    }
  }

  // Compute mismatch: fire ONLY if no hint category was satisfied.
  // File mismatch still fires unconditionally when applicable.
  const lineMismatch =
    hints.lineHints.length > 0 && !anyLineHintNear && unmatchedLineHints.length > 0;
  const symbolMismatch =
    anySymbolFoundInFile && !anySymbolNear && unmatchedSymbolHints.length > 0;
  const isMismatch = fileMismatch !== null || lineMismatch || symbolMismatch;

  let reason = "";
  if (fileMismatch) {
    reason = `User mentioned "${fileMismatch}" but Edit targets "${fileBase}".`;
  } else if (unmatchedLineHints.length > 0) {
    const first = unmatchedLineHints[0]!;
    const distance = Math.abs(editLine - parseInt(first.value, 10));
    reason = `User said "${first.phrase}" but Edit is ~${distance} lines away (at line ${editLine}).`;
  } else if (unmatchedSymbolHints.length > 0) {
    const first = unmatchedSymbolHints[0]!;
    const distance = Math.abs(editLine - first.symbolLine);
    reason = `User mentioned "${first.value}" (at line ${first.symbolLine}) but Edit is ~${distance} lines away (at line ${editLine}).`;
  }

  return {
    isMismatch,
    editLine,
    unmatchedLineHints,
    unmatchedSymbolHints,
    fileMismatch,
    reason,
  };
}

// ─── Warning formatter ───────────────────────────────────────────

export function buildLocationWarning(verdict: LocationMismatchVerdict): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`⚠️  EDIT LOCATION MISMATCH (non-blocking warning)`);
  lines.push(`   ${verdict.reason}`);

  if (verdict.unmatchedLineHints.length > 1) {
    lines.push(
      `   Additional line hints not near this edit: ${verdict.unmatchedLineHints
        .slice(1, 4)
        .map((h) => `"${h.phrase}"`)
        .join(", ")}`,
    );
  }
  if (verdict.unmatchedSymbolHints.length > 1) {
    lines.push(
      `   Additional symbols not near this edit: ${verdict.unmatchedSymbolHints
        .slice(1, 4)
        .map((h) => `${h.value}@${h.symbolLine}`)
        .join(", ")}`,
    );
  }
  lines.push("");
  lines.push(
    `   The Edit succeeded, but the target region doesn't match where`,
  );
  lines.push(
    `   the user's recent messages pointed. If this Edit doesn't actually`,
  );
  lines.push(
    `   fix the reported issue, re-read the code region the user referenced`,
  );
  lines.push(
    `   before making another Edit. Do NOT claim "✅ fixed" on the next`,
  );
  lines.push(`   turn without verifying the user's actual bug is addressed.`);

  return lines.join("\n");
}
