// KCode - Phase 25: user-repetition detector
//
// Detects when the user is asking for the same fix multiple times in
// a row with frustration signals. Fires when:
//
//   1. ≥3 of the last 5 non-system user messages share at least one
//      significant content token (length ≥5, not a stop word)
//   2. AND at least one of those messages contains a frustration
//      signal ("sigue igual", "still broken", "audita", etc.)
//
// On fire, the next turn gets a [USER REPETITION] reminder injected
// as a user-role message. The reminder tells the model that its
// previous attempts did not fix the issue, it's in a rut, and it
// must either propose a fundamentally different fix path OR honestly
// admit it doesn't know.
//
// Evidence: v2.10.67 Orbital session, Mars Surface Temperature chart
// bug reported 4 times ("la gráfica no renderiza", "colapsa el
// scroll", "sigue igual, audita el problema"). Model diagnosed
// correctly each time but kept proposing the same fix in prose
// without applying it correctly. $5.39 and 19 minutes burned.
// Phase 15 only fired once at the very end (2 claims, 0 mutations)
// because earlier turns had mechanical Edits that "succeeded" on
// wrong code paths, bypassing the zero-mutation trigger.

import type { Message } from "./types.js";

// ─── Frustration signal patterns ─────────────────────────────────

const FRUSTRATION_PATTERNS: RegExp[] = [
  // Spanish
  /\bsigue\s+igual\b/i,
  /\bsigue\s+(?:sin|roto|mal|el\s+mismo|fallando)/i,
  /\btodav[íi]a\s+(?:sigue|no|est[aá]|tiene|tengo)\b/i,
  /\botra\s+vez\b/i,
  /\bde\s+nuevo\b/i,
  /\bno\s+funciona(?:ba|ron)?\b/i,
  /\bno\s+anda\b/i,
  /\bno\s+cambi[oó]\b/i,
  /\bnada\s+(?:anda|funciona|cambi[oó]|arregla)/i,
  /\bno\s+lo\s+(?:arreglaste|solucionaste|fixeaste)/i,
  /\bno\s+est[aá]\s+arreglad/i,
  /\bmismo\s+(?:problema|error|bug|issue|fallo)\b/i,
  /\bel\s+problema\s+(?:sigue|persiste|continua)/i,
  /\baudita(?:lo|r)?\b/i,
  // English
  /\bstill\s+(?:broken|not\s+working|the\s+same|doesn'?t|failing)\b/i,
  /\bnot\s+(?:fixed|working)\b/i,
  /\bsame\s+(?:problem|issue|error|bug)\b/i,
  /\btry\s+again\b/i,
  /\bfix\s+(?:it\s+)?again\b/i,
  /\bdidn'?t\s+(?:work|fix)\b/i,
  /\bstill\s+breaks?\b/i,
];

// ─── Stop words ──────────────────────────────────────────────────
// Words that are common in frustration messages but shouldn't count
// as "shared topic" tokens. Length ≥5 lets us skip most function
// words automatically; this set kills the remaining noise.

const STOPWORDS = new Set<string>([
  // Spanish content-but-non-topic
  "sigue",
  "todavía",
  "todavia",
  "nuevo",
  "funciona",
  "arreglo",
  "aplico",
  "aplicado",
  "hicimos",
  "haces",
  "hacer",
  "misma",
  "mismo",
  "bien",
  "nadie",
  "tiene",
  "puede",
  "debe",
  "debería",
  "deberia",
  "entonces",
  "ahora",
  "ahorita",
  "antes",
  "después",
  "despues",
  "audita",
  "auditar",
  "auditalo",
  "problema",
  "seguro",
  "quiero",
  "quieres",
  "puedes",
  "siempre",
  "nunca",
  "cuando",
  "donde",
  "porque",
  "porqué",
  "arreglaste",
  "solucionaste",
  // English content-but-non-topic
  "still",
  "again",
  "broken",
  "works",
  "working",
  "worked",
  "fixing",
  "fixed",
  "didn",
  "doesn",
  "problem",
  "issue",
  "error",
  "thing",
  "thank",
  "please",
  "maybe",
  "could",
  "would",
  "should",
  "shall",
  "there",
  "these",
  "those",
  "where",
  "which",
  "while",
  "about",
  "after",
  "before",
]);

// ─── Tokenization ────────────────────────────────────────────────

/**
 * Split a user message into significant content-word tokens.
 * Keeps words of length ≥5, excludes known stopwords, lowercases.
 * Normalizes common accented chars so "gráfica" and "grafica" match.
 */
function significantTokens(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    // Strip accents (NFD → remove combining marks)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // Replace non-alphanumeric with space
    .replace(/[^a-z0-9\s]/g, " ");
  const tokens = normalized
    .split(/\s+/)
    .filter((t) => t.length >= 5 && !STOPWORDS.has(t));
  return new Set(tokens);
}

// ─── Recent user message collection ──────────────────────────────

const SYSTEM_REMINDER_PREFIXES = [
  "[SYSTEM]",
  "[REALITY CHECK]",
  "[CLAIM/MUTATION MISMATCH]",
  "[CONTENT MISMATCH]",
  "[USER REPETITION",
  "[PLAN RECONCILIATION]",
  "[USER FRUSTRATION",
];

/**
 * Walk messages backwards and collect the last N user-authored text
 * messages. Skips:
 *   - tool_result-only user messages
 *   - system-injected reminders (phase 15/18/20/22/25, plan, etc.)
 *   - empty strings
 *
 * Returns messages in chronological order (oldest first).
 */
export function collectRecentUserMessages(
  messages: Message[],
  limit = 5,
): string[] {
  const result: string[] = [];
  for (let i = messages.length - 1; i >= 0 && result.length < limit; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role !== "user") continue;
    if (typeof msg.content !== "string") continue;
    const t = msg.content.trim();
    if (!t) continue;
    if (SYSTEM_REMINDER_PREFIXES.some((p) => t.startsWith(p))) continue;
    result.push(t);
  }
  return result.reverse();
}

// ─── Verdict ─────────────────────────────────────────────────────

export interface UserRepetitionVerdict {
  isRepeating: boolean;
  /** Significant tokens that appeared in ≥3 recent user messages. */
  sharedTopics: string[];
  /** Frustration signal phrases detected (first match per message). */
  frustrationSignals: string[];
  /** The recent user messages that were scanned, oldest-first. */
  recentMessages: string[];
}

/**
 * Scan the recent user messages and decide whether the user is
 * in a repetition+frustration pattern. Two gates:
 *
 *   1. ≥3 messages share at least one significant content token
 *      (e.g. "grafica" / "chart" / "header")
 *   2. ≥1 of the recent messages contains a frustration signal
 *
 * Both must fire — shared topics alone can be normal continuity,
 * frustration alone can be unrelated to repetition.
 */
export function checkUserRepetition(
  messages: Message[],
  newUserMessage?: string,
): UserRepetitionVerdict {
  const historical = collectRecentUserMessages(messages, 5);
  // Optionally fold in the CURRENT user message if the caller passes
  // it — by the time checkUserRepetition runs in sendMessage, the
  // new message hasn't been pushed to state.messages yet.
  const recent =
    newUserMessage !== undefined && newUserMessage.trim() !== ""
      ? [...historical, newUserMessage.trim()].slice(-5)
      : historical;

  if (recent.length < 3) {
    return {
      isRepeating: false,
      sharedTopics: [],
      frustrationSignals: [],
      recentMessages: recent,
    };
  }

  // Gate 2 (cheaper): frustration signals must exist somewhere
  const frustrationSignals: string[] = [];
  for (const text of recent) {
    for (const re of FRUSTRATION_PATTERNS) {
      const m = text.match(re);
      if (m) {
        frustrationSignals.push(m[0].toLowerCase());
        break;
      }
    }
  }
  if (frustrationSignals.length === 0) {
    return {
      isRepeating: false,
      sharedTopics: [],
      frustrationSignals: [],
      recentMessages: recent,
    };
  }

  // Gate 1: count token occurrences across messages
  const tokenCounts = new Map<string, number>();
  for (const text of recent) {
    const tokens = significantTokens(text);
    for (const t of tokens) {
      tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
    }
  }

  const minShare = Math.min(3, recent.length);
  const sharedTopics: string[] = [];
  for (const [token, count] of tokenCounts) {
    if (count >= minShare) sharedTopics.push(token);
  }

  return {
    isRepeating: sharedTopics.length > 0,
    sharedTopics,
    frustrationSignals,
    recentMessages: recent,
  };
}

// ─── Reminder formatter ──────────────────────────────────────────

export function buildUserRepetitionReminder(
  verdict: UserRepetitionVerdict,
  contextSaturation?: number,
): string {
  const lines: string[] = [];
  lines.push("[USER REPETITION — SAME ISSUE REPEATED]");
  lines.push("");
  lines.push(
    `The user has reported the same topic across ${verdict.recentMessages.length} ` +
      `of their most recent messages. Shared keyword(s): ` +
      verdict.sharedTopics
        .slice(0, 5)
        .map((t) => `"${t}"`)
        .join(", "),
  );
  lines.push("");
  lines.push("Recent user messages (oldest → newest):");
  for (let i = 0; i < verdict.recentMessages.length; i++) {
    const m = verdict.recentMessages[i];
    if (!m) continue;
    const truncated = m.length > 140 ? m.slice(0, 137) + "..." : m;
    lines.push(`  ${i + 1}. "${truncated}"`);
  }
  lines.push("");
  lines.push(
    `Frustration signals detected: ${verdict.frustrationSignals.join(", ")}`,
  );
  lines.push("");
  lines.push(
    "This means your previous attempts did NOT fix the actual problem.",
  );
  lines.push("You are in a rut. Do NOT:");
  lines.push("  - Propose the same fix approach again");
  lines.push('  - Write another "✅ Aplicado" / "Fixed" / "Done" claim');
  lines.push(
    "  - Run more diagnostic Reads on the same file region you already checked",
  );
  lines.push(
    "  - Emit a long AUDIT REPORT in prose without actually applying a mutation",
  );
  lines.push("");
  lines.push("Instead you MUST do ONE of:");
  lines.push(
    "  a) Re-read the EXACT code path the user is pointing at, line by line,",
  );
  lines.push(
    "     and propose a FUNDAMENTALLY DIFFERENT fix. Show your reasoning for",
  );
  lines.push("     why the previous attempts missed the mark.");
  lines.push(
    '  b) Admit "I do not know why this is happening" and ask the user for',
  );
  lines.push(
    "     more info (browser console screenshot, devtools trace, exact repro",
  );
  lines.push(
    "     steps). Honesty is better than yet another failed attempt.",
  );

  if (contextSaturation !== undefined && contextSaturation >= 0.85) {
    lines.push("");
    lines.push(
      `⚠️ Context window is ~${Math.round(contextSaturation * 100)}% full.`,
    );
    lines.push(
      "You have lost track of what you already tried. Before the next fix,",
    );
    lines.push(
      "run /compact to free space and reset working memory, then approach the",
    );
    lines.push("problem with a clean slate.");
  }

  return lines.join("\n");
}
