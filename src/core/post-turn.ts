// KCode - Post-Turn Processing
// Extracted from conversation.ts — side effects after the model responds:
// response caching, knowledge distillation, benchmark scoring, suggestions, notifications

import { initBenchmarkSchema, saveBenchmark, scoreResponse } from "./benchmarks";
import { extractExample, saveExample } from "./distillation";
import type { Suggestion } from "./intentions";
import { getIntentionEngine } from "./intentions";
import { log } from "./logger";
import { generateCacheKey, setCachedResponse } from "./response-cache";
import type { ConversationState, Message, StreamEvent, TextBlock } from "./types";

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
  if (!cacheKey || stopReason !== "end_turn" || toolCallCount > 0 || textChunks.length === 0)
    return;

  try {
    const fullText = textChunks.join("");
    const lastUserMsg = messages.filter((m) => m.role === "user").pop();
    const preview = lastUserMsg
      ? typeof lastUserMsg.content === "string"
        ? lastUserMsg.content
        : ""
      : "";
    setCachedResponse(cacheKey, model, preview, fullText, tokenCount);
  } catch (err) {
    log.debug("cache", "Failed to cache response: " + err);
  }
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
  } catch (err) {
    log.debug("distillation", "Failed to extract distillation example: " + err);
  }

  // Benchmark scoring
  try {
    initBenchmarkSchema();
    const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
    const responseText = lastAssistant
      ? typeof lastAssistant.content === "string"
        ? lastAssistant.content
        : lastAssistant.content
            .filter((b): b is TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("")
      : "";
    const errorCount = messages.filter(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === "tool_result" && b.is_error),
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
  } catch (err) {
    log.debug("benchmark", "Failed to score/save benchmark: " + err);
  }
}

/**
 * Evaluate intention engine suggestions and check for auto-continue conditions.
 * Returns the suggestions array and whether there's a high-priority suggestion.
 */
export function evaluateIntentionSuggestions(): {
  suggestions: Suggestion[];
  hasHighPrioritySuggestion: boolean;
} {
  try {
    const suggestions = getIntentionEngine().evaluate();
    const hasHighPrioritySuggestion = suggestions.some(
      (s) => s.priority === "high" && s.type === "verify",
    );
    return { suggestions, hasHighPrioritySuggestion };
  } catch (err) {
    log.debug("intention", "Failed to evaluate intention suggestions: " + err);
    return { suggestions: [], hasHighPrioritySuggestion: false };
  }
}

/**
 * Send a desktop notification (Linux: notify-send, macOS: osascript).
 *
 * Uses spawnSync with array args so the shell never parses title/body —
 * this eliminates shell-injection risk even for hostile Unicode input.
 */
export function sendDesktopNotification(title: string, body: string): void {
  try {
    const { spawnSync } = require("node:child_process");
    if (process.platform === "linux") {
      spawnSync("notify-send", [title, body], {
        timeout: 3000,
        stdio: "ignore",
        shell: false,
      });
    } else if (process.platform === "darwin") {
      // osascript still interprets the -e arg as AppleScript, so escape
      // backslashes and double-quotes inside the AppleScript string literals.
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const script = `display notification "${esc(body)}" with title "${esc(title)}"`;
      spawnSync("osascript", ["-e", script], {
        timeout: 3000,
        stdio: "ignore",
        shell: false,
      });
    }
  } catch (err) {
    log.debug("notify", "Failed to send desktop notification: " + err);
  }
}
