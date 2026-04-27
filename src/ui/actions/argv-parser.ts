// KCode - shell-quote-aware argv parser for /scan, /review, /fix
// (CL.4, v2.10.374).
//
// Replaces the `args.split(/\s+/)` hack the TUI subcommand handlers
// used. That split broke any path with spaces and forced reviewers
// to write notes without quotes (or accept that everything past the
// first space got dropped). This parser handles the common shell
// quoting rules with no external dependency.
//
// Supported:
//   word                — bare token, ends at the next whitespace
//   "double quoted"     — preserves spaces; escapes \" and \\
//   'single quoted'     — preserves spaces literally; no escapes
//   word"more"          — concatenated, treated as one token
//   trailing whitespace — collapsed
//
// Not supported (deliberately — would only be footguns):
//   `command substitution` — no
//   $variable expansion   — no
//   <(redirect) >(redirect) — no
//   shell glob expansion  — no
//   line continuations \\ — no
//
// If the user wants exactly one of those, they pass it as a single
// quoted string and the consumer parses what's inside. We are NOT
// trying to be a shell — we're trying to be a tokenizer.

/**
 * Parse a single line into argv tokens. Returns the parsed tokens.
 * Throws RangeError on unterminated quotes so callers can surface
 * a helpful "missing closing quote" message instead of silently
 * dropping the rest of the line.
 */
export function parseArgv(input: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let isEscaped = false;
  let hasContent = false; // distinguishes empty input from `""` token

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (isEscaped) {
      // Backslash inside double-quotes escapes the next char.
      // Outside quotes a backslash before whitespace also makes the
      // whitespace literal. We don't try to model bash's "in this
      // shell only these escape" rules — keep it minimal.
      buf += ch;
      isEscaped = false;
      hasContent = true;
      continue;
    }

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        buf += ch;
        hasContent = true;
      }
      continue;
    }

    if (inDouble) {
      if (ch === "\\") {
        isEscaped = true;
      } else if (ch === '"') {
        inDouble = false;
      } else {
        buf += ch;
        hasContent = true;
      }
      continue;
    }

    // Unquoted state.
    if (ch === "'") {
      inSingle = true;
      hasContent = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasContent = true;
      continue;
    }
    if (ch === "\\") {
      isEscaped = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasContent) {
        out.push(buf);
        buf = "";
        hasContent = false;
      }
      continue;
    }

    buf += ch;
    hasContent = true;
  }

  if (inSingle || inDouble) {
    throw new RangeError(
      `Unterminated ${inSingle ? "single" : "double"}-quoted string. Add a closing ${inSingle ? "'" : '"'}.`,
    );
  }
  if (isEscaped) {
    // Trailing backslash with nothing to escape — treat literally.
    buf += "\\";
    hasContent = true;
  }
  if (hasContent) out.push(buf);

  return out;
}

/**
 * Wrapper that accepts a (possibly null/undefined) string and
 * returns a tokens array. Empty input → []. Used by every subcommand
 * handler in file-actions-audit.ts to replace the legacy
 * `(args ?? "").trim().split(/\s+/).filter(Boolean)`.
 */
export function tokenize(args: string | null | undefined): string[] {
  if (!args) return [];
  return parseArgv(args.trim());
}
