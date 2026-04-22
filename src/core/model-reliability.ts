// KCode - Per-session model reliability tracking
//
// Tracks per-model hallucination/failure counts within a session so the
// router can avoid models that repeatedly emit malformed output. Resets
// at session start — doesn't persist, since model behavior can change
// with provider updates and we don't want permanent blacklists.
//
// Current signals:
//   - Tool-format hallucination: model emitted tool calls as text (XML,
//     Python, JSON block) instead of using the native tool_calls field.
//     Happens with grok-4-1-fast-reasoning and some local models.
//   - Reasoning loop: model entered low-entropy repetition loop.
//   - Empty response: model returned nothing multiple turns in a row.

import { log } from "./logger";

const HALLUCINATION_BLACKLIST_THRESHOLD = 2;

// Keyed by model name. Counters reset on session boundary (via resetReliability).
const hallucinationCounts = new Map<string, number>();
const reasoningLoopCounts = new Map<string, number>();
const blacklisted = new Set<string>();
let currentModel: string | null = null;

/** Set the model being used for the next turn (called from router/orchestrator). */
export function setActiveModel(model: string): void {
  currentModel = model;
}

/** Called when a tool-format hallucination is detected (XML/Python/JSON block). */
export function recordToolHallucination(): void {
  if (!currentModel) return;
  const next = (hallucinationCounts.get(currentModel) ?? 0) + 1;
  hallucinationCounts.set(currentModel, next);
  log.warn(
    "model-reliability",
    `${currentModel} emitted tool calls as text (hallucination #${next}) — rescued via extractor`,
  );
  if (next >= HALLUCINATION_BLACKLIST_THRESHOLD && !blacklisted.has(currentModel)) {
    blacklisted.add(currentModel);
    log.warn(
      "model-reliability",
      `${currentModel} hit ${HALLUCINATION_BLACKLIST_THRESHOLD} tool-format hallucinations — blacklisted for this session`,
    );
  }
}

/** Called when a reasoning loop is detected. */
export function recordReasoningLoop(): void {
  if (!currentModel) return;
  const next = (reasoningLoopCounts.get(currentModel) ?? 0) + 1;
  reasoningLoopCounts.set(currentModel, next);
  if (next >= 3 && !blacklisted.has(currentModel)) {
    blacklisted.add(currentModel);
    log.warn(
      "model-reliability",
      `${currentModel} hit 3 reasoning loops — blacklisted for this session`,
    );
  }
}

/** Is this model blacklisted in the current session? */
export function isBlacklisted(model: string): boolean {
  return blacklisted.has(model);
}

/** Get a diagnostic summary for display. */
export function getReliabilityReport(): Array<{
  model: string;
  hallucinations: number;
  reasoningLoops: number;
  blacklisted: boolean;
}> {
  const models = new Set([
    ...hallucinationCounts.keys(),
    ...reasoningLoopCounts.keys(),
  ]);
  return [...models].map((m) => ({
    model: m,
    hallucinations: hallucinationCounts.get(m) ?? 0,
    reasoningLoops: reasoningLoopCounts.get(m) ?? 0,
    blacklisted: blacklisted.has(m),
  }));
}

/** Reset all tracking — called at session start. */
export function resetReliability(): void {
  hallucinationCounts.clear();
  reasoningLoopCounts.clear();
  blacklisted.clear();
  currentModel = null;
}
