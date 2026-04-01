// KCode - Ensemble Voting System
// Implements heuristic and judge-based scoring for candidate responses.

import type { Message } from "../types";
import type { CandidateResponse, EnsembleResult, ModelExecutor } from "./types";

// ─── Heuristic Scoring ──────────────────────────────────────────

/** Patterns indicating uncertainty or refusal */
const UNCERTAINTY_PATTERNS = [
  /\bi don'?t know\b/i,
  /\bi'?m not sure\b/i,
  /\bi cannot\b/i,
  /\bi can'?t\b/i,
  /\bunable to\b/i,
  /\bno idea\b/i,
];

/** Patterns indicating JSON/syntax errors in responses */
const ERROR_PATTERNS = [/SyntaxError/, /Unexpected token/, /Parse error/, /Invalid JSON/i];

/**
 * Score a candidate response using heuristics (no judge model needed).
 *
 * Scoring rules:
 *  +2  if response contains valid tool_calls JSON
 *  +1  per 100 chars of response (up to +5 at 500 chars)
 *  -1  if response contains uncertainty/refusal patterns
 *  -2  if response contains JSON/syntax error patterns
 *  -1  if response is highly repetitive (compression ratio check)
 */
export function scoreCandidate(candidate: CandidateResponse): number {
  const text = candidate.response;
  let score = 0;

  // +2 for valid tool_calls JSON
  if (hasValidToolCalls(text)) {
    score += 2;
  }

  // +1 per 100 chars, capped at +5
  const lengthScore = Math.min(5, Math.floor(text.length / 100));
  score += lengthScore;

  // -1 for uncertainty patterns
  for (const pattern of UNCERTAINTY_PATTERNS) {
    if (pattern.test(text)) {
      score -= 1;
      break; // Only penalize once
    }
  }

  // -2 for error patterns
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(text)) {
      score -= 2;
      break;
    }
  }

  // -1 for highly repetitive content
  if (isRepetitive(text)) {
    score -= 1;
  }

  return score;
}

/**
 * Check if response text contains valid tool call JSON.
 * Looks for common tool_calls patterns in both OpenAI and Anthropic formats.
 */
export function hasValidToolCalls(text: string): boolean {
  // Look for tool_use blocks or function call JSON
  const patterns = [
    /\{"type"\s*:\s*"tool_use"/,
    /\{"name"\s*:\s*"[^"]+"\s*,\s*"arguments"/,
    /```json\s*\n\s*\{[\s\S]*?"tool_use"/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      // Try to extract and parse the JSON to verify it's valid
      try {
        const jsonStart = text.indexOf("{", match.index ?? 0);
        const jsonEnd = findMatchingBrace(text, jsonStart);
        if (jsonEnd > jsonStart) {
          JSON.parse(text.slice(jsonStart, jsonEnd + 1));
          return true;
        }
      } catch {
        // JSON was invalid, don't count it
      }
    }
  }
  return false;
}

/**
 * Detect highly repetitive text by checking for repeated phrases.
 */
export function isRepetitive(text: string): boolean {
  if (text.length < 100) return false;

  // Split into sentences and check for duplicates
  const sentences = text
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
  if (sentences.length < 3) return false;

  const unique = new Set(sentences);
  // If more than 50% of sentences are duplicates, it's repetitive
  return unique.size < sentences.length * 0.5;
}

/**
 * Find the matching closing brace for a JSON object.
 */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

// ─── Heuristic Selection ────────────────────────────────────────

/**
 * Select the best candidate using heuristic scoring (no judge model).
 */
export function heuristicSelect(candidates: CandidateResponse[]): EnsembleResult {
  const scored = candidates.map((c) => ({
    ...c,
    score: scoreCandidate(c),
  }));

  // Sort by score descending, break ties by shorter duration
  scored.sort((a, b) => b.score! - a.score! || a.durationMs - b.durationMs);

  const best = scored[0]!;
  return {
    finalResponse: best.response,
    strategy: "best-of-n",
    candidates: scored,
    reasoning: `Heuristic selection: best score ${best.score} (model: ${best.model})`,
  };
}

// ─── Judge Selection ────────────────────────────────────────────

/**
 * Select the best candidate using a judge model to evaluate responses.
 */
export async function judgeSelect(
  candidates: CandidateResponse[],
  judgeModel: string,
  originalQuery: Message[],
  executor: ModelExecutor,
): Promise<EnsembleResult> {
  // Build the judge prompt
  const queryText = originalQuery
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");

  const judgePrompt = [
    `You are a quality judge. You are presented with ${candidates.length} responses to the same question.`,
    `Evaluate each by: correctness, completeness, clarity, and usefulness.`,
    `Respond ONLY with the number of the best response (1-${candidates.length}) and a brief reason.`,
    ``,
    `ORIGINAL QUESTION:`,
    queryText,
    ``,
    ...candidates
      .map((c, i) => `RESPONSE ${i + 1} (${c.model}):\n${c.response}`)
      .join("\n---\n")
      .split("\n"),
  ]
    .join("\n")
    .trim();

  try {
    const judgeResult = await executor.execute(
      judgeModel,
      [{ role: "user", content: judgePrompt }],
      200,
    );

    // Parse the judge's response to extract the selected number
    const match = judgeResult.content.match(/(\d+)/);
    const selectedIndex = match ? Math.min(parseInt(match[1]!) - 1, candidates.length - 1) : 0;
    const clampedIndex = Math.max(0, selectedIndex);

    return {
      finalResponse: candidates[clampedIndex]!.response,
      strategy: "best-of-n",
      candidates: candidates.map((c, i) => ({
        ...c,
        score: i === clampedIndex ? 1.0 : 0.0,
      })),
      reasoning: judgeResult.content,
    };
  } catch {
    // If judge fails, fall back to heuristic selection
    return heuristicSelect(candidates);
  }
}

// ─── Majority Vote ──────────────────────────────────────────────

/**
 * Select the response that appears most frequently (for discrete answers).
 * Normalizes responses by trimming whitespace and lowering case for comparison.
 */
export function majorityVote(candidates: CandidateResponse[]): EnsembleResult {
  // Normalize and count occurrences
  const counts = new Map<string, { count: number; original: CandidateResponse }>();

  for (const candidate of candidates) {
    const normalized = candidate.response.trim().toLowerCase();
    const existing = counts.get(normalized);
    if (existing) {
      existing.count++;
    } else {
      counts.set(normalized, { count: 1, original: candidate });
    }
  }

  // Find the most common response
  let best = { count: 0, original: candidates[0]! };
  for (const entry of counts.values()) {
    if (entry.count > best.count) {
      best = entry;
    }
  }

  return {
    finalResponse: best.original.response,
    strategy: "majority-vote",
    candidates: candidates.map((c) => ({
      ...c,
      score:
        c.response.trim().toLowerCase() === best.original.response.trim().toLowerCase() ? 1.0 : 0.0,
    })),
    reasoning: `Majority vote: "${best.original.model}" response appeared ${best.count}/${candidates.length} times`,
  };
}
