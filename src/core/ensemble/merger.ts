// KCode - Ensemble Response Merger
// Combines parts of multiple model responses into a single coherent response.

import type { Message } from "../types";
import type { CandidateResponse, EnsembleResult, ModelExecutor } from "./types";

// ─── Section-Based Merge ────────────────────────────────────────

interface ResponseSection {
  heading: string;
  content: string;
  source: string; // model name
}

/**
 * Extract sections from a response based on markdown headings or paragraph structure.
 */
export function extractSections(response: string, modelName: string): ResponseSection[] {
  const sections: ResponseSection[] = [];

  // Try markdown heading-based splitting first
  const headingParts = response.split(/^(#{1,3}\s+.+)$/m);

  if (headingParts.length > 2) {
    // Has markdown headings
    for (let i = 1; i < headingParts.length; i += 2) {
      const heading = headingParts[i]?.replace(/^#+\s+/, "").trim() ?? "";
      const content = headingParts[i + 1]?.trim() ?? "";
      if (content) {
        sections.push({ heading, content, source: modelName });
      }
    }
    // Include any preamble before the first heading
    const preamble = headingParts[0]?.trim();
    if (preamble) {
      sections.unshift({ heading: "introduction", content: preamble, source: modelName });
    }
  } else {
    // No headings; split by double-newline paragraphs
    const paragraphs = response.split(/\n\n+/).filter((p) => p.trim());
    for (let i = 0; i < paragraphs.length; i++) {
      sections.push({
        heading: `section-${i + 1}`,
        content: paragraphs[i]!.trim(),
        source: modelName,
      });
    }
  }

  return sections;
}

/**
 * Score a section based on quality heuristics.
 * Higher is better.
 */
export function scoreSection(section: ResponseSection): number {
  let score = 0;
  const text = section.content;

  // Length bonus (prefer substantive sections, up to 500 chars)
  score += Math.min(5, Math.floor(text.length / 100));

  // Code block bonus
  if (/```[\s\S]*?```/.test(text)) {
    score += 3;
  }

  // Concrete examples bonus
  if (/for example|e\.g\.|such as|like this/i.test(text)) {
    score += 1;
  }

  // Penalty for filler language
  if (/\b(basically|simply|just|really|actually)\b/i.test(text)) {
    score -= 1;
  }

  return score;
}

/**
 * Merge responses by selecting the best sections from each candidate.
 * Groups sections by similar headings and picks the highest-scored version.
 */
export function mergeSections(candidates: CandidateResponse[]): EnsembleResult {
  // Extract sections from all candidates
  const allSections: ResponseSection[][] = candidates.map((c) =>
    extractSections(c.response, c.model),
  );

  // If no candidates have structured sections, fall back to best overall
  if (allSections.every((s) => s.length <= 1)) {
    const scored = candidates.map((c) => ({
      ...c,
      score: Math.min(5, Math.floor(c.response.length / 100)),
    }));
    scored.sort((a, b) => b.score! - a.score!);
    return {
      finalResponse: scored[0]!.response,
      strategy: "merge",
      candidates: scored,
      reasoning: "No structured sections found; selected the most substantive response",
    };
  }

  // Build a merged response by picking the best version of each section
  const sectionGroups = new Map<string, ResponseSection[]>();

  for (const sections of allSections) {
    for (const section of sections) {
      const key = normalizeHeading(section.heading);
      const group = sectionGroups.get(key) ?? [];
      group.push(section);
      sectionGroups.set(key, group);
    }
  }

  const mergedParts: string[] = [];
  const sourcesUsed = new Set<string>();

  for (const [_key, group] of sectionGroups) {
    // Pick the best section in this group
    const scored = group.map((s) => ({ section: s, score: scoreSection(s) }));
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]!;
    mergedParts.push(best.section.content);
    sourcesUsed.add(best.section.source);
  }

  const finalResponse = mergedParts.join("\n\n");

  return {
    finalResponse,
    strategy: "merge",
    candidates: candidates.map((c) => ({
      ...c,
      score: sourcesUsed.has(c.model) ? 1.0 : 0.0,
    })),
    reasoning: `Merged best sections from ${sourcesUsed.size} model(s): ${[...sourcesUsed].join(", ")}`,
  };
}

/**
 * Normalize a heading for grouping (lowercase, strip non-alpha).
 */
function normalizeHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── LLM-Based Merge ───────────────────────────────────────────

/**
 * Use a judge model to intelligently merge multiple responses.
 * The judge receives all candidate responses and produces a combined answer.
 */
export async function llmMerge(
  candidates: CandidateResponse[],
  originalQuery: Message[],
  mergeModel: string,
  executor: ModelExecutor,
): Promise<EnsembleResult> {
  const queryText = originalQuery
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");

  const mergePrompt = [
    `You are given ${candidates.length} responses to the same question.`,
    `Combine the best parts of each response into a single, comprehensive answer.`,
    `Do NOT mention that there were multiple responses. Write as if you are giving a single authoritative answer.`,
    ``,
    `ORIGINAL QUESTION:`,
    queryText,
    ``,
    ...candidates.map((c, i) => `RESPONSE ${i + 1} (${c.model}):\n${c.response}`),
  ]
    .join("\n")
    .trim();

  try {
    const result = await executor.execute(
      mergeModel,
      [{ role: "user", content: mergePrompt }],
      4096,
    );

    return {
      finalResponse: result.content,
      strategy: "merge",
      candidates: candidates.map((c) => ({ ...c, score: 0.5 })),
      reasoning: `LLM-merged response using ${mergeModel}`,
    };
  } catch {
    // Fall back to section-based merge
    return mergeSections(candidates);
  }
}
