// KCode - Post-Turn Processing
// Extracted from conversation.ts runAgentLoop — handles the "no tool calls" path:
// max_tokens continuation, empty response retry, truncation detection, auto-memory,
// stop hooks, notifications, and response session close.

import { getMemoryTitles, runAutoMemoryExtraction } from "./auto-memory/extractor";
import { parseAutoMemoryConfig } from "./auto-memory/types";
import type { HookManager } from "./hooks";
import { log } from "./logger";
import {
  cacheResponseIfEligible,
  evaluateIntentionSuggestions,
  processKnowledgeAndBenchmark,
  sendDesktopNotification,
} from "./post-turn";
import { looksIncomplete } from "./prompt-analysis";
import type { ContentBlock, KCodeConfig, Message, StreamEvent } from "./types";

// ─── Types ──────────────────────────────────────────────────────

export interface PostTurnContext {
  config: KCodeConfig;
  hooks: HookManager;
  messages: Message[];
  toolUseCount: number;
  tokenCount: number;
  turnStartMs: number;
  turnCount: number;
  turnsSinceLastExtraction: number;
  cacheKey: string;
  stopReason: string;
  textChunks: string[];
  thinkingChunks: string[];
  toolCalls: { name: string }[];
  previousTurnTail: string;

  /** Guard state fields */
  maxTokensContinuations: number;
  emptyEndTurnCount: number;
  truncationRetries: number;
  lastEmptyType: "thinking_only" | "tools_only" | "thinking_and_tools" | "no_output" | undefined;

  /** Debug tracer (optional) */
  debugTracer?: { isEnabled(): boolean; trace(category: string, event: string, detail: string, meta?: Record<string, unknown>): void } | null;

  /** Callback to collect session data for partial progress */
  collectSessionData: () => {
    filesModified: string[];
    errorsEncountered: number;
  };
}

export interface PostTurnResult {
  /** What to do next: "break" ends the loop, "continue" loops, "fall_through" means nothing matched */
  action: "break" | "continue" | "fall_through";
  events: StreamEvent[];
  /** Messages to inject into conversation history */
  injectMessages: Message[];
  /** Updated guard state */
  maxTokensContinuations: number;
  emptyEndTurnCount: number;
  truncationRetries: number;
  lastEmptyType: "thinking_only" | "tools_only" | "thinking_and_tools" | "no_output" | undefined;
  previousTurnTail: string;
  turnsSinceLastExtraction: number;
}

// ─── Main Post-Turn Handler ─────────────────────────────────────

/**
 * Handle the "no tool calls" path in the agent loop.
 * This covers: max_tokens continuation, intention suggestions with auto-continue,
 * response caching, knowledge distillation, empty response retry, truncation detection,
 * stop hooks, notifications, partial progress, response session close, and auto-memory.
 *
 * Returns a PostTurnResult describing the action and any events/messages to emit.
 */
export async function handlePostTurn(ctx: PostTurnContext): Promise<PostTurnResult> {
  const events: StreamEvent[] = [];
  const injectMessages: Message[] = [];
  let {
    maxTokensContinuations,
    emptyEndTurnCount,
    truncationRetries,
    lastEmptyType,
    previousTurnTail,
    turnsSinceLastExtraction,
  } = ctx;

  // Auto-continue on max_tokens
  if (ctx.stopReason === "max_tokens" && maxTokensContinuations < 3) {
    maxTokensContinuations++;
    log.info(
      "session",
      `Model hit output token limit (continuation ${maxTokensContinuations}/3) — injecting continue prompt`,
    );
    if (ctx.debugTracer?.isEnabled()) {
      ctx.debugTracer.trace(
        "decision",
        `max_tokens continuation ${maxTokensContinuations}/3`,
        "Model output was truncated, auto-continuing",
        { turn: ctx.turnCount },
      );
    }
    injectMessages.push({
      role: "user",
      content:
        "[SYSTEM] Your previous response was cut off because you hit the output token limit. Continue EXACTLY where you left off. Do not repeat what you already said — pick up mid-sentence if needed.",
    });
    events.push({ type: "turn_end", stopReason: "max_tokens_continue" });
    return {
      action: "continue",
      events,
      injectMessages,
      maxTokensContinuations,
      emptyEndTurnCount,
      truncationRetries,
      lastEmptyType,
      previousTurnTail,
      turnsSinceLastExtraction,
    };
  }

  // Layer 9: Evaluate intentions and emit suggestions (delegated to post-turn)
  const { suggestions, hasHighPrioritySuggestion } = evaluateIntentionSuggestions();
  if (suggestions.length > 0) {
    events.push({ type: "suggestion", suggestions });
  }

  // Auto-continue: if the model stopped but has incomplete tasks, push it to continue
  if (hasHighPrioritySuggestion && ctx.turnCount <= 3) {
    log.info("session", "Auto-continuing: model stopped with incomplete tasks");
    injectMessages.push({
      role: "user",
      content:
        "You stopped before completing the task. Continue working — create the actual files and finish what you planned. Do not re-plan, just execute.",
    });
    events.push({ type: "turn_end", stopReason: ctx.stopReason });
    return {
      action: "continue",
      events,
      injectMessages,
      maxTokensContinuations,
      emptyEndTurnCount,
      truncationRetries,
      lastEmptyType,
      previousTurnTail,
      turnsSinceLastExtraction,
    };
  }

  // Cache text-only responses (delegated to post-turn)
  cacheResponseIfEligible(
    ctx.cacheKey,
    ctx.stopReason,
    ctx.toolCalls.length,
    ctx.textChunks,
    ctx.config.model,
    ctx.messages,
    ctx.tokenCount,
  );

  // Knowledge distillation + benchmark scoring (delegated to post-turn)
  processKnowledgeAndBenchmark(
    ctx.stopReason,
    ctx.turnCount,
    ctx.messages,
    ctx.config.workingDirectory,
    ctx.config.model,
    ctx.toolUseCount,
    ctx.tokenCount,
  );

  // Safety net: classify empty responses and retry with context-aware prompts
  const hasTextOutput = ctx.textChunks.join("").trim().length > 0;
  const hasThinkingOutput =
    ctx.thinkingChunks.length > 0 ||
    (ctx.messages.at(-1) as Record<string, unknown> | undefined)?.thinkingContent;
  const hasToolOutput = ctx.toolCalls.length > 0;

  // Classify empty responses — persisted so the final turn_end carries it
  if (!hasTextOutput && ctx.stopReason === "end_turn") {
    lastEmptyType =
      hasThinkingOutput && !hasToolOutput
        ? "thinking_only"
        : hasToolOutput && !hasThinkingOutput
          ? "tools_only"
          : hasThinkingOutput && hasToolOutput
            ? "thinking_and_tools"
            : "no_output";
  } else {
    lastEmptyType = undefined;
  }

  if (!hasTextOutput && ctx.stopReason === "end_turn" && emptyEndTurnCount < 2) {
    emptyEndTurnCount++;

    log.info(
      "session",
      `Empty response (${lastEmptyType}) on turn ${ctx.turnCount} — retry ${emptyEndTurnCount}/2`,
    );

    // Context-aware retry prompt — include what was done so the model can summarize
    const toolCount = ctx.toolUseCount;
    const retryPrompt =
      lastEmptyType === "thinking_only"
        ? "[SYSTEM] You reasoned but produced no visible answer. Stop thinking and answer the user directly in plain text now."
        : lastEmptyType === "tools_only" || toolCount > 0
          ? `[SYSTEM] You executed ${toolCount} tools but didn't provide any response text. You MUST now write a brief summary (3-6 sentences) of what you accomplished. Do NOT use any more tools — just respond with text.`
          : lastEmptyType === "thinking_and_tools"
            ? "[SYSTEM] You reasoned and used tools but gave no visible answer. Provide a direct response to the user now."
            : "[SYSTEM] Your previous turn produced no output at all. Respond directly to the user now.";

    injectMessages.push({ role: "user", content: retryPrompt });
    events.push({
      type: "turn_end",
      stopReason: "empty_response_retry",
      emptyType: lastEmptyType,
    });
    return {
      action: "continue",
      events,
      injectMessages,
      maxTokensContinuations,
      emptyEndTurnCount,
      truncationRetries,
      lastEmptyType,
      previousTurnTail,
      turnsSinceLastExtraction,
    };
  }

  // Truncation heuristic: detect suspiciously incomplete responses
  if (hasTextOutput && (ctx.stopReason === "end_turn" || ctx.stopReason === "max_tokens")) {
    let fullText = ctx.textChunks.join("").trim();

    // Dedup: if this is a continuation and the model repeated content
    if (previousTurnTail.length > 0 && fullText.length > 0) {
      const { mergeContinuation: mergeContFn } = await import("./continuation-merge.js");
      const mergeResult = mergeContFn(previousTurnTail, fullText);
      if (mergeResult.merged !== fullText) {
        log.info(
          "session",
          `Continuation merge: stripped ${mergeResult.strippedChars} chars, ${mergeResult.strippedLines} lines${mergeResult.repeatedPrefixDetected ? " (heading restart)" : ""}`,
        );
        fullText = mergeResult.merged;
        const lastMsg = ctx.messages[ctx.messages.length - 1];
        if (lastMsg?.role === "assistant" && Array.isArray(lastMsg.content)) {
          const textBlocks = (lastMsg.content as ContentBlock[]).filter(
            (b) => b.type === "text",
          );
          if (textBlocks.length > 0) {
            (textBlocks[0]! as { type: string; text: string }).text = fullText;
          }
        }
      }
    }

    if (truncationRetries < 2 && looksIncomplete(fullText)) {
      truncationRetries++;
      log.info(
        "session",
        `Response looks truncated (attempt ${truncationRetries}) — pushing for continuation`,
      );
      previousTurnTail = fullText.slice(-300);
      const tail = fullText.slice(-200);
      injectMessages.push({
        role: "user",
        content: `[SYSTEM] Your response was cut off. Here is how it ended:\n\n"…${tail}"\n\nContinue EXACTLY from that point. Do NOT repeat any previous content. Do NOT restart the response. Just write the next sentence.`,
      });
      events.push({ type: "turn_end", stopReason: "truncation_retry" });
      return {
        action: "continue",
        events,
        injectMessages,
        maxTokensContinuations,
        emptyEndTurnCount,
        truncationRetries,
        lastEmptyType,
        previousTurnTail,
        turnsSinceLastExtraction,
      };
    }

    // After all retries, if still incomplete, notify the user
    if (truncationRetries >= 2 && looksIncomplete(fullText)) {
      log.warn("session", "Response still incomplete after 2 continuation retries");
      events.push({
        type: "text_delta" as const,
        text: "\n\n---\n*[Response may be incomplete — model reached output limit]*\n",
      });
    }
  }

  // Fire Stop hook — can block the conversation from ending
  if (ctx.hooks.hasHooks("Stop")) {
    try {
      const stopResult = await ctx.hooks.runStopHook("Stop", {
        stopReason: ctx.stopReason,
        turnCount: ctx.turnCount,
        toolsUsed: ctx.toolUseCount,
      });
      if (stopResult.blocked) {
        log.info("session", `Stop hook blocked conversation end: ${stopResult.reason}`);
        injectMessages.push({
          role: "user",
          content: `[SYSTEM] Stop hook prevented conversation end: ${stopResult.reason}. Continue the conversation.`,
        });
        events.push({ type: "turn_end", stopReason: "stop_hook_blocked" });
        return {
          action: "continue",
          events,
          injectMessages,
          maxTokensContinuations,
          emptyEndTurnCount,
          truncationRetries,
          lastEmptyType,
          previousTurnTail,
          turnsSinceLastExtraction,
        };
      }
    } catch (err) {
      log.warn("hooks", `Stop hook error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Desktop notification for long-running tasks (delegated to post-turn)
  const elapsedMs = Date.now() - ctx.turnStartMs;
  if (elapsedMs > 30_000 || ctx.turnCount >= 3) {
    sendDesktopNotification(
      "KCode",
      `Task completed (${ctx.turnCount} turns, ${Math.round(elapsedMs / 1000)}s)`,
    );
  }

  // If turn had tool use but ends with no/minimal text output, emit structured
  // partial progress so the user sees what was accomplished.
  const finalTextLen = ctx.textChunks.join("").trim().length;
  if (ctx.toolUseCount > 0 && finalTextLen < 20) {
    const elapsed = Date.now() - ctx.turnStartMs;
    const summary = ctx.collectSessionData();
    const lastError =
      summary.errorsEncountered > 0
        ? (ctx.messages
            .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
            .filter((b: any) => b.type === "tool_result" && b.is_error)
            .map((b: any) => String(b.content ?? "").slice(0, 100))
            .pop() ?? "")
        : "";

    events.push({
      type: "partial_progress" as const,
      toolsUsed: ctx.toolUseCount,
      elapsedMs: elapsed,
      filesModified: summary.filesModified,
      lastError: lastError || undefined,
      summary: `Turn ended after ${ctx.toolUseCount} tool uses over ${Math.round(elapsed / 1000)}s`,
    });
  }

  // Close response session with appropriate status
  try {
    const { closeResponseSession, getActiveResponseSession } = await import(
      "./response-session.js"
    );
    const session = getActiveResponseSession();
    if (session) {
      const finalText = ctx.textChunks.join("").trim();
      const isComplete = finalText.length >= 20 && !looksIncomplete(finalText);
      closeResponseSession(
        isComplete ? "completed" : finalTextLen < 20 ? "failed" : "incomplete",
        ctx.stopReason,
        lastEmptyType === "no_output" ? "Model returned no text" : undefined,
      );
    }
  } catch {
    /* module not loaded */
  }

  // Auto-memory extraction: fire-and-forget background LLM call
  turnsSinceLastExtraction++;
  try {
    const autoMemConfig = parseAutoMemoryConfig(ctx.config.autoMemory ?? true);
    if (
      autoMemConfig.enabled &&
      ctx.stopReason === "end_turn" &&
      turnsSinceLastExtraction >= autoMemConfig.cooldownTurns
    ) {
      turnsSinceLastExtraction = 0;
      const recentMessages = ctx.messages.slice(-6);
      getMemoryTitles(ctx.config.workingDirectory)
        .then((existingTitles) => {
          runAutoMemoryExtraction({
            recentMessages,
            existingTitles,
            config: autoMemConfig,
            projectPath: ctx.config.workingDirectory,
            model: ctx.config.tertiaryModel,
          }).catch((err) =>
            log.debug("auto-memory", `extraction failed: ${err?.message ?? err}`),
          );
        })
        .catch((err) =>
          log.debug("auto-memory", `title fetch failed: ${err?.message ?? err}`),
        );
    }
  } catch (err) {
    log.debug("auto-memory", `hook error: ${err instanceof Error ? err.message : err}`);
  }

  events.push({ type: "turn_end", stopReason: ctx.stopReason, emptyType: lastEmptyType });
  return {
    action: "break",
    events,
    injectMessages,
    maxTokensContinuations,
    emptyEndTurnCount,
    truncationRetries,
    lastEmptyType,
    previousTurnTail,
    turnsSinceLastExtraction,
  };
}
