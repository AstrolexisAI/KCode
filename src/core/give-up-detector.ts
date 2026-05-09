// KCode - Give-up signature detector
//
// Detects when the model "gave up" on an agentic task instead of
// actually running tools. Hard symptoms — verified live on macOS
// 2026-05-08 with Gemma-4-26b and Qwen3-Coder-30B:
//   - Model writes prose like "tools restricted", "no puedo
//     ejecutar comandos", "please paste the output here"
//   - Issued zero tool calls (or a few that all errored, then
//     gave up instead of retrying)
//
// When detected, the routing layer can blacklist the model for the
// current task type for the rest of the session, and the next turn
// escalates to the next priority tier (e.g. local Gemma → Claude
// Haiku → Sonnet). This is the "siempre llegar al resultado" bit
// of the smart selector that user requested 2026-05-08.
//
// Design constraints:
//   - Zero false positives on actual chat / explanations. A model
//     answering "REST is..." should not be flagged as give-up.
//   - Language-aware (Spanish + English). Curly's prompts are
//     mostly Spanish; the failure modes show up in both.
//   - Conservative: if we're unsure, return null. Better to leave
//     the model in place than escalate every chat turn.

export interface GiveUpDetection {
  /** Why we flagged this turn as a give-up. */
  reason: string;
  /** The matched signature (for telemetry / audit log). */
  signature: string;
}

// Phrases that strongly indicate the model is hallucinating environmental
// restrictions or refusing to act on a tool-using request. Loose patterns
// — better to over-match a few chat turns than miss the actual give-ups.
// Caller is expected to also gate on multimodel routing being enabled.
const GIVE_UP_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // ── "Tools are restricted / restringidas" (any verb between) ──
  [/restringid|sandboxed|deshabilitad/i, "restricted-token-es"],
  [
    /\b(?:tools?|environment|system|sandbox)\b.{0,30}\b(?:restricted|sandboxed|limited|blocked|locked)\b/i,
    "tools-restricted-en",
  ],
  // ── "Restricciones del / en el entorno / sistema / sandbox" ──
  [
    /restricciones?\b.{0,40}\b(?:entorno|ambiente|sistema|sandbox|seguridad|permisos)/i,
    "restrictions-spanish",
  ],

  // ── "I can't / no puedo execute / acceder" ──
  [/no\s+(?:puedo|tengo\s+permiso)\s+(?:ejecutar|correr|acceder|usar|ver)/i, "cannot-execute-es"],
  [/\b(?:cannot|can'?t|unable\s+to)\s+(?:execute|run|access|see)\b/i, "cannot-execute-en"],
  [/i\s+do\s+not\s+have\s+(?:access|permission|the\s+ability)\s+to/i, "no-access-en"],

  // ── "Please paste / pegame el resultado" ──
  [/\b(?:please\s+)?paste\s+.{0,30}\b(?:result|output|here)/i, "paste-please-en"],
  [/\bpe[gj]a?[mt]?[eo]?\b.{0,40}\b(?:result|salida|aqu[ií]|resultado|output)/i, "paste-please-es"],
  [/\bcompart[ei][rt]?\b.{0,40}\b(?:result|salida|resultado|aqu[ií])/i, "share-please-es"],

  // ── "Run it yourself / ejecutalo tú" ──
  [
    /\b(?:ejecut[aá]l[oa]?|cor[rR][eé]l[oa]?|h[aá]z?l[oa]?)\s+(?:t[uú]|vos|en\s+tu)\b/i,
    "do-it-yourself-es",
  ],
  [/\b(?:run|execute|do)\s+it\s+yourself\b/i, "do-it-yourself-en"],

  // ── "Command not found → no puedo seguir" (model treats missing
  // ── tool as permanent block instead of installing or substituting) ──
  [
    /(?:command\s+not\s+found|no\s+est[aá]\s+instalado).{0,120}(?:no\s+puedo|cannot|imposible|impossible)/i,
    "blocked-by-missing-cmd",
  ],
];

/**
 * Inspect an assistant turn's text + tool-call count and decide whether
 * the model is giving up on an agentic task.
 *
 * Logic:
 *   1. If the assistant issued ANY tool call this turn, we don't flag
 *      give-up — even a partially-failed run is engagement, not refusal.
 *   2. If the assistant's text contains a strong give-up signature
 *      (tools restricted, please paste, no puedo, etc.), flag it.
 *   3. Otherwise return null.
 *
 * Note: we don't try to judge "the prompt expected tool calls" here —
 * that's the caller's call. A harmless "explain REST" should never
 * trigger because no give-up phrase fires; a "analiza la red" turn
 * that emits "tools restringidas" without a single Bash call WILL.
 */
export function detectGiveUp(assistantText: string, toolCallCount: number): GiveUpDetection | null {
  if (toolCallCount > 0) return null; // engagement = no give-up
  if (!assistantText || assistantText.trim().length === 0) return null;

  for (const [pattern, signature] of GIVE_UP_PATTERNS) {
    const m = assistantText.match(pattern);
    if (m) {
      // Surface a short snippet of what matched, for the routing layer
      // and audit log to understand what triggered.
      const snippet = m[0].length > 80 ? `${m[0].slice(0, 77)}...` : m[0];
      return {
        reason: `Model wrote a give-up signature ("${snippet}") without issuing any tool calls.`,
        signature,
      };
    }
  }
  return null;
}

/**
 * Convenience: format a one-line warning the routing layer can show
 * the user when escalation kicks in.
 */
export function formatEscalationNotice(
  fromModel: string,
  toModel: string,
  detection: GiveUpDetection,
): string {
  return `\x1b[33m⇪ Auto-escalating ${fromModel} → ${toModel} (give-up detected: ${detection.signature}). ${detection.reason}\x1b[0m`;
}
