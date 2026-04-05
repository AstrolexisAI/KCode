// KCode - Semantic anti-pattern guards
//
// Catches a specific class of hallucinated "fixes" that LLMs often propose:
// inverting the semantics of C comparison functions (strcmp, wcscmp, memcmp, etc).
//
// The model confusion: strcmp returns 0 when strings MATCH, nonzero when they
// DIFFER. The idiom `if (strcmp(a, b))` means "if they differ" — standard C
// since the 1970s. LLMs frequently read this pattern, think "strcmp returns 0
// on match, so this is backwards", and propose adding `!`.
//
// This has been observed in KCode sessions against NASA IDF (v2.6.29, v2.6.35,
// v2.6.40) — the model consistently tries to invert working filter logic in
// UsbDevice.cpp. In v2.6.29 the edit was applied and corrupted NASA's code.
// In v2.6.40 the audit-session guard blocked it, but a user in a non-audit
// session could still approve the bad edit.
//
// This guard catches the inversion at Edit time, regardless of audit session.

/** The C comparison function family. All return 0 on match, nonzero on differ. */
const CMP_FAMILY_REGEX =
  /!\s*(?:str|wcs|strn|wcsn|mem|strcase|strncase|strcoll|wcscoll)cmp\s*\(/g;

/** Check if `on` toggle is explicitly off via env var. */
function semanticGuardsEnabled(): boolean {
  return process.env.KCODE_SEMANTIC_GUARDS !== "off";
}

/**
 * Detect when an edit is adding `!` before a strcmp-family call that wasn't
 * negated before. This inverts the semantic meaning from "if DIFFERENT" to
 * "if EQUAL" — almost always a hallucinated fix.
 *
 * Returns null if no dangerous inversion detected.
 * Returns error message string if the edit looks like an inversion.
 */
export function detectStrcmpInversion(oldStr: string, newStr: string): string | null {
  if (!semanticGuardsEnabled()) return null;

  // Reset global regex state and count occurrences in both strings
  CMP_FAMILY_REGEX.lastIndex = 0;
  const oldCount = (oldStr.match(CMP_FAMILY_REGEX) || []).length;
  CMP_FAMILY_REGEX.lastIndex = 0;
  const newCount = (newStr.match(CMP_FAMILY_REGEX) || []).length;

  if (newCount <= oldCount) {
    // Not adding any new `!cmp(...)` — safe
    return null;
  }

  const added = newCount - oldCount;

  // Check: did the old string compensate by having `cmp(...) == 0` that the
  // new string converted to `!cmp(...)`? That's a stylistic change, not an
  // inversion. Look for `(str|wcs|...)cmp\([^)]*\)\s*==\s*0` pattern in old.
  const cmpEqZeroRegex =
    /\b(?:str|wcs|strn|wcsn|mem|strcase|strncase|strcoll|wcscoll)cmp\s*\([^)]*\)\s*==\s*0/g;
  const oldEqZeroCount = (oldStr.match(cmpEqZeroRegex) || []).length;

  if (oldEqZeroCount >= added) {
    // The old string had at least `added` instances of `cmp(...) == 0` that
    // could have been converted to `!cmp(...)` — semantics preserved. Allow.
    return null;
  }

  // Also check for `cmp(...) != 0` in the new string — that would be
  // a legitimate "if differ" explicit form that replaced `!cmp(...)`.
  // If new has `!= 0` and old doesn't, that's a different kind of change.

  // This IS a likely inversion. Build a clear error message.
  return (
    `SEMANTIC INVERSION DETECTED: this edit adds '!' before ${added} strcmp/wcscmp/memcmp ` +
    `call(s) that weren't negated before.\n\n` +
    `These functions return:\n` +
    `  - 0 when strings/memory MATCH\n` +
    `  - non-zero when they DIFFER\n\n` +
    `So 'if (strcmp(a, b))' means "if they DIFFER" — this is the standard C idiom ` +
    `since the 1970s. Adding '!' inverts this to "if they MATCH", which flips the ` +
    `logic of filter/validation code.\n\n` +
    `Example of this hallucinated "fix":\n` +
    `  original: if (!serial.empty() && wcscmp(serial, device_serial))  // reject non-matching\n` +
    `  proposed: if (!serial.empty() && !wcscmp(serial, device_serial)) // reject MATCHING devices!\n\n` +
    `If you genuinely need this inversion, use the explicit form instead:\n` +
    `  change to: cmp(a, b) == 0   (matches the user-readable intent, passes this guard)\n` +
    `  or change to: cmp(a, b) != 0\n\n` +
    `This guard protects against a known LLM failure mode where the model ` +
    `misreads C comparison semantics. Override with KCODE_SEMANTIC_GUARDS=off ` +
    `only if you are certain the original code has a real bug.`
  );
}
