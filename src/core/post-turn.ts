// KCode - Post-Turn Processing
// Extracted from conversation.ts — side effects after the model responds:
// response caching, knowledge distillation, benchmark scoring, suggestions, notifications

import type { Message, StreamEvent, ConversationState } from "./types";
import { log } from "./logger";
import { getIntentionEngine } from "./intentions";
import type { Suggestion } from "./intentions";
import { extractExample, saveExample } from "./distillation";
import { scoreResponse, saveBenchmark, initBenchmarkSchema } from "./benchmarks";
import { generateCacheKey, setCachedResponse } from "./response-cache";

// ─── Post-Turn Processing ────────────────────────────────────────

export interface PostTurnContext {
  model: string;
  workingDirectory: string;
  noCache?: boolean;
  thinking?: boolean;
}

/**
 * Cache the text-only response if caching is enabled.
 */
export function cacheResponseIfEligible(
  cacheKey: string,
  stopReason: string,
  toolCallCount: number,
  textChunks: string[],
  model: string,
  messages: Message[],
  tokenCount: number,
): void {
  if (!cacheKey || stopReason !== "end_turn" || toolCallCount > 0 || textChunks.length === 0) return;

  try {
    const fullText = textChunks.join("");
    const lastUserMsg = messages.filter(m => m.role === "user").pop();
    const preview = lastUserMsg
      ? (typeof lastUserMsg.content === "string" ? lastUserMsg.content : "")
      : "";
    setCachedResponse(cacheKey, model, preview, fullText, tokenCount);
  } catch (err) { log.debug("cache", "Failed to cache response: " + err); }
}

/**
 * Run knowledge distillation and benchmark scoring after a successful turn.
 */
export function processKnowledgeAndBenchmark(
  stopReason: string,
  turnCount: number,
  messages: Message[],
  workingDirectory: string,
  model: string,
  toolUseCount: number,
  tokenCount: number,
): void {
  if (stopReason !== "end_turn" || turnCount < 1) return;

  // Knowledge distillation
  try {
    const example = extractExample(messages, workingDirectory);
    if (example) saveExample(example);
  } catch (err) { log.debug("distillation", "Failed to extract distillation example: " + err); }

  // Benchmark scoring
  try {
    initBenchmarkSchema();
    const lastAssistant = messages.filter(m => m.role === "assistant").pop();
    const responseText = lastAssistant
      ? (typeof lastAssistant.content === "string" ? lastAssistant.content : lastAssistant.content.filter(b => b.type === "text").map(b => (b as any).text).join(""))
      : "";
    const errorCount = messages.filter(m =>
      m.role === "assistant" && Array.isArray(m.content) &&
      m.content.some(b => b.type === "tool_result" && b.is_error)
    ).length;
    const score = scoreResponse({
      response: responseText,
      toolsUsed: toolUseCount,
      errorsEncountered: errorCount,
      taskCompleted: stopReason === "end_turn",
      turnCount,
    });
    saveBenchmark({
      model,
      taskType: "general",
      score,
      tokensUsed: tokenCount,
      latencyMs: 0,
      details: { turns: turnCount, tools: toolUseCount },
    });
  } catch (err) { log.debug("benchmark", "Failed to score/save benchmark: " + err); }
}

/**
 * Evaluate intention engine suggestions and check for auto-continue conditions.
 * Returns the suggestions array and whether there's a high-priority suggestion.
 */
export function evaluateIntentionSuggestions(): { suggestions: Suggestion[]; hasHighPrioritySuggestion: boolean } {
  try {
    const suggestions = getIntentionEngine().evaluate();
    const hasHighPrioritySuggestion = suggestions.some(s => s.priority === "high" && s.type === "verify");
    return { suggestions, hasHighPrioritySuggestion };
  } catch (err) {
    log.debug("intention", "Failed to evaluate intention suggestions: " + err);
    return { suggestions: [], hasHighPrioritySuggestion: false };
  }
}

/**
 * Send a desktop notification (Linux: notify-send, macOS: osascript).
 */
export function sendDesktopNotification(title: string, body: string): void {
  try {
    // Strip anything that could break shell quoting
    const safeTitle = title.replace(/[^a-zA-Z0-9 _.!?-]/g, "");
    const safeBody = body.replace(/[^a-zA-Z0-9 _.!?:,()-]/g, "");
    const { execSync } = require("node:child_process");
    if (process.platform === "linux") {
      execSync(`notify-send "${safeTitle}" "${safeBody}" 2>/dev/null`, { timeout: 3000 });
    } else if (process.platform === "darwin") {
      execSync(`osascript -e 'display notification "${safeBody}" with title "${safeTitle}"' 2>/dev/null`, { timeout: 3000 });
    }
  } catch (err) {
    log.debug("notify", "Failed to send desktop notification: " + err);
  }
}
