// KCode - Prompt Analysis
// Extracted from conversation.ts — heuristic analysis of prompts and responses

/**
 * Heuristic: does the text look like it was cut off mid-sentence?
 * Catches responses that end in prepositions, articles, open brackets, etc.
 */
export function looksIncomplete(text: string): boolean {
  if (text.length < 5) return false;
  const trimmed = text.trimEnd();
  // Ends with an open code block that was never closed
  const openFences = (trimmed.match(/```/g) || []).length;
  if (openFences % 2 !== 0) return true;
  // Ends with an open table row
  if (trimmed.endsWith("|")) return true;
  // Ends with a hyphen (word split mid-token: "preser-", "no-de")
  if (/[-–—]\s*$/.test(trimmed)) return true;
  // Ends with open bracket/paren (unclosed expression)
  if (/[([{]\s*$/.test(trimmed)) return true;
  // Ends with a backtick (broken inline code)
  if (/`\s*$/.test(trimmed) && openFences % 2 === 0) return true;
  // Ends with a single letter (truncated mid-word: "Next.js 15 c", "la")
  if (/\s[a-zA-ZáéíóúñÁÉÍÓÚÑ]$/.test(trimmed)) return true;
  // Ends with a number not followed by terminal punctuation (truncated mid-sentence: "total 4", "total=45")
  if (/\d$/.test(trimmed) && !/[.!?:;)%]$/.test(trimmed)) return true;
  // Last word looks like a truncated prefix (2-4 chars, no punctuation, not a common word)
  const lastWord = trimmed.match(/(\S+)\s*$/)?.[1] ?? "";
  if (lastWord.length >= 2 && lastWord.length <= 4 && /^[a-zA-Z]+$/.test(lastWord)) {
    const commonShortWords = new Set([
      "ok",
      "yes",
      "is",
      "it",
      "or",
      "if",
      "do",
      "so",
      "go",
      "at",
      "be",
      "we",
      "he",
      "up",
      "by",
      "my",
      "me",
      "us",
      "am",
      "oh",
      "ya",
    ]);
    if (!commonShortWords.has(lastWord.toLowerCase()) && !/[.!?:;)]$/.test(trimmed)) return true;
  }
  // Ends mid-sentence: preposition, article, conjunction (English + Spanish)
  const lastLine = trimmed.split("\n").pop() ?? "";
  const midSentenceEndings = new RegExp(
    "\\b(" +
      // English
      "the|a|an|of|in|to|for|with|and|or|but|that|is|are|was|from|by|as|at|on|into|" +
      "not only|not just|rather|although|because|since|while|whereas|however|" +
      "this|these|which|where|when|how|if|than|between|through|about|over|under|" +
      "provides?|contains?|includes?|requires?|ensures?|means|implies|suggests|" +
      // Spanish
      "del?|la|los|las|un|una|unos|unas|en|para|con|sin|sobre|entre|que|como|" +
      "sino|aunque|porque|mientras|según|también|además|entonces|pero|ni|" +
      "mediante|donde|cuando|hacia|desde|hasta|por|al|su|sus|este|esta|estos|estas|" +
      "ya que|dado que|puesto que|siempre que|a menos que|no solo|no sólo|" +
      "preserva|caracteriza|reduce|incluye|requiere|permite|genera|produce|define|" +
      // French/Portuguese common
      "le|les|des|du|dans|avec|pour|sur|sous|qui|dont|mais|donc|" +
      "ou|et|das|dos|nas|nos|pelo|pela|uma|com|sem|sobre" +
      ")\\s*$",
    "i",
  );
  if (midSentenceEndings.test(lastLine)) return true;
  return false;
}

/**
 * Simple language detection by keyword frequency.
 */
export function detectLanguage(text: string): "es" | "fr" | "pt" | "en" {
  const lower = text.toLowerCase();
  const es = (
    lower.match(
      /\b(que|del?|para|con|por|como|una?|los?|las?|sobre|entre|desde|hasta|también|puede|tiene|cada|este|esta|demuestra|dado|propón|diseña)\b/g,
    ) || []
  ).length;
  const fr = (
    lower.match(
      /\b(les?|des|une?|dans|pour|avec|qui|sur|sont|cette|aussi|peut|chaque|mais|donc)\b/g,
    ) || []
  ).length;
  const pt = (
    lower.match(
      /\b(uma?|dos?|das?|para|com|que|sobre|entre|desde|também|pode|cada|este|esta)\b/g,
    ) || []
  ).length;
  if (es > fr && es > pt && es >= 3) return "es";
  if (fr > es && fr > pt && fr >= 3) return "fr";
  if (pt > es && pt > fr && pt >= 3) return "pt";
  return "en";
}

/**
 * Heuristic: does the prompt look like a theoretical/formal question
 * that should be answered with text only, no tools?
 */
export function looksTheoretical(prompt: string): boolean {
  const lower = prompt.toLowerCase();

  // ── Strong signals: formal proof/analysis language ──────────
  const strongPatterns = [
    /\bdemuestra\s+(formalmente|que)\b/,
    /\bprove\s+(that|formally)\b/,
    /\bdemostrar\s+que\b/,
    /\bformal(ly)?\s+(prove|verify|demonstrate|analysis)\b/,
    /\breducible\s+(al?|to)\b/,
    /\bdecidib(le|ility)\b/,
    /\bequivalencia\s+observacional\b/,
    /\bobservational\s+equivalence\b/,
    /\balgorit(hm|mo)\s+(que|that|which)\b.*\b(decid|optim|preserv)/,
    /\bcaracteriza\s+(el|bajo|the)\b/,
    /\bcharacterize\s+(the|under|when)\b/,
    /\bespacio\s+de\s+trade-?offs\b/,
    /\btrade-?off\s+space\b/,
    /\bsistema\s+de\s+transici[oó]n\b/,
    /\btransition\s+system\b/,
  ];
  if (strongPatterns.some((p) => p.test(lower))) return true;

  // ── Structured reasoning prompt: long, multiline, with sections ──
  const hasStructuredSections =
    /^#{2,4}\s+/m.test(prompt) ||
    /\bparte\s+\d/i.test(prompt) ||
    /\b(task|tarea)\s*\d/i.test(prompt);
  const hasDataTables = /\|.*\|.*\|/m.test(prompt);
  const hasReasoningKeywords = [
    "razonamiento",
    "reasoning",
    "paso a paso",
    "step by step",
    "trade-off",
    "contraejemplo",
    "counterexample",
    "diagnóstico",
    "diagnostic",
    "optimización",
    "optimization",
    "consistencia",
    "consistency",
    "meta razonamiento",
    "meta reasoning",
    "maximizar",
    "maximize",
    "minimizar",
    "minimize",
  ].filter((kw) => lower.includes(kw)).length;

  if (prompt.length > 500 && hasStructuredSections && hasReasoningKeywords >= 1) return true;
  if (hasDataTables && hasReasoningKeywords >= 2) return true;

  // ── Moderate signals: multiple formal keywords ─────────────
  const formalKeywords = [
    "demuestra",
    "prove",
    "formalmente",
    "formally",
    "reducible",
    "decidible",
    "decidability",
    "equivalencia",
    "equivalence",
    "alcanzabilidad",
    "reachability",
    "idempotent",
    "append-only",
    "subsecuencia",
    "subsequence",
    "compaction",
    "preservar",
    "filesystem",
    "tool calls",
    "restricciones",
    "constraints",
  ];
  const matches = formalKeywords.filter((kw) => lower.includes(kw));
  if (matches.length >= 3) return true;

  return false;
}

/**
 * Detect if the user is requesting staged/incremental execution
 * (i.e., "do the first step and show me", "just the initial structure").
 * When detected, KCode should stop after completing that stage.
 */
export function looksCheckpointed(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  const patterns = [
    /\b(primer|first)\s+(paso|step)\b/,
    /\b(estructura|structure)\s+(inicial|initial|base|básica)\b/,
    /\b(solo|only|just)\s+(la base|the base|el setup|the setup|el esqueleto|the skeleton)\b/,
    /\bmuéstrame\s+(cuando|el resultado|qué hiciste)\b/,
    /\bshow\s+me\s+when\s+(done|finished|ready)\b/,
    /\bcuando\s+termines\b/,
    /\bhaz\s+primero\b/,
    /\bstart\s+with\b.*\b(then|and)\s+(show|tell|stop)\b/,
    /\bsolo\s+(la|el|las|los)\s+\w+\s+(inicial|base|primero|first)\b/,
    /\b(empieza|empezá|comienza|comenzá)\s+(con|por)\b.*\b(muéstrame|y\s+par[áa])\b/,
    /\b(start|begin)\s+(with|by)\b.*\b(show|stop|then)\b/,
  ];
  return patterns.some((p) => p.test(lower));
}

/**
 * Strip overlapping content between a previous response tail and a continuation.
 * Uses line-level matching first, then falls back to char-level.
 * Returns the cleaned continuation text.
 */
export function dedupContinuation(previousTail: string, continuation: string): string {
  if (previousTail.length === 0 || continuation.length === 0) return continuation;

  // Line-level dedup: check if continuation starts with lines from the tail
  const tailLines = previousTail.split("\n");
  const newLines = continuation.split("\n");
  if (tailLines.length >= 2 && newLines.length >= 2) {
    for (let i = 0; i < Math.min(newLines.length, 10); i++) {
      const line = newLines[i]!.trim();
      if (line.length < 10) continue;
      const tailIdx = tailLines.findIndex((tl) => tl.trim() === line);
      if (tailIdx >= 0 && tailIdx >= tailLines.length - 10) {
        const remainingTailLines = tailLines.length - tailIdx;
        const stripCount = Math.min(remainingTailLines, newLines.length);
        return newLines.slice(stripCount).join("\n").trim();
      }
    }
  }

  // Char-level dedup fallback
  const tailToMatch = previousTail.slice(-200);
  for (
    let overlapLen = Math.min(tailToMatch.length, continuation.length);
    overlapLen >= 20;
    overlapLen--
  ) {
    const tailSuffix = tailToMatch.slice(-overlapLen);
    if (continuation.startsWith(tailSuffix)) {
      return continuation.slice(overlapLen);
    }
  }

  return continuation;
}
