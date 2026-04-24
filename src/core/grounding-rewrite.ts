// KCode - Grounding Rewrite (v305, #111 overclaim-prevention fix)
//
// Prior design: if the assistant emitted an overconfident statement
// ("Ahora tengo una visión profunda del módulo X") with scope.phase
// === partial and mustUsePartialLanguage === true, we appended a
// ⚠ Verified status block BELOW the draft saying 'the narrative
// summary above is unverified'. That's post-mortem — the user
// reads the optimistic text first and the correction second.
//
// This module runs BEFORE the final text renders. It rewrites the
// draft to replace overclaim phrases with scope-honest language.
// The ⚠ block still renders as evidence, but it's no longer
// contradicting what's immediately above it.

import type { TaskScope } from "./task-scope";

interface RewriteResult {
  text: string;
  replacements: number;
  reasons: string[];
}

// Phrases that assert end-to-end understanding or completion. When
// the scope says we're partial / mustUsePartialLanguage / mayClaimReady
// is false, each of these is rewritten to its cautious equivalent.
//
// Matching is regex, case-insensitive, word-boundaried. Replacements
// preserve capitalization of the first letter.
const OVERCLAIM_RULES: Array<{
  name: string;
  pattern: RegExp;
  replacement: string;
}> = [
  // Spanish
  { name: "vision_profunda",       pattern: /\bvisi[oó]n\s+profunda\b/gi,                       replacement: "lectura inicial" },
  { name: "analisis_profundo",     pattern: /\ban[aá]lisis\s+profundo\b/gi,                     replacement: "análisis parcial" },
  { name: "ahora_tengo",           pattern: /\bahora\s+tengo\s+(?:una\s+)?(?:visi[oó]n|comprensi[oó]n|entendimiento)\b/gi, replacement: "tengo una lectura parcial" },
  { name: "completo",              pattern: /\b(?:el\s+)?proyecto\s+est[aá]\s+completo\b/gi,    replacement: "el proyecto está en revisión inicial" },
  { name: "ya_quedo",              pattern: /\bya\s+qued[oó]\b/gi,                              replacement: "revisión parcial hecha" },
  { name: "listo_solo",            pattern: /(?<!\w)listo[,.\s]/gi,                             replacement: "revisión inicial. " },
  { name: "funcional",             pattern: /\best[aá]\s+funcional\b/gi,                        replacement: "fue revisado parcialmente" },
  { name: "operativo",             pattern: /\best[aá]\s+operativo\b/gi,                        replacement: "fue revisado parcialmente" },
  // English
  { name: "deep_understanding",    pattern: /\bdeep\s+(?:understanding|insight|analysis)\b/gi,  replacement: "initial reading" },
  { name: "now_have_full",         pattern: /\bnow\s+(?:have|possess)\s+(?:a\s+)?(?:full|complete|deep)\s+(?:understanding|view|picture)\b/gi, replacement: "have a partial reading" },
  { name: "is_ready",              pattern: /\bis\s+ready\b/gi,                                 replacement: "has a partial scaffold" },
  { name: "fully_functional",      pattern: /\bfully\s+functional\b/gi,                         replacement: "partially reviewed" },
  { name: "project_complete",      pattern: /\bproject\s+(?:is\s+)?complete(?:d)?\b/gi,         replacement: "project has initial scaffold" },
];

/**
 * Rewrite optimistic phrases in a draft when the scope state does not
 * support them. Returns the rewritten text plus metadata about what
 * was changed (for logging / telemetry / test visibility).
 *
 * No-op when scope is healthy (phase=done, mayClaimReady=true,
 * mustUsePartialLanguage=false). Otherwise strips/replaces each
 * matching pattern.
 */
export function rewriteFinalTextForGrounding(
  text: string,
  scope: TaskScope,
): RewriteResult {
  const shouldRewrite =
    scope.phase === "failed" ||
    scope.phase === "partial" ||
    scope.phase === "blocked" ||
    scope.completion.mustUsePartialLanguage ||
    !scope.completion.mayClaimReady;

  if (!shouldRewrite) {
    return { text, replacements: 0, reasons: [] };
  }

  let out = text;
  let replacements = 0;
  const reasons: string[] = [];

  for (const rule of OVERCLAIM_RULES) {
    const before = out;
    out = out.replace(rule.pattern, rule.replacement);
    if (out !== before) {
      replacements++;
      reasons.push(rule.name);
    }
  }

  return { text: out, replacements, reasons };
}

/**
 * Evidence floor: when the draft makes structural/architectural
 * claims (module lists, responsibilities, data flow, design
 * decisions), require at least N source-file reads. Under the floor,
 * the draft gets a prepended "(initial reading)" disclaimer.
 *
 * Hooks into the same rewrite pipeline. Runs independently of the
 * scope.phase check so it fires even on phase=done when the reads
 * don't support the architectural scale of the claim.
 */
export function enforceEvidenceFloor(
  text: string,
  sourceReadsCount: number,
  minRequired: number = 5,
): { text: string; underfloor: boolean } {
  // Detect architectural-claim patterns. Require structural nouns
  // ("arquitectura", "módulos", "responsabilidades", "diseño", etc.)
  // present to trigger — avoids false positives on plain answers.
  const hasArchClaim =
    /\b(?:arquitectura|m[oó]dulos|responsabilidades|dise[nñ]o|estructura\s+interna|data\s*flow|dependencias|architecture|modules|responsibilities|internal\s+structure|design\s+decisions)\b/i.test(
      text,
    );
  if (!hasArchClaim) return { text, underfloor: false };
  if (sourceReadsCount >= minRequired) return { text, underfloor: false };

  // Prepend a disclaimer. Don't rewrite the claim itself — the
  // rewrite pass handles that when scope.phase is partial. This
  // just annotates.
  const disclaimer =
    `_(Initial reading — based on ${sourceReadsCount} source file${sourceReadsCount === 1 ? "" : "s"}; ` +
    `architectural statements below are preliminary and may be incomplete.)_\n\n`;
  return { text: disclaimer + text, underfloor: true };
}
