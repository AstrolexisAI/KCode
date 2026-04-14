// KCode - Claim-vs-Reality Check (phase 15)
//
// Detects the failure mode where the model writes a "task completed"
// summary describing changes that NEVER actually happened in the
// tool call history for that turn. This is the most corrosive
// hallucination pattern because it directly deceives the user:
//
//   Session evidence (grok-4.20 on a NASA Explorer refactor):
//     - Model text claimed:
//         "Updated version header v2.1 → v2.3"
//         "Changed all hardcoded dates 2025 → 2026"
//         "Replaced remaining red-400 classes with border-[#FC3D21]"
//     - Actual tool calls:
//         Edit x2 → both failed
//         GrepReplace x6 → all "No matching files found"
//         sed x2 → exit 0 but no matches, file hash unchanged
//     - Real file state after session:
//         v2.1 still present at lines 495 + 748
//         2025 still at lines 274, 460, 483, 501, ...
//         No red-400 existed anywhere
//
// Phase 13 (anti-fabrication) catches fabricated PATHS in tool
// errors. It does NOT catch the model writing fabricated CLAIMS in
// its prose. That's what phase 15 is for.
//
// Approach:
//   1. Extract "change claims" from the final assistant text — phrases
//      like "Updated X", "Changed Y → Z", "Replaced A with B", "Fixed
//      the N bug", "v2.1 → v2.3", etc. Lightweight pattern matching,
//      not semantic parsing.
//   2. Scan the turn's tool call history for evidence that a Write/
//      Edit/MultiEdit/GrepReplace ACTUALLY succeeded. A "successful
//      change" is a non-error tool result from one of those tools
//      whose result content contains "Created", "Edited", "replaced",
//      "wrote", etc.
//   3. If the assistant made claims but no successful change tool
//      actually ran, the next turn gets a [REALITY CHECK] user-role
//      reminder listing the specific claims and the tool evidence
//      that contradicts them, forcing the model to either correct
//      the claim or actually make the change.
//
// Design constraints:
//   - Cheap: regex scan, no LLM call.
//   - Conservative: only fire when the delta is unambiguous (claims
//     exist AND zero successful mutations). A model that mentions
//     "I also cleaned up whitespace" alongside a real Edit should
//     not trigger.
//   - Narrow: only user-visible prose claims, not internal reasoning.

import type { Message } from "./types.js";

// ─── Claim pattern detection ──────────────────────────────────────

/**
 * Regexes that match concrete completion claims in assistant prose.
 * Each capture group points at the noun phrase being claimed changed,
 * so the reality-check report can show the exact claim verbatim.
 */
const CLAIM_PATTERNS: { name: string; regex: RegExp }[] = [
  // "Updated X" / "Updated the version header"
  { name: "updated", regex: /\b(?:updated|actualizad[oa]|actualic[eé])\s+([^.\n;]{3,80})/gi },
  // "Changed X" / "Changed all hardcoded dates from 2025 to 2026"
  { name: "changed", regex: /\b(?:changed|cambi[eé]|modifiqu[eé])\s+([^.\n;]{3,80})/gi },
  // "Replaced X with Y"
  { name: "replaced", regex: /\b(?:replaced|reemplac[eé])\s+([^.\n;]{3,80})/gi },
  // "Fixed X"
  { name: "fixed", regex: /\b(?:fixed|arregl[eé]|corrig[iíe])\s+([^.\n;]{3,80})/gi },
  // "Added X"
  { name: "added", regex: /\b(?:added|a[nñ]ad[iíe]|agregad[oa])\s+([^.\n;]{3,80})/gi },
  // "Removed X"
  { name: "removed", regex: /\b(?:removed|deleted|elimin[eé]|borr[eé])\s+([^.\n;]{3,80})/gi },
  // "Rewrote X"
  { name: "rewrote", regex: /\b(?:rewrote|reescrib[iíe]|refactorized)\s+([^.\n;]{3,80})/gi },
];

/** Phrases that indicate the assistant is declaring done. */
const COMPLETION_MARKERS = [
  /\btask completed?\b/i,
  /\btarea completad[ao]\b/i,
  /\bsuccessfully (?:created|updated|edited|modified|replaced|changed|fixed|refactored|completed)\b/i,
  /\b(?:updated|changed|fixed|refactored) successfully\b/i,
  /\bdone\b/i,
  /\bready to use\b/i,
  /\blisto para usar\b/i,
  /\bcompleted\b/i,
];

export interface ClaimReport {
  /** All concrete claim phrases found in the assistant text. */
  claims: string[];
  /** True if the text also contains a generic "done"-style marker. */
  hasCompletionMarker: boolean;
}

/**
 * Extract completion claims from the assistant's final text. Returns
 * the raw claim phrases so the reality-check reminder can quote them.
 */
export function extractClaims(assistantText: string): ClaimReport {
  if (!assistantText) return { claims: [], hasCompletionMarker: false };
  const claims: string[] = [];
  for (const { regex } of CLAIM_PATTERNS) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(assistantText)) !== null) {
      const full = m[0].trim().replace(/\s+/g, " ");
      // Cap length to keep the reminder cheap
      claims.push(full.length > 140 ? full.slice(0, 137) + "..." : full);
    }
  }
  const hasCompletionMarker = COMPLETION_MARKERS.some((re) => re.test(assistantText));
  return { claims, hasCompletionMarker };
}

// ─── Tool-call reality scan ───────────────────────────────────────

/**
 * Names of tools whose successful execution proves a real mutation
 * happened on disk or on git state.
 */
const MUTATING_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "GrepReplace",
  "Rename",
  "GitCommit",
]);

/**
 * Regexes that match the success banner of a mutating tool result.
 * A tool_result whose content matches one of these AND has
 * is_error=false counts as "evidence of real mutation".
 */
const SUCCESS_MARKERS: RegExp[] = [
  /\bcreated\b/i,
  /\bedited\b/i,
  /\bwrote?\b/i,
  /\breplacements?\b/i,
  /\bapplied\b/i,
  /\bcommit(?:ted)?\b/i,
  /\brenamed\b/i,
];

/**
 * Walk the messages for this turn and count successful mutation tool
 * results. A "turn" for our purposes is everything after the last
 * user-authored text message (i.e. the most recent tool-use/result
 * dialogue). This keeps the check scoped to what the model JUST did,
 * not cumulative session history.
 */
export function countSuccessfulMutations(messages: Message[]): {
  successful: number;
  names: string[];
} {
  let i = messages.length - 1;
  // Walk backward to the most recent user text (the user's original
  // request). Everything AFTER that point is the current turn.
  while (i >= 0) {
    const m = messages[i];
    if (!m) {
      i--;
      continue;
    }
    if (m.role !== "user") {
      i--;
      continue;
    }
    if (typeof m.content === "string") break;
    if (Array.isArray(m.content)) {
      // Skip user messages that contain only tool_results — those
      // are part of the turn, not the boundary.
      const onlyToolResults = m.content.every(
        (b) => (b as { type?: string }).type === "tool_result",
      );
      if (!onlyToolResults) break;
    }
    i--;
  }
  const turnMessages = messages.slice(i + 1);

  const names: string[] = [];
  let toolUseNameById = new Map<string, string>();
  for (const msg of turnMessages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as { type?: string; id?: string; name?: string };
        if (b.type === "tool_use" && b.id && b.name) {
          toolUseNameById.set(b.id, b.name);
        }
      }
    }
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as {
          type?: string;
          tool_use_id?: string;
          is_error?: boolean;
          content?: unknown;
        };
        if (b.type !== "tool_result") continue;
        if (b.is_error) continue;
        const toolName = b.tool_use_id ? toolUseNameById.get(b.tool_use_id) : undefined;
        if (!toolName || !MUTATING_TOOLS.has(toolName)) continue;
        const contentStr =
          typeof b.content === "string"
            ? b.content
            : Array.isArray(b.content)
              ? b.content
                  .map((sub) => {
                    const s = sub as { type?: string; text?: string };
                    return s.type === "text" && s.text ? s.text : "";
                  })
                  .join("\n")
              : "";
        if (SUCCESS_MARKERS.some((re) => re.test(contentStr))) {
          names.push(toolName);
        }
      }
    }
  }
  return { successful: names.length, names };
}

// ─── High-level verdict ───────────────────────────────────────────

export interface RealityVerdict {
  /** True if the assistant text claims changes but no tool actually made any. */
  isHallucinatedCompletion: boolean;
  /**
   * Phase 18: true when the claim-to-mutation ratio is suspicious — model
   * made many distinct claims but only a few mutations landed. Weaker
   * signal than isHallucinatedCompletion, triggers a softer reminder.
   */
  isClaimMutationMismatch: boolean;
  claims: string[];
  successfulMutations: number;
  mutatingToolNames: string[];
}

/**
 * Phase 20: content-level mismatch — the assistant prose references
 * specific URLs (or other distinctive literals) that never appear in
 * ANY tool call this turn, whether as input, successful output, or
 * failed output. Different from phase 15/18 which both reason about
 * mutation counts. Phase 20 catches the case where the model wrote a
 * fabricated diff in prose while having made a legitimate but DIFFERENT
 * edit to the file.
 */
export interface ContentMismatchVerdict {
  isContentMismatch: boolean;
  /** Literals mentioned in prose that don't appear in any tool activity this turn. */
  missingLiterals: string[];
  /** Literals mentioned in prose that DO appear somewhere in tool activity. */
  foundLiterals: string[];
}

export function checkClaimReality(
  assistantText: string,
  messages: Message[],
): RealityVerdict {
  const { claims, hasCompletionMarker } = extractClaims(assistantText);
  const { successful, names } = countSuccessfulMutations(messages);
  // Fire when the model made ≥2 concrete claims (one-word generic
  // claims are too noisy) AND zero mutations succeeded in the turn.
  // OR when it wrote a completion marker + ≥1 claim and still 0
  // successful mutations.
  const isHallucinatedCompletion =
    successful === 0 &&
    (claims.length >= 2 || (hasCompletionMarker && claims.length >= 1));
  // Phase 18: mismatch fires when there ARE real mutations but the claim
  // count is ≥3x the mutation count AND claims ≥ 5. This catches the
  // pattern where the model makes 2 small Edits and then writes a bullet
  // list describing 8-14 "improvements" that never happened. Do NOT fire
  // when isHallucinatedCompletion is already true — that has its own
  // stronger reminder.
  const isClaimMutationMismatch =
    !isHallucinatedCompletion &&
    successful >= 1 &&
    claims.length >= 5 &&
    claims.length >= successful * 3;
  return {
    isHallucinatedCompletion,
    isClaimMutationMismatch,
    claims,
    successfulMutations: successful,
    mutatingToolNames: names,
  };
}

// ─── Reminder formatter ───────────────────────────────────────────

/**
 * Build the [REALITY CHECK] reminder that gets injected as the next
 * user-role message when checkClaimReality flags a turn.
 */
export function buildRealityCheckReminder(verdict: RealityVerdict): string {
  const lines: string[] = [];
  lines.push(`[REALITY CHECK]`);
  lines.push(``);
  lines.push(
    `Your previous turn claimed concrete changes but NO mutating tool call`,
  );
  lines.push(
    `(Write / Edit / MultiEdit / GrepReplace / Rename / GitCommit) succeeded`,
  );
  lines.push(`in this turn. Count: ${verdict.successfulMutations} successful mutations.`);
  lines.push(``);
  lines.push(`Claims you made in prose:`);
  for (const claim of verdict.claims.slice(0, 8)) {
    lines.push(`  • "${claim}"`);
  }
  if (verdict.claims.length > 8) {
    lines.push(`  • ...and ${verdict.claims.length - 8} more`);
  }
  lines.push(``);
  lines.push(`Common causes:`);
  lines.push(
    `  - Edit failed with "old_string not found" — you did NOT retry with a`,
  );
  lines.push(
    `    valid old_string. The edit did not happen.`,
  );
  lines.push(
    `  - GrepReplace reported "No matching files found" — the file wasn't`,
  );
  lines.push(
    `    scanned (extension filter) or the pattern didn't match. Nothing was`,
  );
  lines.push(`    written.`);
  lines.push(
    `  - \`sed -i\` ran with exit 0 but zero matches — sed does not error on`,
  );
  lines.push(
    `    zero matches, it just returns 0. The file was not modified.`,
  );
  lines.push(``);
  lines.push(`You MUST do ONE of:`);
  lines.push(
    `  a) Actually make the changes now with a real Write / Edit / MultiEdit /`,
  );
  lines.push(
    `     GrepReplace call that returns is_error=false. Verify with a Read`,
  );
  lines.push(`     of the file afterward.`);
  lines.push(
    `  b) Retract your previous claims in clear text: "My previous summary`,
  );
  lines.push(
    `     was wrong. None of those changes actually landed. Here is what`,
  );
  lines.push(`     really happened: ..."`);
  lines.push(``);
  lines.push(
    `Do NOT re-issue the same false summary. Do NOT claim success until a`,
  );
  lines.push(
    `mutation tool has actually returned a success result in this turn.`,
  );
  return lines.join("\n");
}

/**
 * Phase 18: softer reminder for the claim/mutation mismatch case. Some
 * mutations landed, but the claim count is far higher than the mutation
 * count — the model is padding the summary with improvements that never
 * happened.
 */
export function buildClaimMismatchReminder(verdict: RealityVerdict): string {
  const lines: string[] = [];
  lines.push(`[CLAIM/MUTATION MISMATCH]`);
  lines.push(``);
  lines.push(
    `You made ${verdict.claims.length} distinct change claims in your summary,`,
  );
  lines.push(
    `but only ${verdict.successfulMutations} mutation tool call(s) actually`,
  );
  lines.push(
    `succeeded in this turn (${verdict.mutatingToolNames.join(", ") || "none"}).`,
  );
  lines.push(``);
  lines.push(`That ratio is suspicious. Some of the claims below may be real,`);
  lines.push(`but others are almost certainly padding — things you would have`);
  lines.push(`done if you had kept working, not things that actually landed:`);
  lines.push(``);
  for (const claim of verdict.claims.slice(0, 10)) {
    lines.push(`  • "${claim}"`);
  }
  if (verdict.claims.length > 10) {
    lines.push(`  • ...and ${verdict.claims.length - 10} more`);
  }
  lines.push(``);
  lines.push(`Before responding again, do ONE of:`);
  lines.push(
    `  a) Go back and actually implement the claims you listed. Use Edit /`,
  );
  lines.push(
    `     MultiEdit / Write on the real file(s), one claim at a time, until`,
  );
  lines.push(`     the summary matches reality.`);
  lines.push(
    `  b) Rewrite your summary to describe ONLY what the ${verdict.successfulMutations}`,
  );
  lines.push(
    `     successful mutation(s) actually did. Remove every bullet that wasn't`,
  );
  lines.push(`     backed by a real tool call in this turn.`);
  lines.push(``);
  lines.push(
    `Padding a summary with aspirational "improvements" is a quieter version`,
  );
  lines.push(
    `of the same hallucination phase 15 catches. The user checks the file.`,
  );
  return lines.join("\n");
}

// ─── Phase 20: content-claim vs content-reality ───────────────────

/**
 * Extract distinctive URL literals from assistant prose. We deliberately
 * focus on URLs because they're specific, easy to verify substring-wise,
 * and the most common fabrication target (NASA image URLs, CDN links,
 * API endpoints, etc.). Returns deduplicated URLs with trailing
 * punctuation stripped.
 */
export function extractProseUrls(text: string): string[] {
  if (!text) return [];
  const urls = new Set<string>();
  const re = /https?:\/\/[^\s\])"'<>,;|`]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let url = m[0];
    // Strip trailing punctuation that's clearly sentence-level, not part of the URL
    url = url.replace(/[.,;:!?)\]]+$/, "");
    if (url.length >= 12) urls.add(url);
  }
  return Array.from(urls);
}

/**
 * Collect every string the model ACTUALLY interacted with through tools
 * in the current turn: tool_use inputs (Write/Edit content) AND
 * tool_result content (both successful and failed — we're checking
 * whether the URL was in the conversation ground truth, not whether
 * the edit succeeded). Returns a single concatenated blob for
 * substring matching.
 */
export function collectTurnToolActivity(messages: Message[]): string {
  let i = messages.length - 1;
  while (i >= 0) {
    const msg = messages[i];
    if (!msg) {
      i--;
      continue;
    }
    if (msg.role !== "user") {
      i--;
      continue;
    }
    if (typeof msg.content === "string") break;
    if (Array.isArray(msg.content)) {
      const onlyToolResults = msg.content.every(
        (b) => (b as { type?: string }).type === "tool_result",
      );
      if (!onlyToolResults) break;
    }
    i--;
  }
  const turnMessages = messages.slice(i + 1);
  const parts: string[] = [];

  for (const msg of turnMessages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const b = block as {
        type?: string;
        input?: unknown;
        content?: unknown;
      };
      if (b.type === "tool_use" && b.input) {
        // Serialize tool_use input so URLs inside Edit old_string /
        // new_string / Write content are visible in the blob.
        try {
          parts.push(JSON.stringify(b.input));
        } catch {
          /* skip unserializable */
        }
      }
      if (b.type === "tool_result") {
        const contentStr =
          typeof b.content === "string"
            ? b.content
            : Array.isArray(b.content)
              ? b.content
                  .map((sub) => {
                    const s = sub as { type?: string; text?: string };
                    return s.type === "text" && s.text ? s.text : "";
                  })
                  .join("\n")
              : "";
        if (contentStr) parts.push(contentStr);
      }
    }
  }
  return parts.join("\n");
}

/**
 * Phase 20 check: extract URLs from assistant text, check whether
 * each one appears anywhere in the turn's tool activity. Fires when
 * ≥2 URLs are missing — the model is describing a diff that never
 * happened.
 */
export function checkContentMismatch(
  assistantText: string,
  messages: Message[],
): ContentMismatchVerdict {
  const proseUrls = extractProseUrls(assistantText);
  if (proseUrls.length < 2) {
    return { isContentMismatch: false, missingLiterals: [], foundLiterals: [] };
  }
  const toolBlob = collectTurnToolActivity(messages);
  const missing: string[] = [];
  const found: string[] = [];
  for (const url of proseUrls) {
    if (toolBlob.includes(url)) {
      found.push(url);
    } else {
      missing.push(url);
    }
  }
  // Require at least 2 missing URLs to fire. A single off-topic URL
  // (e.g. the model mentioning docs.example.com in passing) should
  // not trip the guard.
  return {
    isContentMismatch: missing.length >= 2,
    missingLiterals: missing,
    foundLiterals: found,
  };
}

export function buildContentMismatchReminder(
  verdict: ContentMismatchVerdict,
): string {
  const lines: string[] = [];
  lines.push(`[CONTENT MISMATCH]`);
  lines.push(``);
  lines.push(
    `Your summary references ${verdict.missingLiterals.length} URL(s) that do NOT`,
  );
  lines.push(
    `appear in ANY tool call this turn — not in any Edit/Write input, and`,
  );
  lines.push(`not in any tool result (successful OR failed):`);
  lines.push(``);
  for (const lit of verdict.missingLiterals.slice(0, 6)) {
    lines.push(`  • ${lit}`);
  }
  if (verdict.missingLiterals.length > 6) {
    lines.push(`  • ...and ${verdict.missingLiterals.length - 6} more`);
  }
  lines.push(``);
  lines.push(
    `You cannot claim you "updated the code to use X" when X was never in`,
  );
  lines.push(
    `a tool_use.input and was never written to the file. The user will`,
  );
  lines.push(
    `open the file and see completely different URLs. This is the`,
  );
  lines.push(
    `failure mode that showed up in the Orbital/Mars session: the model`,
  );
  lines.push(
    `wrote a markdown code block showing picsum.photos URLs while the`,
  );
  lines.push(`actual file still had the photojournal.jpl.nasa.gov ones.`);
  lines.push(``);
  lines.push(`You MUST do ONE of:`);
  lines.push(
    `  a) Actually make the change now — call Edit or Write with the exact`,
  );
  lines.push(
    `     URL(s) you described, then verify with a Read of the file.`,
  );
  lines.push(
    `  b) Retract the claim clearly: "my previous summary described URLs`,
  );
  lines.push(
    `     that were never actually written. The file still contains [the`,
  );
  lines.push(
    `     real URLs]." Then ask the user how to proceed.`,
  );
  return lines.join("\n");
}
