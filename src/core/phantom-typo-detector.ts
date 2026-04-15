// Phase 32 — semantic phantom-typo detector
//
// Phase 31 caught the easy case: Edit with old_string === new_string
// byte-identical. This module catches the harder case where the
// assistant's own prose declares a fix like "X en lugar de X" /
// "X instead of X" — where both halves name the same identifier,
// meaning the "bug" is a hallucination even if the subsequent Edit's
// old/new strings happen to differ byte-wise.
//
// Canonical trigger: NEXUS Telemetry mark6 session. The model's
// text said "setProperty en lugar de setProperty", "getContext en
// lugar de getContext", "reverse en lugar de reverse" — literally
// X in place of X, the same identifier. Phase 31 caught the no-op
// Edit that followed, but if the model had constructed an Edit with
// slightly-different-but-still-wrong old/new (e.g. "setProperty;"
// vs "setProperty;  " with trailing whitespace), phase 31 would
// miss it. Phase 32 catches it at the prose level.
//
// Design goals:
//   - Zero false positives on legitimate text ("use X instead of Y").
//   - Catch both Spanish and English phrasings.
//   - Robust to punctuation around the tokens: quotes, backticks,
//     parens, periods, commas.
//   - Return the offending phrase for error reporting.

// Patterns that introduce a "replacement" claim. Each must capture
// the LEFT identifier in group 1 and the RIGHT identifier in group 2.
// \S+ captures any non-whitespace run so identifiers with dots and
// parens (Math.PI, setProperty()) work.
const PHANTOM_PATTERNS: RegExp[] = [
  // Spanish — "X en lugar de X", "X en vez de X", "X en sustitución de X"
  /(\S+)\s+(?:en\s+lugar\s+de|en\s+vez\s+de|en\s+sustituci[oó]n\s+de)\s+(\S+)/gi,
  // English — "X instead of X", "X rather than X", "X in place of X"
  /(\S+)\s+(?:instead\s+of|rather\s+than|in\s+place\s+of|in\s+lieu\s+of)\s+(\S+)/gi,
];

// Strip decorative/boundary punctuation from a token so
// "`setProperty`," and "setProperty" compare equal.
function stripBoundaryPunct(s: string): string {
  return s
    .replace(/^[\s`'".,;:()\[\]{}!?<>]+/, "")
    .replace(/[\s`'".,;:()\[\]{}!?<>]+$/, "");
}

export interface PhantomTypoMatch {
  /** The full offending phrase, e.g. "setProperty en lugar de setProperty". */
  phrase: string;
  /** The repeated identifier, e.g. "setProperty". */
  token: string;
}

/**
 * Scan free-form assistant text for phantom-typo claims. Returns the
 * first match or null.
 *
 * A phantom-typo claim is defined as a phrase of the form
 *   "X <replacement-marker> Y"
 * where X and Y, after stripping boundary punctuation, are byte-
 * identical and at least 2 characters long. Very short tokens are
 * rejected to avoid false-positive hits on 1-char identifiers.
 */
export function detectPhantomTypoClaim(text: string): PhantomTypoMatch | null {
  if (!text || text.length < 10) return null;

  for (const pat of PHANTOM_PATTERNS) {
    // Reset lastIndex since the regex has /g flag
    pat.lastIndex = 0;
    for (const match of text.matchAll(pat)) {
      const leftRaw = match[1] ?? "";
      const rightRaw = match[2] ?? "";
      const left = stripBoundaryPunct(leftRaw);
      const right = stripBoundaryPunct(rightRaw);
      if (!left || !right) continue;
      if (left.length < 2) continue; // too short to be meaningful
      if (left === right) {
        return {
          phrase: match[0],
          token: left,
        };
      }
    }
  }
  return null;
}
