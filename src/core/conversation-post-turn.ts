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
  let actionNudgeUsed = ctx.actionNudgeUsed;
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
      /\?[\s\n]*$/,                                          // ends with ?
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
        const usedPlanTool = ctx.toolCalls.some((tc) => tc.name === "Plan" || tc.name === "PlanMode");
        const inProgressSteps = plan.steps.filter((s: { status: string }) => s.status === "in_progress");
        if (!usedPlanTool && inProgressSteps.length > 0) {
          injectMessages.push({
            role: "user",
            content: `[SYSTEM] Reminder: you have ${inProgressSteps.length} plan step(s) in_progress. If you completed work for any of them, update the plan NOW using Plan(mode='update') before continuing.`,
          });
        }
      }
    } catch { /* plan module not loaded */ }
  }

  // Safety net: classify empty responses and retry with context-aware prompts
  // (hasTextOutput already computed at the top of the function)
  const hasThinkingOutput =
    ctx.thinkingChunks.length > 0 ||
    (ctx.messages.at(-1) as Record<string, unknown> | undefined)?.thinkingContent;
  const hasToolOutput = ctx.toolCalls.length > 0;

  // Classify empty responses — persisted so the final turn_end carries it
  if (!hasTextOutput && (ctx.stopReason === "end_turn" || ctx.stopReason === "repetition_aborted")) {
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
  const maxEmptyRetries =
    lastEmptyType === "thinking_only" && ctx.toolUseCount > 0 ? 4 : 2;

  if (!hasTextOutput && (ctx.stopReason === "end_turn" || ctx.stopReason === "repetition_aborted") && emptyEndTurnCount < maxEmptyRetries) {
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
      } = await import("./grounding-gate.js");

      // Only count files that ACTUALLY exist on disk. Session tracker
      // records Write/Edit attempts by file_path even when the write
      // was blocked by a safety guard; those paths are "modified"
      // conceptually but no real file exists.
      const filesOnDiskCount = countFilesOnDisk(filesModified);

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
        }
      }

      // Check 2 — creation claim without actual writes landing on disk
      const mismatch = detectCreationClaimMismatch(finalText, filesOnDiskCount);
      if (mismatch) {
        const warning = formatClaimMismatchWarning(mismatch);
        log.warn(
          "grounding",
          `creation-claim mismatch: "${mismatch.snippet}" but 0 files written`,
        );
        events.push({
          type: "banner",
          title: "Ungrounded completion claim",
          subtitle: warning,
        });
      }

      // Check 3 — auth/network operational claim that isn't provable
      // from a passive session. Fires regardless of file count because
      // the user should always verify these manually. Issue #101.
      const authFinding = detectAuthClaim(finalText);
      if (authFinding) {
        const warning = formatAuthClaimWarning(authFinding);
        log.warn(
          "grounding",
          `unverifiable auth claim: "${authFinding.snippet}"`,
        );
        events.push({
          type: "banner",
          title: "Unverified auth/network assumption",
          subtitle: warning,
        });
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
            lastUserPrompt = c
              .filter((b: unknown): b is { type: string; text: string } =>
                typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text",
              )
              .map((b) => b.text)
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
      }
    } catch (err) {
      log.debug("grounding", `gate error: ${err instanceof Error ? err.message : err}`);
    }
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
  };
}
