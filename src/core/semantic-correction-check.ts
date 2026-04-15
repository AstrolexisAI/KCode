// KCode - Phase 30: Semantic correction detector
//
// Detects when the user is explicitly re-targeting the model —
// saying "no es X, es Y" or "the problem is not X, it's Y". These
// messages carry the most important signal in a session because
// they mean the model has been working on the WRONG thing and
// needs to pivot. Without this guard, the model often acknowledges
// the correction in prose but keeps applying the same wrong fixes.
//
// Evidence: v2.10.74 Nexus Telemetry chart session. The user said:
//
//   1. "la grafica no quedo"
//   2. "ahora el problema es el modal donde se situan las graficas
//      no quedan estaticas al tamaño que ocupan las graficas"
//   3. "refresque ahora las graficas no son el problema, sino el
//      contenedor de las graficas"
//
// The 3rd message is an explicit correction: "NOT the charts, it's
// the container". The model responded "Entendido" and then kept
// applying chart-config CSS fixes instead of container-CSS fixes.
// Phase 25 partially catches repetition, but phase 30 captures the
// SPECIFIC signal of a re-targeting statement and produces a
// stronger reminder pointing at the correct noun.
//
// This is a pre-turn guard (injected as a user-role message before
// the model's next turn) so it works alongside phase 25. Phase 25
// says "you're in a rut, propose a different approach" — phase 30
// says "here's specifically what to look at instead".

import type { Message } from "./types.js";

// ─── Extraction patterns ─────────────────────────────────────────

/**
 * Patterns that match "not X, but Y" style semantic corrections.
 * Each pattern captures two groups: the WRONG target and the RIGHT
 * target. The groups are later cleaned up and used in the reminder.
 */
interface CorrectionPattern {
  regex: RegExp;
  /** Index of the "wrong target" capture group. */
  wrongGroup: number;
  /** Index of the "right target" capture group. */
  rightGroup: number;
}

const CORRECTION_PATTERNS: CorrectionPattern[] = [
  // Spanish: "X no es/son el problema, sino Y" / "... es Y"
  {
    regex:
      /\b([^.,;\n]{3,60})\s+no\s+(?:es|son|era|eran)\s+el\s+problema,?\s+(?:sino|es|son)\s+([^.,;\n]{3,60})/i,
    wrongGroup: 1,
    rightGroup: 2,
  },
  // Spanish: "el problema no es X, (sino|es) Y"
  {
    regex:
      /\bel\s+problema\s+no\s+(?:es|son|era|eran)\s+([^.,;\n]{3,60}),?\s+(?:sino|es|son)\s+([^.,;\n]{3,60})/i,
    wrongGroup: 1,
    rightGroup: 2,
  },
  // Spanish: "no es X, (es|sino) Y"
  {
    regex:
      /\bno\s+(?:es|son|era|eran)\s+([^.,;\n]{3,60}),?\s+(?:sino|es|son)\s+([^.,;\n]{3,60})/i,
    wrongGroup: 1,
    rightGroup: 2,
  },
  // Spanish: "en vez de X, (es|sino|usa) Y"
  {
    regex: /\ben\s+vez\s+de\s+([^.,;\n]{3,60}),?\s+([^.,;\n]{3,60})/i,
    wrongGroup: 1,
    rightGroup: 2,
  },
  // English: "X is not the problem, it's/the problem is Y"
  {
    regex:
      /\b([^.,;\n]{3,60})\s+(?:is|are|was|were)\s+not\s+(?:the\s+)?problem,?\s+(?:it'?s|they'?re|the\s+problem\s+is)\s+([^.,;\n]{3,60})/i,
    wrongGroup: 1,
    rightGroup: 2,
  },
  // English: "the problem is not X, it's/but Y"
  {
    regex:
      /\bthe\s+(?:real\s+)?problem\s+(?:is|was)\s+not\s+([^.,;\n]{3,60}),?\s+(?:it'?s|but|it\s+is)\s+([^.,;\n]{3,60})/i,
    wrongGroup: 1,
    rightGroup: 2,
  },
  // English: "not X, (but|it's) Y"
  {
    regex:
      /\bnot\s+([^.,;\n]{3,60}),?\s+(?:but|it'?s|the\s+issue\s+is)\s+([^.,;\n]{3,60})/i,
    wrongGroup: 1,
    rightGroup: 2,
  },
  // English: "instead of X, (look at|it's|use) Y"
  {
    regex:
      /\binstead\s+of\s+([^.,;\n]{3,60}),?\s+(?:look\s+at|it'?s|use|try)\s+([^.,;\n]{3,60})/i,
    wrongGroup: 1,
    rightGroup: 2,
  },
];

/** Clean up a captured phrase: trim whitespace, strip leading determiners. */
function cleanPhrase(phrase: string): string {
  return phrase
    .trim()
    .replace(/^(?:el|la|los|las|un|una|unos|unas|the|a|an)\s+/i, "")
    .trim();
}

// ─── Verdict ─────────────────────────────────────────────────────

export interface SemanticCorrectionVerdict {
  isCorrection: boolean;
  /** The phrase the user said is NOT the target (wrong focus). */
  wrongTarget: string;
  /** The phrase the user said IS the target (correct focus). */
  rightTarget: string;
  /** The full matched phrase from the user's message, for the reminder. */
  fullMatch: string;
  /** Index of the user message in recent history (most recent = highest). */
  messageIndex: number;
}

/**
 * Scan the most recent N user text messages (newest first) looking
 * for a "not X, but Y" style correction. Returns the first match
 * found (most recent wins). Skips system-injected reminders.
 */
export function checkSemanticCorrection(
  messages: Message[],
  newUserMessage?: string,
  lookback = 3,
): SemanticCorrectionVerdict {
  // Collect recent user text messages, newest last
  const recent: string[] = [];
  const systemPrefixes = [
    "[SYSTEM]",
    "[REALITY CHECK]",
    "[CLAIM/MUTATION MISMATCH]",
    "[CONTENT MISMATCH]",
    "[USER REPETITION",
    "[PLAN RECONCILIATION]",
    "[SEMANTIC CORRECTION",
  ];
  for (let i = messages.length - 1; i >= 0 && recent.length < lookback; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    if (typeof msg.content !== "string") continue;
    const t = msg.content.trim();
    if (!t) continue;
    if (systemPrefixes.some((p) => t.startsWith(p))) continue;
    recent.push(t);
  }
  recent.reverse();
  if (newUserMessage !== undefined && newUserMessage.trim() !== "") {
    recent.push(newUserMessage.trim());
  }

  // Scan newest → oldest so we return the most recent correction
  for (let i = recent.length - 1; i >= 0; i--) {
    const text = recent[i]!;
    for (const { regex, wrongGroup, rightGroup } of CORRECTION_PATTERNS) {
      const m = text.match(regex);
      if (m && m[wrongGroup] && m[rightGroup]) {
        const wrong = cleanPhrase(m[wrongGroup]);
        const right = cleanPhrase(m[rightGroup]);
        // Reject degenerate matches: identical wrong/right, or
        // either side under 3 chars after cleaning
        if (wrong.length < 3 || right.length < 3) continue;
        if (wrong.toLowerCase() === right.toLowerCase()) continue;
        return {
          isCorrection: true,
          wrongTarget: wrong,
          rightTarget: right,
          fullMatch: m[0].trim(),
          messageIndex: i,
        };
      }
    }
  }

  return {
    isCorrection: false,
    wrongTarget: "",
    rightTarget: "",
    fullMatch: "",
    messageIndex: -1,
  };
}

// ─── Reminder formatter ──────────────────────────────────────────

export function buildSemanticCorrectionReminder(
  verdict: SemanticCorrectionVerdict,
): string {
  const lines: string[] = [];
  lines.push("[SEMANTIC CORRECTION — USER IS RE-TARGETING YOU]");
  lines.push("");
  lines.push(
    `The user just told you EXPLICITLY that your previous fix target`,
  );
  lines.push(`was wrong. Quoting their exact words:`);
  lines.push("");
  lines.push(`  "${verdict.fullMatch}"`);
  lines.push("");
  lines.push(`Decoded:`);
  lines.push(`  ❌ NOT this:  "${verdict.wrongTarget}"`);
  lines.push(`  ✅ BUT this:  "${verdict.rightTarget}"`);
  lines.push("");
  lines.push(
    `This is a HARD REDIRECTION. Your previous edits were likely`,
  );
  lines.push(
    `working on "${verdict.wrongTarget}" and leaving "${verdict.rightTarget}"`,
  );
  lines.push(
    `untouched — that's why the bug persists. The fix is NOT in the`,
  );
  lines.push(`region you've been editing.`);
  lines.push("");
  lines.push(`Before your next tool call you MUST:`);
  lines.push(
    `  1. Stop iterating on "${verdict.wrongTarget}". Any edit to that`,
  );
  lines.push(
    `     region is probably wasted work now.`,
  );
  lines.push(
    `  2. Grep or Read the code region that holds "${verdict.rightTarget}"`,
  );
  lines.push(
    `     so you see the actual structure before editing.`,
  );
  lines.push(
    `  3. Propose a fix SPECIFIC to "${verdict.rightTarget}" — not a`,
  );
  lines.push(
    `     generic chart-responsive / layout-fix template.`,
  );
  lines.push(
    `  4. Do NOT write "✅ Entendido" followed by another edit to`,
  );
  lines.push(
    `     "${verdict.wrongTarget}". The user will notice and lose trust.`,
  );
  lines.push("");
  lines.push(
    `If "${verdict.rightTarget}" is ambiguous or you don't know what`,
  );
  lines.push(
    `element in the code corresponds to it, ASK the user to point`,
  );
  lines.push(
    `at a specific class name, function, or line — do not guess.`,
  );
  return lines.join("\n");
}
