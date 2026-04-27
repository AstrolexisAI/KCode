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
  /** Phase 35: whether the action-defer nudge already fired this session. */
  actionNudgeUsed: boolean;
  /** Consecutive turns with text output but zero tool calls (reasoning loop detection). */
  consecutiveTextOnlyTurns: number;

  /** Debug tracer (optional) */
  debugTracer?: {
    isEnabled(): boolean;
    trace(category: string, event: string, detail: string, meta?: Record<string, unknown>): void;
  } | null;

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
  actionNudgeUsed: boolean;
  consecutiveTextOnlyTurns: number;
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
  // Phase 35 nudge flag — propagates the input value and only gets
  // set to true in the nudge path. All other return paths inherit
  // this value unchanged, avoiding the need to add actionNudgeUsed
  // to every single return statement.
  const actionNudgeUsed = ctx.actionNudgeUsed;
  // Same pattern as actionNudgeUsed: most returns inherit this unchanged,
  // only the reasoning-loop detection path mutates it. Hoisted here so
  // every return doesn't have to re-spell ctx.consecutiveTextOnlyTurns.
  const consecutiveTextOnlyTurns = ctx.consecutiveTextOnlyTurns;
  let {
    maxTokensContinuations,
    emptyEndTurnCount,
    truncationRetries,
    lastEmptyType,
    previousTurnTail,
    turnsSinceLastExtraction,
  } = ctx;

  // Compute text-output flag early — used by phase 35 and empty-response retry.
  const hasTextOutput = ctx.textChunks.join("").trim().length > 0;

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
      actionNudgeUsed,
      consecutiveTextOnlyTurns,
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
      actionNudgeUsed,
      consecutiveTextOnlyTurns,
    };
  }

  // Phase 35: action-defer nudge for local models.
  //
  // Canonical trigger: v2.10.85 sessions with Gemma 4 (mark6-31b).
  // User says "audita todo este proyecto". Model produces a 30-line
  // plan organized into 4 "vectors", reads zero files, calls zero
  // tools, and ends with "¿Deseas que me enfoque en algún vector en
  // particular?" — passing the buck back to the user who already
  // gave a clear instruction.
  //
  // Detection: text-only response (0 tool calls) + the user's last
  // message has action intent + the model's text ends with a deferral
  // question. Fires ONCE (turnCount === 0) to avoid infinite loops.
  //
  // The nudge is bilingual (es/en) since the user and models switch
  // between both languages.
  if (
    ctx.toolCalls.length === 0 &&
    ctx.stopReason === "end_turn" &&
    !ctx.actionNudgeUsed &&
    hasTextOutput
  ) {
    const fullText = ctx.textChunks.join("");

    // Deferral detection: model ends with a question asking the user
    // what to do next, instead of just doing it.
    //
    // v2.10.86 update: Gemma 4 doesn't always ask a question. It
    // also produces "Próximos Pasos Inmediatos" / "Next Steps" lists
    // with declarative intentions ("Leeré...", "Analizaré...") that
    // it never executes. Added intention-without-execution patterns
    // alongside the original question-based deferral patterns.
    const DEFERRAL_PATTERNS = [
      /\?[\s\n]*$/, // ends with ?
      /¿(?:Deseas|Quieres|Prefieres|Cómo quieres|Te gustaría)\b/i,
      /\b(?:Would you like|Do you want|Shall I|Should I|How would you like)\b/i,
      /\b(?:¿(?:Empiezo|Procedo|Continúo|Inicio))\b/i,
      /\b(?:Let me know|Dime cómo|Dime si)\b/i,
      // Intention-without-execution: model declares what it WILL do
      // without actually calling any tools. These patterns fire only
      // when toolCalls.length === 0 (already checked above), so a
      // model that says "I'll read the file" AND then calls Read
      // won't match this path.
      /\b(?:Próximos\s+(?:Pasos|pasos)|Next\s+Steps)\b/i,
      /\b(?:Voy\s+a\s+(?:proceder|realizar|ejecutar|analizar|leer|revisar))\b/i,
      /\b(?:I(?:'ll| will)\s+(?:start|begin|proceed|analyze|read|review|examine))\b/i,
      // No \b wrappers: accented chars (é) aren't \w in JS regex
      // without the u flag, so \b breaks between r and é. These
      // conjugations are distinctive enough to not need word boundaries.
      /(?:Leeré|Analizaré|Revisaré|Evaluaré|Inspeccionaré)/i,
    ];
    const hasDeferral = DEFERRAL_PATTERNS.some((p) => p.test(fullText));

    // Action intent in the user's last message
    const lastUserMsg = ctx.messages
      .filter((m) => m.role === "user" && typeof m.content === "string")
      .at(-1);
    const userText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
    const ACTION_INTENT =
      /\b(audit[ae]?|crea|create|build|fix|arregl[ae]|implement[ae]?|haz|make|run|test|review|revis[ae]|analiz[ae]|genera|deploy|install[ae]?|configur[ae]|escrib[ae]|write|refactor|debug|soluciona|resuelv[ae]|ejecut[ae]|lanz[ae]|compil[ae])\b/i;
    const hasActionIntent = ACTION_INTENT.test(userText);

    if (hasDeferral && hasActionIntent) {
      log.info(
        "phase-35",
        `action-defer nudge: model deferred with "${fullText.slice(-60).trim()}" on action-intent "${userText.slice(0, 40)}"`,
      );
      if (ctx.debugTracer?.isEnabled()) {
        ctx.debugTracer.trace(
          "phase-35",
          "action-defer-nudge",
          `Model deferred instead of acting. Nudging once.`,
          { turn: ctx.turnCount },
        );
      }
      injectMessages.push({
        role: "user",
        content:
          "[SYSTEM] You just described a plan and asked the user for confirmation. " +
          "The user already gave you a clear instruction — execute it NOW. " +
          "Do NOT re-plan, do NOT ask for confirmation, do NOT describe what you would do. " +
          "Call tools immediately: Read files, Grep for patterns, run Bash commands. " +
          "Produce actual findings from actual code, not outlines of what you'd look for. " +
          "START by reading the most important source files.",
      });
      events.push({ type: "turn_end", stopReason: "action_defer_nudge" });
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
        actionNudgeUsed: true,
        consecutiveTextOnlyTurns,
      };
    }
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

  // Plan step update reminder: if there's an active plan and the model used tools
  // but didn't call the Plan tool to update progress, inject a reminder
  if (ctx.toolCalls.length > 0 && ctx.turnCount > 0 && ctx.turnCount % 3 === 0) {
    try {
      const { getActivePlan } = await import("../tools/plan.js");
      const plan = getActivePlan();
      if (plan) {
        const usedPlanTool = ctx.toolCalls.some(
          (tc) => tc.name === "Plan" || tc.name === "PlanMode",
        );
        const inProgressSteps = plan.steps.filter(
          (s: { status: string }) => s.status === "in_progress",
        );
        if (!usedPlanTool && inProgressSteps.length > 0) {
          injectMessages.push({
            role: "user",
            content: `[SYSTEM] Reminder: you have ${inProgressSteps.length} plan step(s) in_progress. If you completed work for any of them, update the plan NOW using Plan(mode='update') before continuing.`,
          });
        }
      }
    } catch {
      /* plan module not loaded */
    }
  }

  // Safety net: classify empty responses and retry with context-aware prompts
  // (hasTextOutput already computed at the top of the function)
  const hasThinkingOutput =
    ctx.thinkingChunks.length > 0 ||
    (ctx.messages.at(-1) as Record<string, unknown> | undefined)?.thinkingContent;
  const hasToolOutput = ctx.toolCalls.length > 0;

  // Classify empty responses — persisted so the final turn_end carries it
  if (
    !hasTextOutput &&
    (ctx.stopReason === "end_turn" || ctx.stopReason === "repetition_aborted")
  ) {
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

  // Reasoning models (kimi, grok-reasoning, o1/o3) need more retries when mid-task:
  // they produce multiple thinking-only turns while planning before emitting the tool call.
  const maxEmptyRetries = lastEmptyType === "thinking_only" && ctx.toolUseCount > 0 ? 4 : 2;

  if (
    !hasTextOutput &&
    (ctx.stopReason === "end_turn" || ctx.stopReason === "repetition_aborted") &&
    emptyEndTurnCount < maxEmptyRetries
  ) {
    emptyEndTurnCount++;

    // If context is near full, emergency compact before retrying — otherwise the retry
    // will also fail with an empty response (model can't fit output in remaining context)
    if (ctx.tokenCount > 0 && ctx.config?.contextWindowSize) {
      const pct = ctx.tokenCount / ctx.config.contextWindowSize;
      if (pct > 0.85) {
        log.warn(
          "session",
          `Empty response at ${Math.round(pct * 100)}% context — triggering emergency prune before retry`,
        );
        // Aggressive: drop half the old messages to make room
        const keepLast = 6;
        const dropCount = Math.max(2, Math.floor((ctx.messages.length - keepLast) / 2));
        if (dropCount > 0 && ctx.messages.length > keepLast + 2) {
          ctx.messages.splice(1, dropCount); // keep first message + recent
          log.info("session", `Emergency pruned ${dropCount} messages before empty-response retry`);
        }
      }
    }

    // On the second empty-retry, swap to the configured fallback
    // model (if any and if we haven't already swapped). Some providers
    // enter "empty" loops on specific prompt shapes — switching to a
    // different provider for one turn unblocks the session cleanly
    // instead of dead-ending at the "(empty response…)" UI message.
    let switchedModel: string | undefined;
    if (
      emptyEndTurnCount === 2 &&
      ctx.config.fallbackModel &&
      ctx.config.fallbackModel !== ctx.config.model &&
      !(ctx.config as { _activeFallback?: unknown })._activeFallback
    ) {
      const prev = ctx.config.model;
      const next = ctx.config.fallbackModel;
      log.warn(
        "session",
        `Empty response persisted on ${prev} — switching to fallback ${next} for one turn`,
      );
      ctx.config.model = next;
      (ctx.config as { _activeFallback?: string })._activeFallback = next;
      switchedModel = next;
    }

    log.info(
      "session",
      `Empty response (${lastEmptyType}) on turn ${ctx.turnCount} — retry ${emptyEndTurnCount}/${maxEmptyRetries}${
        switchedModel ? ` via fallback ${switchedModel}` : ""
      }`,
    );

    // Context-aware retry prompt
    const toolCount = ctx.toolUseCount;
    const retryPrompt =
      lastEmptyType === "thinking_only" && toolCount > 0
        ? // Reasoning model read/used tools then got stuck thinking — tell it to emit the tool call
          "[SYSTEM] URGENT: You have been thinking but produced no output and no tool call. " +
          "You already read the source file. You have enough context. " +
          "Call the Edit tool NOW with exact old_string and new_string. " +
          "Stop thinking — emit the Edit tool call immediately."
        : lastEmptyType === "thinking_only"
          ? "[SYSTEM] You reasoned but produced no visible answer. Stop thinking and either call a tool or answer the user directly."
          : lastEmptyType === "tools_only" || toolCount > 0
            ? `[SYSTEM] You executed ${toolCount} tools but didn't provide any response text. You MUST now write a brief summary (3-6 sentences) of what you accomplished. Do NOT use any more tools — just respond with text.`
            : lastEmptyType === "thinking_and_tools"
              ? "[SYSTEM] You reasoned and used tools but gave no visible answer. Provide a direct response to the user now."
              : "[SYSTEM] Your previous turn produced no output at all. Respond directly to the user now.";

    injectMessages.push({ role: "user", content: retryPrompt });
    // Visible-to-user note when we swap providers so it's not silent.
    if (switchedModel) {
      events.push({
        type: "text_delta",
        text: `\n\x1b[2m[auto-switch: empty response from primary — trying ${switchedModel}]\x1b[0m\n`,
      } as StreamEvent);
    }
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
      actionNudgeUsed,
      consecutiveTextOnlyTurns,
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
          const textBlocks = (lastMsg.content as ContentBlock[]).filter((b) => b.type === "text");
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
        actionNudgeUsed,
        consecutiveTextOnlyTurns,
      };
    }

    // After all retries, if still incomplete, notify the user via a banner event
    // (NOT a text_delta — injecting as text contaminates the message history
    // and makes the model think it produced the banner in future turns).
    if (truncationRetries >= 2 && looksIncomplete(fullText)) {
      log.warn("session", "Response still incomplete after 2 continuation retries");
      events.push({
        type: "incomplete_response" as const,
        continuations: 2,
        stopReason: ctx.stopReason,
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
          actionNudgeUsed,
          consecutiveTextOnlyTurns,
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
          }).catch((err) => log.debug("auto-memory", `extraction failed: ${err?.message ?? err}`));
        })
        .catch((err) => log.debug("auto-memory", `title fetch failed: ${err?.message ?? err}`));
    }
  } catch (err) {
    log.debug("auto-memory", `hook error: ${err instanceof Error ? err.message : err}`);
  }

  // Shared scope-flagger used by the grounding gate (line ~617) and
  // the closeout renderer (line ~1384). Defined once at function scope
  // so both downstream blocks can call it.
  const { getTaskScopeManager } = await import("./task-scope.js");
  const scopeMgr = getTaskScopeManager();
  const flagScope = (
    reason: string,
    opts: {
      mayClaimReady?: boolean;
      mayClaimImplemented?: boolean;
      mustUsePartialLanguage?: boolean;
      phase?: "partial" | "failed" | "blocked";
    } = {},
  ) => {
    const cur = scopeMgr.current();
    if (!cur) return;
    const updates: {
      phase?: typeof cur.phase;
      completion: Partial<typeof cur.completion>;
    } = { completion: {} };
    if (opts.mayClaimReady === false) updates.completion.mayClaimReady = false;
    if (opts.mayClaimImplemented === false) updates.completion.mayClaimImplemented = false;
    if (opts.mustUsePartialLanguage === true) updates.completion.mustUsePartialLanguage = true;
    if (opts.phase) updates.phase = opts.phase as typeof cur.phase;
    if (!cur.completion.reasons.includes(reason)) {
      updates.completion.reasons = [...cur.completion.reasons, reason];
    }
    scopeMgr.update(updates);
  };

  // Grounding gate — two checks before declaring "done":
  //   1. Scan files written/edited this turn for stub markers
  //      (stub_tx1, NotImplementedError, TODO, empty pass, …)
  //   2. If the final text claims creation ("has been created",
  //      "proyecto creado", etc) but zero files were written this
  //      turn, that's the 2026-04-23 Bitcoin TUI pattern: every tool
  //      call failed, agent declared victory anyway.
  // Opt-out: KCODE_DISABLE_GROUNDING_GATE=1. See issue #100.
  if (process.env.KCODE_DISABLE_GROUNDING_GATE !== "1") {
    try {
      const { filesModified } = ctx.collectSessionData();
      const finalText = ctx.textChunks.join("");
      const {
        scanFilesForStubs,
        formatStubWarning,
        detectCreationClaimMismatch,
        formatClaimMismatchWarning,
        countFilesOnDisk,
        detectAuthClaim,
        formatAuthClaimWarning,
        detectStrongCompletionClaim,
        formatStrongCompletionWarning,
        detectReadinessAfterErrors,
        formatReadinessContradictionWarning,
      } = await import("./grounding-gate.js");

      // Phase 3: grounding detectors update the TaskScope instead of
      // only emitting advisory banners. flagScope is hoisted to the
      // function scope so both this gate and the later closeout
      // renderer can share it.

      // Detect whether ANY tool result this turn was a BLOCKED response
      // (Edit/Write blocked, bash-mutation blocked, rewrite blocked, etc.).
      // Walk backwards through ctx.messages until the previous user turn
      // marker and scan tool_result blocks for the "BLOCKED" prefix that
      // every safety guard emits. Issue #103.
      let repairBlocked = false;
      for (let i = ctx.messages.length - 1; i >= 0; i--) {
        const m = ctx.messages[i];
        if (!m) continue;
        if (m.role === "user" && Array.isArray(m.content)) {
          let blockFound = false;
          for (const b of m.content) {
            if (
              typeof b === "object" &&
              b !== null &&
              (b as { type?: unknown }).type === "tool_result"
            ) {
              const content = (b as { content?: unknown }).content;
              const text =
                typeof content === "string"
                  ? content
                  : Array.isArray(content)
                    ? content
                        .filter(
                          (c: unknown): c is { type: string; text: string } =>
                            typeof c === "object" &&
                            c !== null &&
                            (c as { type?: unknown }).type === "text",
                        )
                        .map((c) => c.text)
                        .join(" ")
                    : "";
              if (/\bBLOCKED\b/.test(text)) {
                blockFound = true;
                break;
              }
            }
          }
          if (blockFound) {
            repairBlocked = true;
            break;
          }
          // Reached a non-tool-result user message (the prior turn boundary) — stop scanning.
          const isToolResultsOnly = m.content.every(
            (b) =>
              typeof b === "object" &&
              b !== null &&
              (b as { type?: unknown }).type === "tool_result",
          );
          if (!isToolResultsOnly) break;
        } else if (m.role === "user") {
          // Plain user text message — turn boundary
          break;
        }
      }

      // Only count files that ACTUALLY exist on disk. Session tracker
      // records Write/Edit attempts by file_path even when the write
      // was blocked by a safety guard; those paths are "modified"
      // conceptually but no real file exists.
      const filesOnDiskCount = countFilesOnDisk(filesModified);

      // Check 0-pre: scaffold/implement turn closed with files
      // written but no runtime command — phase stays "writing" and
      // mayClaimReady=true by default, so the closeout renderer
      // sees no correction needed and the model's "Proyecto creado.
      // Para ejecutar: ..." prose slips through. v278 repro: exact
      // failure mode.
      //
      // Rule: any scaffold/implement turn that produced code files
      // and zero runtime validations cannot claim ready. Force
      // phase=partial + mustUsePartialLanguage + reason so the
      // closeout renders an honest "code written, nothing executed"
      // line. Docs-only edits don't trigger (e.g. just README).
      {
        const sc = scopeMgr.current();
        if (
          sc &&
          (sc.type === "scaffold" || sc.type === "implement") &&
          sc.verification.runtimeCommands.length === 0
        ) {
          const CODE_EXT =
            /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|scala|swift|php|pl|lua|sh|c|cpp|cc|h|hpp|cs|fs|ex|exs|hs|ml|dart|r|nim|zig|sql)$/i;
          const codeFilesTouched = [
            ...sc.verification.filesWritten,
            ...sc.verification.filesEdited,
          ].some((p) => CODE_EXT.test(p));
          if (codeFilesTouched) {
            flagScope(
              "code files were written/edited this turn but no runtime validation was executed — the artifact is unverified",
              {
                mayClaimReady: false,
                mustUsePartialLanguage: true,
                phase: "partial",
              },
            );
          }
        }
      }

      // Check 0 — project root missing AND scaffold/implement scope.
      // This is the executor gate from issue #110: the scope already
      // detects the missing root (Phase 9), but the model can decide
      // to delegate ("create the directory manually") instead of
      // issuing mkdir -p. When scope says missing AND no successful
      // mkdir happened this turn, inject a forced-recovery directive
      // for the next turn so the executor cannot skip it.
      {
        const s = scopeMgr.current();
        if (
          s &&
          (s.type === "scaffold" || s.type === "implement") &&
          s.projectRoot.status === "missing" &&
          s.projectRoot.path
        ) {
          // Did ANY successful mkdir for this path happen this turn?
          let mkdirSucceeded = false;
          for (const m of ctx.messages) {
            if (m.role === "assistant" && Array.isArray(m.content)) {
              for (const b of m.content) {
                const t =
                  typeof b === "object" && b !== null ? (b as { type?: unknown }).type : undefined;
                if (t !== "tool_use") continue;
                if (String((b as { name?: unknown }).name ?? "") !== "Bash") continue;
                const inp = (b as { input?: unknown }).input;
                const cmd =
                  typeof inp === "object" && inp !== null
                    ? String((inp as { command?: unknown }).command ?? "")
                    : "";
                if (cmd.includes("mkdir") && cmd.includes(s.projectRoot.path)) {
                  mkdirSucceeded = true;
                  break;
                }
              }
            }
            if (mkdirSucceeded) break;
          }

          if (!mkdirSucceeded) {
            injectMessages.push({
              role: "user",
              content:
                `[SYSTEM] The project root at "${s.projectRoot.path}" is MISSING ` +
                `(the cd/chdir failed with ENOENT). You have the Bash tool available. ` +
                `Your next action MUST be a Bash call with: mkdir -p ${s.projectRoot.path} && ls -ld ${s.projectRoot.path}\n\n` +
                `Do NOT delegate directory creation to the user. Do NOT suggest they do it manually. ` +
                `Do NOT attempt pip install, cd, or Write until the directory exists and is verified. ` +
                `This is a mandatory recovery step — the executor skipped it on the previous turn.`,
            });
            log.warn(
              "grounding",
              `phase-9 executor gate: injecting forced mkdir directive for missing root ${s.projectRoot.path}`,
            );
            flagScope(
              `executor skipped mandatory mkdir -p ${s.projectRoot.path} and delegated to the user instead`,
              {
                mayClaimReady: false,
                mustUsePartialLanguage: true,
                phase: "partial",
              },
            );
          }
        }
      }

      // Check 1 — stub markers inside written files
      if (filesOnDiskCount > 0) {
        const findings = scanFilesForStubs(filesModified);
        if (findings.length > 0) {
          const warning = formatStubWarning(findings);
          log.info(
            "grounding",
            `${findings.length} stub/placeholder finding(s) across ${filesOnDiskCount} file(s)`,
          );
          events.push({
            type: "banner",
            title: "Partial implementation detected",
            subtitle: warning.split("\n").slice(0, 4).join("\n"),
          });
          flagScope(`${findings.length} placeholder/stub marker(s) in generated code`, {
            mayClaimImplemented: false,
            mustUsePartialLanguage: true,
            phase: "partial",
          });

          // Phase 8: for broad-scope requests, a placeholder-laden
          // scaffold is NOT a valid stopping point. Inject a
          // continuation directive that forces the next turn to
          // replace placeholders with real implementation. Issue
          // #108 (Dashboard coming soon... accepted as done).
          const curScope = scopeMgr.current();
          if (curScope && curScope.broadRequest && curScope.type === "scaffold") {
            const placeholderHints = findings
              .slice(0, 5)
              .map((f) => `  • ${f.file.split("/").pop()}:${f.line} — ${f.snippet.slice(0, 80)}`)
              .join("\n");
            injectMessages.push({
              role: "user",
              content:
                "[SYSTEM] The user asked for a broad/complete implementation, but the " +
                `files you just wrote contain ${findings.length} placeholder/stub marker(s):\n` +
                placeholderHints +
                "\n\nThis is NOT a valid stopping point. Your next action must continue " +
                "implementing the requested functionality: replace the placeholders with " +
                "real code, add the views/panels/features the user asked for. Do not close " +
                "with a summary until the placeholders are gone or each is explicitly " +
                "documented as out-of-scope for a specific reason.",
            });
            log.info(
              "grounding",
              `phase 8 continuation directive injected: broad scaffold with ${findings.length} placeholders`,
            );
          }
        }
      }

      // Check 2 — creation claim without actual writes landing on disk
      const mismatch = detectCreationClaimMismatch(finalText, filesOnDiskCount);
      if (mismatch) {
        const warning = formatClaimMismatchWarning(mismatch);
        log.warn("grounding", `creation-claim mismatch: "${mismatch.snippet}" but 0 files written`);
        events.push({
          type: "banner",
          title: "Ungrounded completion claim",
          subtitle: warning,
        });
        flagScope("creation claimed in response but zero files landed on disk", {
          mayClaimReady: false,
          mayClaimImplemented: false,
          mustUsePartialLanguage: true,
          phase: "partial",
        });
      }

      // Check 3 — auth/network operational claim that isn't provable
      // from a passive session. Fires regardless of file count because
      // the user should always verify these manually. Issue #101.
      const authFinding = detectAuthClaim(finalText);
      if (authFinding) {
        const warning = formatAuthClaimWarning(authFinding);
        log.warn("grounding", `unverifiable auth claim: "${authFinding.snippet}"`);
        events.push({
          type: "banner",
          title: "Unverified auth/network assumption",
          subtitle: warning,
        });
        // Softer signal — auth claim doesn't block ready, but must
        // downgrade confidence language in the closeout.
        flagScope(`unverified auth/network assumption ("${authFinding.snippet.slice(0, 60)}")`, {
          mustUsePartialLanguage: true,
        });
      }

      // Check 4c — runtime error signature in bash OUTPUT even when
      // exit code was 0. Issue #106: `timeout 5 python app.py 2>&1
      // | head` succeeds (last pipe cmd = 0) and masks a Traceback
      // in stdout. The existing errorsEncountered counter misses
      // this because it only tracks is_error from tool results.
      {
        const { detectRuntimeFailureInOutput, formatRuntimeFailureInOutputWarning } = await import(
          "./grounding-gate.js"
        );
        // Build (command, output) pairs from this turn's Bash calls.
        const bashOutputs: Array<{ command: string; output: string }> = [];
        for (let i = 0; i < ctx.messages.length; i++) {
          const m = ctx.messages[i];
          if (!m) continue;
          if (m.role === "assistant" && Array.isArray(m.content)) {
            for (const b of m.content) {
              const type =
                typeof b === "object" && b !== null ? (b as { type?: unknown }).type : undefined;
              if (type !== "tool_use") continue;
              if (String((b as { name?: unknown }).name ?? "") !== "Bash") continue;
              const useId = String((b as { id?: unknown }).id ?? "");
              const inp = (b as { input?: unknown }).input;
              const cmd =
                typeof inp === "object" && inp !== null
                  ? String((inp as { command?: unknown }).command ?? "")
                  : "";
              // Find matching tool_result in later user messages
              for (let j = i + 1; j < ctx.messages.length; j++) {
                const n = ctx.messages[j];
                if (!n || n.role !== "user" || !Array.isArray(n.content)) continue;
                for (const rb of n.content) {
                  if (
                    typeof rb === "object" &&
                    rb !== null &&
                    (rb as { type?: unknown }).type === "tool_result" &&
                    (rb as { tool_use_id?: unknown }).tool_use_id === useId
                  ) {
                    const raw = (rb as { content?: unknown }).content;
                    const output =
                      typeof raw === "string"
                        ? raw
                        : Array.isArray(raw)
                          ? raw
                              .filter(
                                (c: unknown): c is { type: string; text: string } =>
                                  typeof c === "object" &&
                                  c !== null &&
                                  (c as { type?: unknown }).type === "text",
                              )
                              .map((c) => c.text)
                              .join("\n")
                          : "";
                    bashOutputs.push({ command: cmd, output });
                    break;
                  }
                }
              }
            }
          }
        }
        const runtimeFailure = detectRuntimeFailureInOutput(bashOutputs);
        if (runtimeFailure) {
          const warning = formatRuntimeFailureInOutputWarning(runtimeFailure);
          log.warn(
            "grounding",
            `runtime-failure-in-output: ${runtimeFailure.marker} from ${runtimeFailure.command.slice(0, 60)}`,
          );
          events.push({
            type: "banner",
            title: "Runtime error in output despite exit code 0",
            subtitle: warning,
          });
          // Record as an actual runtime command result — this flips
          // scope.phase to "failed" and scope.completion.mayClaimReady
          // to false via the manager's own logic.
          scopeMgr.recordRuntimeCommand({
            command: runtimeFailure.command,
            exitCode: 0, // exit was 0 but traceback was in output
            output: runtimeFailure.excerpt,
            runtimeFailed: true,
            timestamp: Date.now(),
          });
        }
      }

      // Check 4b — patch applied after runtime failure but no rerun.
      // Sequence: Bash (python/node/etc) returned non-zero →
      // Edit/Write/GrepReplace/sed -i applied → no successful rerun →
      // final text claims success. Issue #104.
      {
        const { detectPatchWithoutRerun, formatPatchWithoutRerunWarning } = await import(
          "./grounding-gate.js"
        );
        // Build tool-event list from this turn's messages.
        const toolEvents: {
          name: string;
          isError: boolean;
          summary: string;
        }[] = [];
        for (const m of ctx.messages.slice(-40)) {
          if (!m) continue;
          if (m.role === "assistant" && Array.isArray(m.content)) {
            for (const b of m.content) {
              const type =
                typeof b === "object" && b !== null ? (b as { type?: unknown }).type : undefined;
              if (type === "tool_use") {
                const name = String((b as { name?: unknown }).name ?? "?");
                const inp = (b as { input?: unknown }).input;
                let summary = "";
                if (typeof inp === "object" && inp !== null) {
                  const rec = inp as Record<string, unknown>;
                  summary =
                    typeof rec.command === "string"
                      ? rec.command
                      : typeof rec.file_path === "string"
                        ? rec.file_path
                        : typeof rec.path === "string"
                          ? rec.path
                          : typeof rec.pattern === "string"
                            ? `pattern=${rec.pattern}`
                            : JSON.stringify(inp).slice(0, 120);
                }
                toolEvents.push({ name, isError: false, summary });
              }
            }
          }
          if (m.role === "user" && Array.isArray(m.content)) {
            for (const b of m.content) {
              const type =
                typeof b === "object" && b !== null ? (b as { type?: unknown }).type : undefined;
              if (type === "tool_result") {
                const isError = (b as { is_error?: unknown }).is_error === true;
                // Attach isError retroactively to the last matching tool_use.
                if (toolEvents.length > 0 && isError) {
                  toolEvents[toolEvents.length - 1]!.isError = true;
                }
              }
            }
          }
        }
        const patchFinding = detectPatchWithoutRerun(toolEvents, finalText);
        if (patchFinding) {
          const warning = formatPatchWithoutRerunWarning(patchFinding);
          log.warn(
            "grounding",
            `patch-without-rerun: ${patchFinding.failingCommand} → ${patchFinding.patchAction} → no rerun`,
          );
          events.push({
            type: "banner",
            title: "Patch applied but app not rerun — success claim ungrounded",
            subtitle: warning,
          });
          // Explicitly flag the patch-without-rerun pattern in the
          // scope. The manager also tracks patchAppliedAfterFailure
          // via recordMutation post-failure, but the detector covers
          // cases where the scope wasn't kept in sync (e.g. bash
          // pipe failure not recorded as runtime failure).
          scopeMgr.update({
            verification: { patchAppliedAfterFailure: true, rerunPassedAfterPatch: false },
          });
          flagScope(
            `patch applied after runtime failure without successful rerun (${patchFinding.patchAction.slice(0, 60)})`,
            {
              mayClaimReady: false,
              mustUsePartialLanguage: true,
              phase: "partial",
            },
          );
        }
      }

      // Check 3b (v290) — fabricated artifact / diagnostic claims.
      // The model mentions files or diagnostics that are NOT in the
      // canonical tool-trace for this turn. Issue #111 v289 repro:
      // final prose claimed 'Basic README with setup instructions'
      // but the Write README.md was BLOCKED, and 'port check: closed'
      // but no port-probe command was issued this turn.
      {
        const finalText = ctx.textChunks.join("");
        const fabricatedReasons: string[] = [];

        // Artifact fabrication: README claimed but not created.
        // The unsolicited-docs gate produces this exact BLOCKED
        // message. If we see that in the tool-result stream AND the
        // final prose mentions README, the claim is fabricated.
        if (/\breadme\b|setup\s+instructions|basic\s+readme/i.test(finalText)) {
          let readmeBlocked = false;
          let readmeActuallyCreated = false;
          for (const m of ctx.messages) {
            if (!Array.isArray(m.content)) continue;
            for (const b of m.content) {
              if (typeof b !== "object" || b === null) continue;
              if (
                (b as { type?: unknown }).type === "tool_result" &&
                typeof (b as { content?: unknown }).content === "string" &&
                /BLOCKED — FILE NOT CREATED:.*README/i.test((b as { content: string }).content)
              ) {
                readmeBlocked = true;
              }
              if (
                (b as { type?: unknown }).type === "tool_use" &&
                (b as { name?: string }).name === "Write"
              ) {
                const inp = (b as { input?: unknown }).input;
                if (
                  typeof inp === "object" &&
                  inp !== null &&
                  /readme/i.test(String((inp as { file_path?: unknown }).file_path ?? ""))
                ) {
                  // Check next message for a successful result
                  // (not BLOCKED). If Write succeeded, README exists.
                  // Heuristic: if ANY Write to a README path happened
                  // in the turn AND we didn't see the BLOCKED text,
                  // assume it was created.
                  // This branch is reached after Write was called —
                  // whether success or failure is recorded separately.
                }
              }
            }
          }
          // filesWritten already captures successful Writes.
          const sc = scopeMgr.current();
          if (sc) {
            readmeActuallyCreated = [
              ...sc.verification.filesWritten,
              ...sc.verification.filesEdited,
            ].some((p) => /readme/i.test(p));
          }
          if (readmeBlocked && !readmeActuallyCreated) {
            fabricatedReasons.push(
              "final prose mentions README but README creation was BLOCKED this turn",
            );
          }
        }

        // Diagnostic fabrication: 'port check: closed' / 'port X is closed'
        // / 'port closed' in prose but no port-probe command ran.
        if (
          /port\s+check\s*:\s*closed|port\s+\d+\s+is\s+closed|\bport\s+closed\b|\bss\s+-tlnp\b/i.test(
            finalText,
          )
        ) {
          let portProbeHappened = false;
          for (const m of ctx.messages) {
            if (!Array.isArray(m.content)) continue;
            for (const b of m.content) {
              if (typeof b !== "object" || b === null) continue;
              if ((b as { type?: unknown }).type !== "tool_use") continue;
              if ((b as { name?: string }).name !== "Bash") continue;
              const inp = (b as { input?: unknown }).input;
              const cmd =
                typeof inp === "object" && inp !== null
                  ? String((inp as { command?: unknown }).command ?? "")
                  : "";
              if (
                /\bss\s+-[tu]/.test(cmd) ||
                /\bnetstat\b/.test(cmd) ||
                /\bnc\s+-z/.test(cmd) ||
                /\bcurl.*localhost/.test(cmd) ||
                /\btelnet\b/.test(cmd) ||
                /\bfuser\b/.test(cmd) ||
                /\blsof\s+-i/.test(cmd)
              ) {
                portProbeHappened = true;
                break;
              }
            }
            if (portProbeHappened) break;
          }
          if (!portProbeHappened) {
            fabricatedReasons.push(
              "final prose mentions 'port check' / 'port closed' but no port-probe command was issued this turn",
            );
          }
        }

        if (fabricatedReasons.length > 0) {
          log.warn("grounding", `fabricated claim(s) detected: ${fabricatedReasons.join("; ")}`);
          events.push({
            type: "banner",
            title: "Fabricated claim detected",
            subtitle: fabricatedReasons.join("\n"),
          });
          for (const reason of fabricatedReasons) {
            flagScope(reason, {
              mayClaimReady: false,
              mayClaimImplemented: false,
              mustUsePartialLanguage: true,
              phase: "failed",
            });
          }
        }
      }

      // Check 4a — readiness claim contradicting direct error evidence.
      // Fires when the final text says the artifact is "ready / runs /
      // displays" but the turn recorded tool errors (likely a validation
      // run) or blocked repair attempts. Issue #103.
      const sessionData = ctx.collectSessionData();
      const readinessFinding = detectReadinessAfterErrors(
        finalText,
        sessionData.errorsEncountered,
        repairBlocked,
      );
      if (readinessFinding) {
        const warning = formatReadinessContradictionWarning(readinessFinding);
        log.warn(
          "grounding",
          `readiness contradicts errors (errors=${readinessFinding.errorCount}, blocked=${readinessFinding.repairBlocked}): "${readinessFinding.snippet}"`,
        );
        events.push({
          type: "banner",
          title: "Ready claim contradicts failure signals",
          subtitle: warning,
        });
        flagScope(
          `readiness claim contradicts ${readinessFinding.errorCount} tool error(s)${readinessFinding.repairBlocked ? " + blocked repair" : ""}`,
          {
            mayClaimReady: false,
            mayClaimImplemented: false,
            mustUsePartialLanguage: true,
            phase: "failed",
          },
        );
      }

      // Check 4 — strong completion claim. Fires when the final text
      // uses phrases like "completado" / "listo para tiempo real" /
      // "fully functional" / "production-ready". Issue #102.
      // Extract the most recent user prompt to check for broad-scope
      // markers. (ctx.messages is filtered assistant↔user, so we walk
      // backwards to find the last user message text.)
      let lastUserPrompt = "";
      for (let i = ctx.messages.length - 1; i >= 0; i--) {
        const m = ctx.messages[i];
        if (m?.role === "user") {
          const c = m.content;
          if (typeof c === "string") {
            lastUserPrompt = c;
          } else if (Array.isArray(c)) {
            lastUserPrompt = (c as Array<{ type?: string; text?: string }>)
              .filter((b) => b?.type === "text" && typeof b.text === "string")
              .map((b) => b.text!)
              .join(" ");
          }
          break;
        }
      }
      const strongClaim = detectStrongCompletionClaim(finalText, lastUserPrompt);
      if (strongClaim) {
        const warning = formatStrongCompletionWarning(strongClaim);
        log.warn(
          "grounding",
          `strong completion claim${strongClaim.broadRequest ? " (broad-scope request)" : ""}: "${strongClaim.snippet}"`,
        );
        events.push({
          type: "banner",
          title: strongClaim.broadRequest
            ? "Scope overclaim on broad request"
            : "Strong completion claim — verify runtime",
          subtitle: warning,
        });
        flagScope(
          strongClaim.broadRequest
            ? `scope overclaim: "${strongClaim.snippet.slice(0, 60)}" on a broad-scope request`
            : `strong completion claim: "${strongClaim.snippet.slice(0, 60)}" without verification`,
          { mustUsePartialLanguage: true },
        );
      }
    } catch (err) {
      log.debug("grounding", `gate error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Phase 10 — forced-rerun gate. When the scope carries
  // patchAppliedAfterFailure && !rerunPassedAfterPatch, the model
  // patched the artifact after a runtime failure but never re-ran
  // the validation. Without this gate the closeout renders "status:
  // unverified" and the turn closes — issue #111 / v2.10.272 repro.
  //
  // The gate injects a mandatory-rerun directive and returns action
  // "continue", so the model's next step MUST be a Bash call with
  // the derived rerun command. Capped at 3 attempts per failure to
  // prevent infinite loops when the model refuses to comply.
  //
  // Opt-out: KCODE_DISABLE_FORCED_RERUN=1.
  if (process.env.KCODE_DISABLE_FORCED_RERUN !== "1") {
    try {
      const { getTaskScopeManager } = await import("./task-scope.js");
      const mgr = getTaskScopeManager();
      const scope = mgr.current();
      if (
        scope &&
        scope.verification.patchAppliedAfterFailure &&
        !scope.verification.rerunPassedAfterPatch &&
        scope.verification.rerunAttempts < 3
      ) {
        const { buildRerunDirective, deriveRerunCommand } = await import("./rerun-directive.js");
        const directive = buildRerunDirective(scope);
        const cmd = deriveRerunCommand(scope);
        if (directive && cmd) {
          mgr.update({
            verification: { rerunAttempts: scope.verification.rerunAttempts + 1 },
          });
          log.warn(
            "forced-rerun",
            `injecting mandatory rerun directive (attempt ${scope.verification.rerunAttempts + 1}/3): ${cmd}`,
          );
          injectMessages.push({ role: "user", content: directive });
          events.push({
            type: "banner",
            title: "Forced rerun — patch applied after runtime failure",
            subtitle:
              `The model patched the artifact after a runtime failure but did not re-run the validation.\n` +
              `Next turn is forced to execute: \`${cmd}\``,
          });
          events.push({ type: "turn_end", stopReason: "forced_rerun" });
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
            actionNudgeUsed,
            consecutiveTextOnlyTurns,
          };
        }
      }
    } catch (err) {
      log.debug("forced-rerun", `gate error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Phase 4 — closeout renderer. If the scope state indicates the
  // turn cannot claim ready/done (phase=failed/partial OR
  // mustUsePartialLanguage), append a scope-grounded correction as
  // a text_delta AFTER the model's draft. The model's draft still
  // appears; the correction is an authoritative postscript with the
  // verified facts (files actually written, runtime actually run,
  // explicit reasons for downgrade). Issues #103, #107, #108.
  //
  // Opt-out: KCODE_DISABLE_CLOSEOUT_RENDERER=1.
  if (process.env.KCODE_DISABLE_CLOSEOUT_RENDERER !== "1") {
    try {
      const { getTaskScopeManager } = await import("./task-scope.js");
      const curScope = getTaskScopeManager().current();
      if (curScope) {
        // v298 Phase 2: run the applicable verification probe BEFORE
        // closeout renders. The probe actively exercises the app
        // (e.g. JSON-RPC getblockcount against bitcoind) and produces
        // tier-3 evidence or a concrete failure reason. Opt-out:
        // KCODE_DISABLE_PROBES=1.
        if (process.env.KCODE_DISABLE_PROBES !== "1") {
          log.info(
            "probe",
            `post-turn: evaluating probes against scope (filesWritten=${curScope.verification.filesWritten.length}, filesEdited=${curScope.verification.filesEdited.length})`,
          );
          try {
            const { runApplicableProbe } = await import("./probes/registry.js");
            const result = await runApplicableProbe(curScope);
            log.info(
              "probe",
              `post-turn: runApplicableProbe returned ${result ? result.status + " (" + result.probeId + ")" : "null (no probe applied)"}`,
            );
            if (result) {
              const mgr = getTaskScopeManager();
              mgr.update({
                verification: {
                  lastProbeResult: {
                    status: result.status,
                    probeId: result.probeId,
                    evidence: result.status === "pass" ? result.evidence : undefined,
                    error:
                      result.status !== "pass" && result.status !== "not_applicable"
                        ? result.error
                        : undefined,
                    tier: result.status === "pass" ? result.tier : undefined,
                  },
                },
              });
              // Downgrade phase if probe failed with a specific cause.
              if (result.status === "fail_auth") {
                flagScope(`functional probe failed: ${result.error}`, {
                  mayClaimReady: false,
                  mustUsePartialLanguage: true,
                  phase: "blocked",
                });
              } else if (result.status === "fail_connection" || result.status === "fail_runtime") {
                flagScope(`functional probe failed: ${result.error}`, {
                  mayClaimReady: false,
                  mustUsePartialLanguage: true,
                  phase: "partial",
                });
              } else if (result.status === "pass") {
                // Probe passed — this is tier-3 evidence, the
                // strongest signal KCode can produce. It OVERRIDES
                // weaker gates including phase=failed (which may have
                // come from a loop-guard skip or readiness-vs-errors
                // detector that saw something unrelated). The probe
                // actually exercised the user's thing and it works.
                //
                // Exception: phase=blocked from a failed_auth status
                // remains if it was set by a PRIOR probe run this turn
                // (unusual — usually there's only one probe per turn).
                mgr.update({
                  completion: { mayClaimReady: true, mayClaimImplemented: true },
                  phase: "done",
                });
                log.info("probe", `pass (tier ${result.tier}) — overriding phase to done`);
              }
            }
          } catch (err) {
            log.debug(
              "probe",
              `probe run error (non-fatal): ${err instanceof Error ? err.message : err}`,
            );
          }
        }

        // Reconcile the Plan widget from scope state so the widget's
        // step checkboxes match the closeout's "Plan progress: N/M"
        // line. Model often calls plan.create once and never plan.update,
        // leaving the widget at 0/N while verification state has
        // clearly advanced. Issue #111 v274 repro.
        try {
          const { reconcilePlanFromScope } = await import("../tools/plan.js");
          const flipped = reconcilePlanFromScope();
          if (flipped > 0) {
            log.info("plan", `reconciled ${flipped} step(s) from scope`);
          }
        } catch (err) {
          log.debug(
            "plan",
            `reconcile error (non-fatal): ${err instanceof Error ? err.message : err}`,
          );
        }

        const { renderCloseoutFromScope, summarizeScopeForTelemetry } = await import(
          "./closeout-renderer.js"
        );
        // Re-read scope — the probe hook above may have updated
        // verification.lastProbeResult and phase since curScope was
        // captured. Rendering against curScope would show stale state
        // (no probe line, wrong phase). Issue #111 v299 diagnostic:
        // logs confirmed probe passed with getblockcount=946464 but
        // the closeout had no 'Functional probe' line because
        // curScope was captured pre-probe.
        const freshScope = getTaskScopeManager().current() ?? curScope;

        // Issue #111 v305 — grounding rewrite. If the draft contains
        // overclaim phrases ("visión profunda", "proyecto completo",
        // "ready", "fully functional") and the scope says we're
        // partial/failed/blocked OR mustUsePartialLanguage is set,
        // rewrite them to cautious equivalents BEFORE render. Prior
        // design let the optimistic prose render then appended a
        // ⚠ Verified status below — user read the overclaim first.
        // Now the draft is softened in-place and the closeout no
        // longer contradicts it. Opt-out: KCODE_DISABLE_GROUNDING_REWRITE=1.
        let rewrittenDraft: string | null = null;
        let missingRepos: Array<{ repo: string; evidence?: string }> = [];
        try {
          if (process.env.KCODE_DISABLE_GROUNDING_REWRITE !== "1") {
            const { rewriteFinalTextForGrounding, enforceEvidenceFloor } = await import(
              "./grounding-rewrite.js"
            );
            const draftText = ctx.textChunks.join("");
            if (draftText.trim().length > 0) {
              let working = draftText;

              // Issue #111 v306 — github claim grounding. Verify every
              // owner/repo token in the draft against github.com HEAD.
              // Fabricated claims (e.g. "nasa/ai" — doesn't exist) get
              // annotated with "(repo no encontrado)". Preventive
              // layer: catches fabrications BEFORE they reach the user.
              if (process.env.KCODE_DISABLE_REPO_GROUNDING !== "1") {
                try {
                  const { groundGithubRepoClaims } = await import("./github-claim-grounding.js");
                  const grounded = await groundGithubRepoClaims(working, {
                    timeoutMs: 2500,
                  });
                  if (grounded.missing.length > 0 || grounded.unknown.length > 0) {
                    working = grounded.text;
                    missingRepos = grounded.missing.map((m) => ({
                      repo: m.repo,
                      evidence: m.evidence,
                    }));
                    log.info(
                      "repo-grounding",
                      `verified=${grounded.verified.length} missing=${grounded.missing.length} unknown=${grounded.unknown.length}` +
                        (grounded.missing.length > 0
                          ? ` — missing: ${grounded.missing.map((m) => m.repo).join(", ")}`
                          : ""),
                    );
                  } else if (grounded.verified.length > 0) {
                    log.debug(
                      "repo-grounding",
                      `all ${grounded.verified.length} repo claim(s) verified`,
                    );
                  }
                } catch (err) {
                  log.debug(
                    "repo-grounding",
                    `ground error (non-fatal): ${err instanceof Error ? err.message : err}`,
                  );
                }
              }

              const rw = rewriteFinalTextForGrounding(working, freshScope);
              working = rw.text;
              let reads = 0;
              try {
                const { sourceReadCount } = await import("./session-tracker.js");
                reads = sourceReadCount();
              } catch {
                /* tracker optional */
              }
              const floor = enforceEvidenceFloor(working, reads, 5);
              working = floor.text;
              if (
                rw.replacements > 0 ||
                floor.underfloor ||
                missingRepos.length > 0 ||
                working !== draftText
              ) {
                rewrittenDraft = working;
                log.info(
                  "grounding-rewrite",
                  `softened draft (replacements=${rw.replacements}, reasons=[${rw.reasons.join(",")}], evidence_floor=${floor.underfloor}, repos_flagged=${missingRepos.length})`,
                );
              }
            }
          }
        } catch (err) {
          log.debug(
            "grounding-rewrite",
            `rewrite error (non-fatal): ${err instanceof Error ? err.message : err}`,
          );
        }

        // Flag scope when fabricated repos were detected so the
        // closeout renders "partial" + surfaces the reason.
        if (missingRepos.length > 0) {
          flagScope(`fabricated repo reference(s): ${missingRepos.map((r) => r.repo).join(", ")}`, {
            mayClaimReady: false,
            mayClaimImplemented: false,
            mustUsePartialLanguage: true,
          });
        }

        const correction = renderCloseoutFromScope(freshScope);
        if (correction) {
          log.info(
            "closeout-renderer",
            `emitting scope-grounded correction (${JSON.stringify(summarizeScopeForTelemetry(curScope))})`,
          );
          const { renderVisibleText } = await import("./visible-text-renderer.js");
          const safeCorrection = renderVisibleText(correction, {
            source: "closeout",
            skipScopeRecord: true,
          });

          // Decide whether the draft should be REPLACED or merely
          // annotated. Replacement is mandatory when the scope is in
          // a terminal non-ready state (failed, blocked, or
          // mayClaimReady=false) — keeping the draft alongside the
          // correction creates the "created successfully / status:
          // failed" contradiction the user reported in #111 v273.
          // Milder conditions (partial language only) still use the
          // append path so the model's partial narrative survives.
          // Opt-out: KCODE_DISABLE_FREEFORM_SUPPRESS=1.
          const suppressDraft =
            process.env.KCODE_DISABLE_FREEFORM_SUPPRESS !== "1" &&
            (curScope.phase === "failed" ||
              curScope.phase === "blocked" ||
              curScope.phase === "partial" ||
              !curScope.completion.mayClaimReady);

          if (suppressDraft) {
            log.info(
              "closeout-renderer",
              `suppress mode — replacing draft (phase=${curScope.phase}, mayClaimReady=${curScope.completion.mayClaimReady}, rewritten=${rewrittenDraft !== null})`,
            );
            const standalone = safeCorrection.replace(/^\s*\n?---\n?\s*/, "");
            // Issue #111 v305 — when phase is partial AND the model
            // wrote a non-trivial analysis, preserve the softened
            // draft above the Verified status block so the user keeps
            // the architectural context (just with cautious language).
            // For failed/blocked or empty drafts, still render just
            // the Verified status. The seal closes the stream so
            // follow-up prose in the same turn is blocked.
            const preserveSoftenedDraft =
              curScope.phase === "partial" &&
              rewrittenDraft !== null &&
              rewrittenDraft.trim().length > 40;
            const replacement = preserveSoftenedDraft
              ? `${rewrittenDraft!.trim()}\n\n---\n\n${standalone}`
              : standalone;
            events.push({ type: "text_replace_last", text: replacement, seal: true });
          } else {
            // No suppression, but if the rewrite changed the draft
            // (overclaim softened without triggering full suppress),
            // replace the draft in-place then append the correction.
            if (rewrittenDraft !== null) {
              events.push({ type: "text_replace_last", text: rewrittenDraft, seal: false });
            }
            events.push({ type: "text_delta", text: safeCorrection });
          }
        } else {
          log.debug("closeout-renderer", "scope ok, no correction needed");
        }
      }
    } catch (err) {
      log.debug("closeout-renderer", `render error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Check 5 — semantic self-critique pass. A second model reviews
  // the draft response against the turn's tool history and flags
  // any claim not supported by evidence. Complements the regex-based
  // gates above by catching novel phrasings regex patterns never
  // see. Issue #103 + general robustness.
  // Non-blocking failure modes: timeout, parse error, model
  // unreachable all resolve to "ok" (no banner). Opt-out:
  // KCODE_DISABLE_SELF_CRITIQUE=1.
  {
    const sc_draftText = ctx.textChunks.join("");
    if (process.env.KCODE_DISABLE_SELF_CRITIQUE !== "1" && sc_draftText.trim().length >= 40) {
      try {
        // Compute the signals the critique needs, independent of
        // whether the regex-gate block above ran.
        const sc_sessionData = ctx.collectSessionData();

        // Walk backwards to find whether any tool_result this turn
        // contained a BLOCKED prefix (a safety guard refusal).
        let sc_repairBlocked = false;
        for (let i = ctx.messages.length - 1; i >= 0; i--) {
          const m = ctx.messages[i];
          if (!m) continue;
          if (m.role === "user" && Array.isArray(m.content)) {
            let foundBlock = false;
            let allToolResults = true;
            for (const b of m.content) {
              const type =
                typeof b === "object" && b !== null ? (b as { type?: unknown }).type : undefined;
              if (type !== "tool_result") {
                allToolResults = false;
                continue;
              }
              const raw = (b as { content?: unknown }).content;
              const txt =
                typeof raw === "string"
                  ? raw
                  : Array.isArray(raw)
                    ? raw
                        .filter(
                          (c: unknown): c is { type: string; text: string } =>
                            typeof c === "object" &&
                            c !== null &&
                            (c as { type?: unknown }).type === "text",
                        )
                        .map((c) => c.text)
                        .join(" ")
                    : "";
              if (/\bBLOCKED\b/.test(txt)) foundBlock = true;
            }
            if (foundBlock) {
              sc_repairBlocked = true;
              break;
            }
            if (!allToolResults) break;
          } else if (m.role === "user") {
            break;
          }
        }

        // Walk backwards to find the last user-typed prompt.
        let sc_userPrompt = "";
        for (let i = ctx.messages.length - 1; i >= 0; i--) {
          const m = ctx.messages[i];
          if (m?.role === "user") {
            const c = m.content;
            if (typeof c === "string") {
              sc_userPrompt = c;
            } else if (Array.isArray(c)) {
              sc_userPrompt = (c as Array<{ type?: string; text?: string }>)
                .filter((b) => b?.type === "text" && typeof b.text === "string")
                .map((b) => b.text!)
                .join(" ");
            }
            if (sc_userPrompt) break;
          }
        }

        const { runSelfCritique, formatCritiqueBanner } = await import("./self-critique.js");
        // Prefer tertiaryModel; fall back to the primary model which
        // is guaranteed reachable (the conversation just ran on it).
        // Without this fallback, runForkedAgent resolves "model=undefined"
        // to a default URL that may be unreachable (seen on 2026-04-23:
        // "Unable to connect. Is the computer able to access the url?").
        // Critique by the same model is a weaker signal than an
        // independent reviewer, but weak > silent skip. Issue #105.
        const critiqueModel = ctx.config.tertiaryModel ?? ctx.config.model;
        log.info(
          "self-critique",
          `model selection: tertiary=${ctx.config.tertiaryModel ?? "(unset)"} primary=${ctx.config.model} → using ${critiqueModel}`,
        );
        const critique = await runSelfCritique({
          draftText: sc_draftText,
          recentMessages: ctx.messages.slice(-20),
          errorsEncountered: sc_sessionData.errorsEncountered,
          filesWritten: sc_sessionData.filesModified,
          repairBlocked: sc_repairBlocked,
          userPrompt: sc_userPrompt,
          model: critiqueModel,
          apiBase: ctx.config.apiBase,
          apiKey: ctx.config.apiKey,
        });

        if (!critique.skipped && critique.contradictions.length > 0) {
          const banner = formatCritiqueBanner(critique);
          events.push({
            type: "banner",
            title:
              critique.verdict === "downgrade"
                ? "Self-critique: response contradicts evidence"
                : "Self-critique: minor issues",
            subtitle: banner,
          });
        }
      } catch (err) {
        log.debug("self-critique", `pass error: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Issue #111 v305-v306 — auto-capture ranked lists emitted by the
  // assistant in this turn so follow-up prompts like "clona el
  // proyecto 6" / "abre #2" can resolve deterministically instead of
  // relying on the model's token-level recall (which drifts).
  //
  // v306 extends the capture shapes: bullets, markdown links, and
  // tables (not just 1./2./3. numbered). See reference-extractor.ts.
  try {
    const { bumpTurnCounter, extractRankedListFromText, recordRankedList } = await import(
      "./reference-memory.js"
    );
    bumpTurnCounter();
    const turnText = ctx.textChunks.join("");
    if (turnText.length > 0) {
      // Try the generalized repo/github extractor first — handles bullets,
      // markdown links, tables, numbered lists.
      let captured = false;
      try {
        const { extractRepoList, capturedListToRankedItems } = await import(
          "./reference-extractor.js"
        );
        const list = extractRepoList(turnText);
        if (list && list.items.length >= 3) {
          const items = capturedListToRankedItems(list);
          recordRankedList("github_repos", items);
          captured = true;
          log.info(
            "ref-memory",
            `captured ${list.kind} list of ${list.items.length} repo(s): ${list.items
              .slice(0, 3)
              .map((it) => `#${it.ordinal}=${it.repo}`)
              .join(", ")}${list.items.length > 3 ? ", …" : ""}`,
          );
        }
      } catch (err) {
        log.debug(
          "ref-extractor",
          `extract error (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
      }
      // Fallback to numeric-only extractor if repo extractor found nothing.
      if (!captured) {
        const items = extractRankedListFromText(turnText);
        if (items.length >= 3) {
          recordRankedList("items", items);
          log.info(
            "ref-memory",
            `captured numeric list of ${items.length} item(s): ${items
              .slice(0, 3)
              .map((it) => `#${it.rank}=${it.title.slice(0, 30)}`)
              .join(", ")}${items.length > 3 ? ", …" : ""}`,
          );
        }
      }
    }
  } catch (err) {
    log.debug(
      "ref-memory",
      `capture error (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
  }

  const contextFull =
    ctx.tokenCount > 0 &&
    ctx.config.contextWindowSize != null &&
    ctx.config.contextWindowSize > 0 &&
    ctx.tokenCount / ctx.config.contextWindowSize >= 0.9;
  events.push({
    type: "turn_end",
    stopReason: ctx.stopReason,
    emptyType: lastEmptyType,
    contextFull: contextFull || undefined,
  });
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
    actionNudgeUsed,
    consecutiveTextOnlyTurns,
  };
}
