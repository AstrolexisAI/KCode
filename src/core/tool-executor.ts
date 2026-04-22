// KCode - Tool Executor
// Extracted from conversation.ts — tool execution pipeline: permission checking,
// parallel batching, result formatting, loop/dedup guards, undo snapshots

import {
  buildDedupKey,
  extractBashLoopPattern,
  LOOP_PATTERN_HARD_STOP,
  LOOP_PATTERN_THRESHOLD,
  type LoopGuardState,
} from "./agent-loop-guards";
import type { DebugTracer } from "./debug-tracer";
import type { HookManager } from "./hooks";
import { getIntentionEngine } from "./intentions";
import { log } from "./logger";
import type { PermissionManager } from "./permissions";
import type { ToolRegistry } from "./tool-registry";
import type { ContentBlock, KCodeConfig, StreamEvent, ToolUseBlock } from "./types";
import type { FileSnapshot, UndoManager } from "./undo";
import { getWorldModel } from "./world-model";

// ─── Types ───────────────────────────────────────────────────────

export interface ToolExecutionContext {
  config: KCodeConfig;
  tools: ToolRegistry;
  permissions: PermissionManager;
  hooks: HookManager;
  undoManager: UndoManager;
  sessionId: string;
  contextWindowSize: number;
  abortController: AbortController | null;
  toolUseCount: number;
  debugTracer?: DebugTracer | null;
}

export interface ToolExecutionResult {
  toolResultBlocks: ContentBlock[];
  turnHadDenial: boolean;
  toolUseCount: number;
}

// ─── Parallel Execution ──────────────────────────────────────────

/**
 * Execute tool calls in parallel when all are read-only and in auto permission mode.
 * Returns the result blocks and updated tool use count.
 */
export async function* executeToolsParallel(
  toolCalls: ToolUseBlock[],
  ctx: ToolExecutionContext,
): AsyncGenerator<StreamEvent, ContentBlock[]> {
  const toolResultBlocks: ContentBlock[] = [];
  log.info("tool", `Parallel execution: ${toolCalls.length} read-only tools`);

  // Emit tool_executing + queued progress events
  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i]!;
    yield { type: "tool_executing", name: call.name, toolUseId: call.id, input: call.input };
    yield {
      type: "tool_progress",
      toolUseId: call.id,
      name: call.name,
      status: "queued" as const,
      index: i,
      total: toolCalls.length,
    };
  }

  // Execute all in parallel with individual timing
  const parallelStart = Date.now();
  const promises = toolCalls.map(async (c, i) => {
    const start = Date.now();
    const result = await ctx.tools.execute(c.name, c.input);
    return { result, durationMs: Date.now() - start, index: i };
  });

  const settled = await Promise.allSettled(promises);

  // Emit results and build tool_result blocks
  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i]!;
    const outcome = settled[i]!;
    ctx.toolUseCount++;

    if (outcome.status === "fulfilled") {
      const { result, durationMs } = outcome.value;

      // Record to persistent analytics
      try {
        const { recordToolEvent } = await import("./analytics.js");
        recordToolEvent({
          sessionId: ctx.sessionId,
          toolName: call.name,
          model: ctx.config.model,
          durationMs,
          isError: !!result.is_error,
        });
      } catch (err) {
        log.debug("analytics", "Failed to record parallel tool event: " + err);
      }

      yield {
        type: "tool_progress",
        toolUseId: call.id,
        name: call.name,
        status: (result.is_error ? "error" : "done") as "done" | "error",
        index: i,
        total: toolCalls.length,
        durationMs,
      };
      yield {
        type: "tool_result",
        name: call.name,
        toolUseId: call.id,
        result: result.content,
        isError: result.is_error,
        durationMs,
      };
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: result.content,
        is_error: result.is_error,
      });
    } else {
      const errMsg =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      yield {
        type: "tool_progress",
        toolUseId: call.id,
        name: call.name,
        status: "error" as const,
        index: i,
        total: toolCalls.length,
      };
      yield {
        type: "tool_result",
        name: call.name,
        toolUseId: call.id,
        result: `Error: ${errMsg}`,
        isError: true,
      };
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: `Error: ${errMsg}`,
        is_error: true,
      });
    }
  }

  log.info("tool", `Parallel batch completed in ${Date.now() - parallelStart}ms`);
  return toolResultBlocks;
}

// ─── Sequential Execution ────────────────────────────────────────

/**
 * Execute tool calls sequentially with full permission checking, dedup,
 * loop detection, undo snapshots, and hook integration.
 */
export async function* executeToolsSequential(
  toolCalls: ToolUseBlock[],
  ctx: ToolExecutionContext,
  guardState: LoopGuardState,
): AsyncGenerator<StreamEvent, ToolExecutionResult> {
  const toolResultBlocks: ContentBlock[] = [];
  let turnHadDenial = false;

  // Dedup: track executed tool signatures to skip identical calls in same batch
  const executedSigs = new Map<string, number>(); // sig -> count executed

  for (const call of toolCalls) {
    ctx.toolUseCount++;

    // 0. Dedup identical tool calls within same response
    const inputRec = call.input as Record<string, unknown>;
    const dedupKey = buildDedupKey(call.name, inputRec);
    const sig = `${call.name}:${dedupKey}`;
    const prevCount = executedSigs.get(sig) ?? 0;
    executedSigs.set(sig, prevCount + 1);

    if (prevCount >= 3) {
      const skipMsg = `BLOCKED: You already called ${call.name} with these exact parameters ${prevCount + 1} times in this response. You are in an infinite loop. STOP calling this tool and do something different.`;
      log.warn("tool", `Dedup blocked: ${sig.slice(0, 80)} (attempt ${prevCount + 1})`);
      yield {
        type: "tool_result",
        name: call.name,
        toolUseId: call.id,
        result: skipMsg,
        isError: true,
      };
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: skipMsg,
        is_error: true,
      });
      continue;
    }

    // Cross-turn dedup
    const crossCount = guardState.trackCrossTurnSig(call.name, sig);

    // Smart redirect: auto-advance Read offset instead of blocking
    if (crossCount >= 2 && call.name === "Read") {
      const input = call.input as Record<string, unknown>;
      const currentOffset = (input.offset as number) || 1;
      const limit = (input.limit as number) || 200;
      const newOffset = currentOffset + limit * crossCount;
      (call as ToolUseBlock & { _autoAdvancedInput?: Record<string, unknown> })._autoAdvancedInput =
        { ...input, offset: newOffset, limit: limit };
      log.info(
        "tool",
        `Auto-advancing Read offset to ${newOffset} (repeat #${crossCount + 1}): ${String(input.file_path ?? "").slice(0, 60)}`,
      );
    }

    // Hard block after many repeats (genuine stuck loop)
    if (crossCount >= 6) {
      const skipMsg = `BLOCKED: You have called ${call.name} with identical parameters ${crossCount + 1} times. STOP this approach entirely. Tell the user what you've tried, what failed, and ask if they want you to try something different. Do NOT retry this same call.`;
      log.warn("tool", `Cross-turn dedup blocked: ${sig.slice(0, 80)} (attempt ${crossCount + 1})`);
      yield {
        type: "tool_result",
        name: call.name,
        toolUseId: call.id,
        result: skipMsg,
        isError: true,
      };
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: skipMsg,
        is_error: true,
      });
      continue;
    }

    // Semantic loop detector for Bash commands
    if (call.name === "Bash") {
      const command = String((call.input as Record<string, unknown>).command ?? "");
      const pattern = extractBashLoopPattern(command);
      if (pattern) {
        const entry = guardState.trackLoopPattern(pattern, command);

        if (entry.count >= LOOP_PATTERN_HARD_STOP) {
          // Hard redirect: skip this call, force a strategy change, reset counter
          entry.redirects++;
          log.warn(
            "tool",
            `Loop pattern HARD redirect #${entry.redirects} (${pattern}): ${entry.count} similar calls — forcing strategy change`,
          );
          if (ctx.debugTracer?.isEnabled()) {
            ctx.debugTracer.traceGuard(
              "loop-pattern-hard",
              true,
              `Pattern "${pattern}" hit ${entry.count} times (redirect #${entry.redirects})`,
            );
          }
          entry.warned = true;
          entry.count = 0;
          entry.examples = [];
          const urgency =
            entry.redirects >= 3 ? "CRITICAL" : entry.redirects >= 2 ? "URGENT" : "IMPORTANT";
          const redirectMsg = `SKIPPED (redirect #${entry.redirects}): This "${pattern}" approach has been tried ${LOOP_PATTERN_HARD_STOP} times without success. This call was NOT executed. You MUST now try a COMPLETELY DIFFERENT technique to achieve the user's goal. [${urgency}] Think step by step:\n1. What did "${pattern}" attempts reveal? What is fundamentally wrong with this approach?\n2. What alternative tools, protocols, or angles haven't been tried yet?\n3. Pick the most promising NEW alternative and execute it NOW.\n\nDo NOT give up — the user wants results. Change your approach and keep going.${entry.redirects >= 2 ? "\n\nYou have been redirected " + entry.redirects + " times on this pattern. Try something RADICALLY different — different protocol, different tool, different port, different technique entirely." : ""}`;
          yield {
            type: "tool_result",
            name: call.name,
            toolUseId: call.id,
            result: redirectMsg,
            isError: true,
          };
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: redirectMsg,
            is_error: true,
          });
          continue;
        } else if (entry.count >= LOOP_PATTERN_THRESHOLD && !entry.warned) {
          // Soft redirect: inject a strategy hint
          entry.warned = true;
          log.info(
            "tool",
            `Loop pattern detected (${pattern}): ${entry.count} similar calls, injecting redirect`,
          );
          if (ctx.debugTracer?.isEnabled()) {
            ctx.debugTracer.traceGuard(
              "loop-pattern-soft",
              true,
              `Pattern "${pattern}" at ${entry.count} occurrences (soft warning)`,
            );
          }
        }
      }
    }

    // Safety net: allowed/disallowed tools filter (for tools injected after pre-filter, e.g. via MCP)
    if (guardState.allowedToolsSet && !guardState.allowedToolsSet.has(call.name.toLowerCase())) {
      if (ctx.debugTracer?.isEnabled()) {
        ctx.debugTracer.tracePermission(call.name, "blocked", "not in allowed tools list");
      }
      const blockedContent = `Tool '${call.name}' is not in the allowed tools list`;
      yield {
        type: "tool_result",
        name: call.name,
        toolUseId: call.id,
        result: blockedContent,
        isError: true,
      };
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: blockedContent,
        is_error: true,
      });
      continue;
    }
    if (guardState.disallowedToolsSet?.has(call.name.toLowerCase())) {
      if (ctx.debugTracer?.isEnabled()) {
        ctx.debugTracer.tracePermission(call.name, "blocked", "in disallowed tools list");
      }
      const blockedContent = `Tool '${call.name}' is in the disallowed tools list`;
      yield {
        type: "tool_result",
        name: call.name,
        toolUseId: call.id,
        result: blockedContent,
        isError: true,
      };
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: blockedContent,
        is_error: true,
      });
      continue;
    }

    // After a denial, skip all remaining tool calls in this turn
    if (turnHadDenial) {
      const skippedContent = `Skipped: a previous tool call was denied in this turn. Respond to the user with text instead of using more tools.`;
      yield {
        type: "tool_result",
        name: call.name,
        toolUseId: call.id,
        result: skippedContent,
        isError: true,
      };
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: skippedContent,
        is_error: true,
      });
      continue;
    }

    // 1. Check permissions before executing
    const permResult = await ctx.permissions.checkPermission(call);
    if (!permResult.allowed) {
      if (ctx.debugTracer?.isEnabled()) {
        ctx.debugTracer.tracePermission(
          call.name,
          "denied",
          permResult.reason ?? "blocked by permission system",
        );
      }
      turnHadDenial = true;
      // Smart routing: if a Bash command was denied but it was trying to
      // create a file via shell redirection, suggest the Write tool instead
      // of telling the model to give up. This prevents the failure mode
      // where the model stops trying to create a file after Bash safety
      // blocks a heredoc, instead of routing to the proper tool.
      //
      // For all OTHER denials we stay silent about retry strategy — the
      // denial reason itself is enough for the model to decide whether
      // to recover. Previously this branch used an aggressive
      // "STOP: Do not retry... respond with text only" suffix that
      // prevented the model from trying legitimate recovery paths
      // (e.g. passing an absolute path instead of a relative one), and
      // induced it to hallucinate success in user-facing text. We
      // never want that on recoverable denials.
      let suggestion = "";
      if (call.name === "Bash" && typeof call.input?.command === "string") {
        try {
          const { extractRedirectionTargets } = await import("./audit-guards.js");
          const targets = extractRedirectionTargets(call.input.command as string);
          if (targets.length > 0) {
            suggestion =
              ` STOP using Bash for this. To CREATE a file, call the Write tool: ` +
              `Write(file_path="${targets[0]}", content="..."). ` +
              `Do NOT retry the Bash command.`;
          }
        } catch {
          /* fallback: no suggestion */
        }
      }
      const deniedContent = `Permission denied: ${permResult.reason ?? "blocked by permission system"}.${suggestion}`;
      yield {
        type: "tool_result",
        name: call.name,
        toolUseId: call.id,
        result: deniedContent,
        isError: true,
      };
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: deniedContent,
        is_error: true,
      });
      continue;
    }

    // 2. Run PreToolUse hooks (may modify input or block)
    let effectiveInput =
      (call as ToolUseBlock & { _autoAdvancedInput?: Record<string, unknown> })
        ._autoAdvancedInput ??
      permResult.updatedInput ??
      call.input;
    try {
    if (ctx.hooks.hasHooks("PreToolUse")) {
      const hookResult = await ctx.hooks.runPreToolUse(call);
      if (!hookResult.allowed) {
        const blockedContent = `Blocked by hook: ${hookResult.reason ?? "PreToolUse hook denied execution"}`;
        yield {
          type: "tool_result",
          name: call.name,
          toolUseId: call.id,
          result: blockedContent,
          isError: true,
        };
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: blockedContent,
          is_error: true,
        });
        continue;
      }
      if (hookResult.updatedInput) {
        effectiveInput = hookResult.updatedInput;
      }
    }

    // Phase 32 — semantic phantom-typo claim block
    //
    // The conversation loop scanned the current turn's assistant text
    // for "X en lugar de X" / "X instead of X" patterns and stored
    // any hit on guardState.activePhantomClaim. If one is active AND
    // the model is now trying an Edit/MultiEdit, the entire Edit is
    // suspicious: the model declared a phantom bug in its own prose
    // and is acting on it. Block the call and force the model to
    // re-investigate.
    //
    // Precision guard: we only block when the claimed token actually
    // appears in the Edit's old_string or new_string. An Edit on a
    // completely different part of the file is allowed through —
    // even if the prose happened to contain a phantom phrase, it's
    // unrelated to this particular surgical change.
    if (
      (call.name === "Edit" || call.name === "MultiEdit") &&
      guardState.activePhantomClaim
    ) {
      const claim = guardState.activePhantomClaim;
      let editTouchesToken = false;

      if (call.name === "Edit") {
        const oldStr = String((effectiveInput as Record<string, unknown>).old_string ?? "");
        const newStr = String((effectiveInput as Record<string, unknown>).new_string ?? "");
        editTouchesToken = oldStr.includes(claim.token) || newStr.includes(claim.token);
      } else {
        // MultiEdit: scan every sub-edit
        const edits = (effectiveInput as Record<string, unknown>).edits;
        if (Array.isArray(edits)) {
          for (const edit of edits) {
            const e = edit as Record<string, unknown>;
            const o = String(e.old_string ?? "");
            const n = String(e.new_string ?? "");
            if (o.includes(claim.token) || n.includes(claim.token)) {
              editTouchesToken = true;
              break;
            }
          }
        }
      }

      if (editTouchesToken) {
        if (ctx.debugTracer?.isEnabled()) {
          ctx.debugTracer.traceGuard(
            "phase-32-phantom-typo",
            true,
            `Blocked ${call.name} — phantom-typo claim "${claim.phrase.slice(0, 80)}" touches token "${claim.token}"`,
          );
        }
        const blockedContent =
          `PHANTOM_TYPO_CLAIM_BLOCKED: your reasoning contained the phrase "${claim.phrase}" — ` +
          `a self-referential "X in place of X" claim where both sides of the replacement are the ` +
          `same identifier ("${claim.token}"). This is a hallucinated bug; "${claim.token}" does NOT ` +
          `need to be renamed to "${claim.token}". STOP. Do NOT retry this Edit. ` +
          `If the user reported a runtime symptom (service down, chart broken, no funciona), the real ` +
          `fix is visible in the actual runtime output (browser console, server log, test output) — ` +
          `not in imagined typography. Re-read the file carefully or ask the user what they actually see. ` +
          `Respond with text only until you have evidence of the real bug.`;
        log.warn(
          "tool",
          `phase 32 blocked ${call.name} on phantom-typo claim (token="${claim.token}")`,
        );
        yield {
          type: "tool_result",
          name: call.name,
          toolUseId: call.id,
          result: blockedContent,
          isError: true,
        };
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: blockedContent,
          is_error: true,
        });
        continue;
      }
    }

    // Phase 31 — rewrite-after-failed-Edit escape block
    //
    // When a model's Edit fails (especially from the phantom-typo
    // detector where old_string === new_string), the common failure
    // mode is to escape by rewriting the whole file via Write. That
    // wipes the 850 lines of already-working code and typically
    // produces a strictly worse version (NEXUS Telemetry mark6 session,
    // 850 → 627 lines). This guard catches a Write on a file that has
    // a recent Edit failure recorded against it, blocks the call, and
    // redirects the model to re-read and produce a surgical fix.
    //
    // Expires after ~6 tool calls (inside getRecentEditFailure) so the
    // guard doesn't outlive its usefulness — if the model legitimately
    // investigated and concluded that a rewrite is needed, they can
    // still do it after some intervening tool activity.
    if (call.name === "Write" && typeof effectiveInput.file_path === "string") {
      const fp = effectiveInput.file_path as string;
      const failureReason = guardState.getRecentEditFailure(fp, ctx.toolUseCount);
      if (failureReason) {
        if (ctx.debugTracer?.isEnabled()) {
          ctx.debugTracer.traceGuard(
            "phase-31-rewrite-escape",
            true,
            `Blocked Write on ${fp} — recent Edit failed: ${failureReason.slice(0, 80)}`,
          );
        }
        const blockedContent =
          `REWRITE_ESCAPE_BLOCKED: You just failed an Edit on ${fp} (reason: ${failureReason.slice(0, 200)}). ` +
          `Do NOT escape by rewriting the whole file with Write — that destroys information and typically produces a strictly worse version. ` +
          `Instead: (1) Read the current file state again, (2) identify the REAL problem based on observable behavior (not imagined typos), ` +
          `(3) produce a surgical Edit targeting only the broken section. ` +
          `If the user reported a runtime issue, open the ACTUAL runtime output (browser console, server log, test output) ` +
          `before touching the source again. This block expires after ~6 more tool calls, but you should only proceed to Write ` +
          `after you've genuinely investigated — not as an escape.`;
        log.warn(
          "tool",
          `phase 31 blocked rewrite-after-failed-Edit on ${fp}`,
        );
        yield {
          type: "tool_result",
          name: call.name,
          toolUseId: call.id,
          result: blockedContent,
          isError: true,
        };
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: blockedContent,
          is_error: true,
        });
        continue;
      }
    }

    // 3a. Auto-checkpoint conversation state before file modifications
    // (checkpoint saving is handled by the caller — we just yield an event marker)

    // 3b. Capture undo snapshot for file-modifying tools
    let undoSnapshot: FileSnapshot | null = null;
    let undoSnapshots: FileSnapshot[] | null = null;
    if (
      (call.name === "Edit" || call.name === "Write") &&
      typeof effectiveInput.file_path === "string"
    ) {
      undoSnapshot = ctx.undoManager.captureSnapshot(effectiveInput.file_path as string);
    } else if (call.name === "MultiEdit" && Array.isArray(effectiveInput.edits)) {
      const seen = new Set<string>();
      undoSnapshots = [];
      for (const edit of effectiveInput.edits as Array<{ file_path?: string }>) {
        const fp = edit.file_path;
        if (typeof fp === "string" && !seen.has(fp)) {
          seen.add(fp);
          undoSnapshots.push(ctx.undoManager.captureSnapshot(fp));
        }
      }
    }

    // 4. World Model — predict outcome before executing
    let prediction: { action: string; expected: string; confidence: number } | null = null;
    try {
      prediction = getWorldModel().predict(call.name, effectiveInput);
    } catch (err) {
      log.debug("world-model", "Failed to predict outcome for " + call.name + ": " + err);
    }

    // Execute the tool
    yield { type: "tool_executing", name: call.name, toolUseId: call.id, input: effectiveInput };

    const toolStartMs = Date.now();
    let result: import("./types").ToolResult;

    // PreBash hook: fires before Bash execution
    if (call.name === "Bash") {
      try {
        await ctx.hooks.runEventHook("PreBash", { command: effectiveInput.command as string });
      } catch (err) {
        log.debug("hooks", `PreBash hook failed: ${err}`);
      }
    }

    // PreEdit hook: fires before Edit/MultiEdit execution
    if (call.name === "Edit" || call.name === "MultiEdit") {
      try {
        await ctx.hooks.runEventHook("PreEdit", {
          file_path: effectiveInput.file_path as string,
          tool_name: call.name,
        });
      } catch (err) {
        log.debug("hooks", `PreEdit hook failed: ${err}`);
      }
    }

    // PreWrite hook: fires before Write execution
    if (call.name === "Write" && typeof effectiveInput.file_path === "string") {
      try {
        await ctx.hooks.runEventHook("PreWrite", {
          file_path: effectiveInput.file_path as string,
          tool_name: "Write",
        });
      } catch (err) {
        log.debug("hooks", `PreWrite hook failed: ${err}`);
      }
    }

    // Stream Bash output in real-time via tool_stream events
    if (call.name === "Bash" && !(effectiveInput as Record<string, unknown>).run_in_background) {
      const streamQueue: string[] = [];
      const { setBashStreamCallback } = await import("../tools/bash.js");
      setBashStreamCallback((chunk: string) => {
        streamQueue.push(chunk);
      });
      const toolPromise = ctx.tools.execute(call.name, effectiveInput);

      // Poll for stream chunks while the tool is running
      let done = false;
      let toolResult: import("./types").ToolResult | undefined;
      toolPromise
        .then((r: import("./types").ToolResult) => {
          toolResult = r;
          done = true;
        })
        .catch((err: unknown) => {
          toolResult = {
            tool_use_id: call.id,
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          };
          done = true;
        });

      while (!done) {
        // Check if user aborted (Ctrl+C)
        if (ctx.abortController?.signal.aborted) {
          setBashStreamCallback(undefined);
          break;
        }
        // Drain any queued stream chunks
        while (streamQueue.length > 0) {
          const chunk = streamQueue.shift()!;
          yield { type: "tool_stream" as const, toolUseId: call.id, name: call.name, chunk };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      // Drain remaining chunks after completion
      while (streamQueue.length > 0) {
        const chunk = streamQueue.shift()!;
        yield { type: "tool_stream" as const, toolUseId: call.id, name: call.name, chunk };
      }
      setBashStreamCallback(undefined);
      result = toolResult ?? { tool_use_id: call.id, content: "Aborted by user", is_error: true };
    } else {
      result = await ctx.tools.execute(call.name, effectiveInput);
    }

    const toolDurationMs = Date.now() - toolStartMs;

    // PostBash hook: fires after Bash execution
    if (call.name === "Bash") {
      try {
        ctx.hooks.fireAndForget("PostBash", {
          command: effectiveInput.command as string,
          exitCode: result.exitCode ?? 0,
        });
      } catch (err) {
        log.debug("hooks", `PostBash hook failed: ${err}`);
      }
    }

    // PostEdit hook: fires after successful Edit/MultiEdit execution
    if (
      (call.name === "Edit" || call.name === "MultiEdit") &&
      !result.is_error &&
      typeof effectiveInput.file_path === "string"
    ) {
      try {
        ctx.hooks.fireAndForget("PostEdit", {
          file_path: effectiveInput.file_path,
          tool_name: call.name,
          success: true,
        });
      } catch (err) {
        log.debug("hooks", `PostEdit hook failed: ${err}`);
      }
    }

    // PostWrite hook: fires after successful Write execution
    if (call.name === "Write" && !result.is_error && typeof effectiveInput.file_path === "string") {
      try {
        ctx.hooks.fireAndForget("PostWrite", {
          file_path: effectiveInput.file_path,
          tool_name: "Write",
          success: true,
        });
      } catch (err) {
        log.debug("hooks", `PostWrite hook failed: ${err}`);
      }
    }

    // Record to persistent analytics
    try {
      const { recordToolEvent } = await import("./analytics.js");
      recordToolEvent({
        sessionId: ctx.sessionId,
        toolName: call.name,
        model: ctx.config.model,
        durationMs: toolDurationMs,
        isError: !!result.is_error,
      });
    } catch (err) {
      log.debug("analytics", "Failed to record tool event: " + err);
    }

    // World Model: Compare prediction with actual result
    try {
      if (prediction) getWorldModel().compare(prediction, result.content, result.is_error);
    } catch (err) {
      log.debug("world-model", "Failed to compare prediction for " + call.name + ": " + err);
    }

    // Intention Engine: Record action for post-task evaluation
    try {
      getIntentionEngine().recordAction(call.name, effectiveInput, result.content, result.is_error);
    } catch (err) {
      log.debug("intention", "Failed to record action for " + call.name + ": " + err);
    }

    // Auto-pin: Track file accesses for intelligent auto-pinning
    if (!result.is_error && typeof effectiveInput.file_path === "string") {
      try {
        const { getAutoPinManager } = await import("./auto-pin.js");
        const isEdit = call.name === "Edit" || call.name === "Write" || call.name === "MultiEdit";
        getAutoPinManager(ctx.config.workingDirectory ?? process.cwd()).recordAccess(
          effectiveInput.file_path as string,
          isEdit,
        );
      } catch (err) {
        log.debug("auto-pin", `Failed to record access: ${err}`);
      }
    }

    // LSP: notify file change and append diagnostics to result
    if (!result.is_error && (call.name === "Write" || call.name === "Edit")) {
      try {
        const { getLspManager } = await import("./lsp.js");
        const lsp = getLspManager();
        if (lsp?.isActive()) {
          const filePath = String(effectiveInput.file_path ?? "");
          if (filePath) {
            const { readFileSync } = await import("node:fs");
            const content = readFileSync(filePath, "utf-8");
            lsp.notifyFileChanged(filePath, content);
            await new Promise((r) => setTimeout(r, 500));
            const diagMsg = lsp.formatDiagnosticsForFile(filePath);
            if (diagMsg) {
              result = { ...result, content: result.content + "\n\n" + diagMsg };
            }
          }
        }
      } catch (err) {
        log.debug("lsp", "Failed to get LSP diagnostics after file change: " + err);
      }
    }

    // Phase 31 — track Edit failures and clear on success. Write on a
    // file with a recent failed Edit is blocked upstream (rewrite-
    // escape guard) but we can't catch phantom-typo Edits there
    // because the failure happens inside the tool. Record it here and
    // clear on a successful Edit/Write.
    if (call.name === "Edit" && typeof effectiveInput.file_path === "string") {
      const fp = effectiveInput.file_path as string;
      if (result.is_error) {
        // Record the failure with the actual error message so the
        // block message can quote it back to the model.
        guardState.recordEditFailure(fp, result.content, ctx.toolUseCount);
      } else {
        // Successful Edit — clear any prior failure on this file.
        guardState.clearEditFailure(fp);
      }
    } else if (
      call.name === "Write" &&
      !result.is_error &&
      typeof effectiveInput.file_path === "string"
    ) {
      // Successful Write also clears (model wrote something and it
      // stuck, so the prior failure is no longer load-bearing).
      guardState.clearEditFailure(effectiveInput.file_path as string);
    } else if (call.name === "MultiEdit" && Array.isArray(effectiveInput.edits)) {
      // Phase 31 extends to MultiEdit: on failure, every file in the
      // edits array inherits the failure so a subsequent Write on any
      // of them is still blocked. On success, all cleared.
      const edits = effectiveInput.edits as Array<{ file_path?: string }>;
      for (const edit of edits) {
        const fp = edit.file_path;
        if (typeof fp !== "string" || !fp) continue;
        if (result.is_error) {
          guardState.recordEditFailure(fp, result.content, ctx.toolUseCount);
        } else {
          guardState.clearEditFailure(fp);
        }
      }
    }

    // After successful Edit/Write, reset cross-turn dedup for Bash/Read
    if (!result.is_error && (call.name === "Edit" || call.name === "Write")) {
      guardState.resetAfterFileEdit();
      // Also reset intention engine's action history for Bash/Read
      try {
        getIntentionEngine().resetTestFixCycle();
      } catch (err) {
        log.debug("intention", "Failed to reset test-fix cycle: " + err);
      }

      // Invalidate tool cache for modified files
      try {
        const { getToolCache } = await import("./tool-cache.js");
        const filePath = String(effectiveInput.file_path ?? "");
        if (filePath) getToolCache().invalidate(filePath);
      } catch (err) {
        log.debug("cache", "Failed to invalidate tool cache for edited file: " + err);
      }
    } else if (!result.is_error && call.name === "MultiEdit") {
      try {
        const { getToolCache } = await import("./tool-cache.js");
        const edits = effectiveInput.edits as Array<{ file_path?: string }> | undefined;
        if (edits) {
          for (const edit of edits) {
            if (edit.file_path) getToolCache().invalidate(edit.file_path);
          }
        }
      } catch (err) {
        log.debug("cache", "Failed to invalidate tool cache for multi-edited files: " + err);
      }
    }

    // Record undo action if snapshot was captured and tool succeeded
    if (undoSnapshot && !result.is_error) {
      const desc =
        call.name === "Edit"
          ? `Edit ${effectiveInput.file_path}`
          : `Write ${effectiveInput.file_path}`;
      ctx.undoManager.pushAction(call.name, [undoSnapshot], desc);
    } else if (undoSnapshots && undoSnapshots.length > 0 && !result.is_error) {
      ctx.undoManager.pushAction(
        "MultiEdit",
        undoSnapshots,
        `MultiEdit ${undoSnapshots.length} file(s)`,
      );
    }

    yield {
      type: "tool_result",
      name: call.name,
      toolUseId: call.id,
      result: result.content,
      isError: result.is_error,
      durationMs: toolDurationMs,
    };

    // Truncate large tool results to protect context window
    // contextWindowSize is in tokens; multiply by ~4 to convert to chars
    const CHARS_PER_TOKEN = 4;
    const maxResultChars = Math.floor(ctx.contextWindowSize * CHARS_PER_TOKEN * 0.6);
    let contextContent = result.content;
    if (contextContent.length > maxResultChars) {
      contextContent =
        contextContent.slice(0, maxResultChars) +
        `\n\n... [truncated: result was ${result.content.length} chars, showing first ${maxResultChars}]`;
      log.warn(
        "tool",
        `Truncated ${call.name} result from ${result.content.length} to ${maxResultChars} chars`,
      );
    }

    toolResultBlocks.push({
      type: "tool_result",
      tool_use_id: call.id,
      content: contextContent,
      is_error: result.is_error,
    });

    // 5. Run PostToolUse hooks (for logging/notification, non-blocking)
    if (ctx.hooks.hasHooks("PostToolUse")) {
      await ctx.hooks.runPostToolUse(call, {
        tool_use_id: call.id,
        content: result.content,
        is_error: result.is_error,
      });
    }

    // 6. Auto-test suggestion
    if (
      (call.name === "Edit" || call.name === "Write" || call.name === "MultiEdit") &&
      !result.is_error
    ) {
      try {
        const { getTestSuggestion } = await import("./auto-test.js");
        const inp = call.input as Record<string, unknown>;
        const fp = String(
          inp?.file_path ??
            (inp?.edits as Record<string, unknown>[] | undefined)?.[0]?.file_path ??
            "",
        );
        if (fp) {
          const suggestion = getTestSuggestion(fp, ctx.config.workingDirectory);
          if (suggestion) {
            const useRunner = ctx.tools.has("TestRunner");
            yield {
              type: "suggestion",
              suggestions: [
                {
                  type: "test",
                  message: useRunner
                    ? `Related test found: ${suggestion.testFile} — use TestRunner tool to run it`
                    : `Related test: ${suggestion.testFile} -- run with: ${suggestion.command}`,
                  priority: "low",
                },
              ],
            };
          }
        }
      } catch (err) {
        log.debug("auto-test", "Failed to detect related tests: " + err);
      }
    }
    } catch (execError) {
      // SAFETY NET: If ANY exception occurs during tool execution, we MUST still
      // produce a tool_result block. Without it, the conversation messages will have
      // a tool_use without a matching tool_result, causing the next API call to fail
      // with "tool_use ids were found without tool_result blocks".
      const errorMsg = execError instanceof Error ? execError.message : String(execError);
      log.error("tool", `Unhandled error executing ${call.name}: ${errorMsg}`);
      yield {
        type: "tool_result",
        name: call.name,
        toolUseId: call.id,
        result: `Error: ${errorMsg}`,
        isError: true,
      };
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: `Error: ${errorMsg}`,
        is_error: true,
      });
    }
  }

  return { toolResultBlocks, turnHadDenial, toolUseCount: ctx.toolUseCount };
}

// ─── Pre-filter Tool Calls ───────────────────────────────────────

/**
 * Pre-filter tool calls by managed policy (org-level) and allowed/disallowed lists.
 * Returns the filtered tool calls and any result blocks for blocked calls.
 */
export function preFilterToolCalls(
  toolCalls: ToolUseBlock[],
  guardState: LoopGuardState,
  config: KCodeConfig,
): { filtered: ToolUseBlock[]; blockedResults: ContentBlock[] } {
  const blockedResults: ContentBlock[] = [];
  let filtered = [...toolCalls];

  // Pre-filter by managed policy (org-level, immutable)
  if (config.managedDisallowedTools?.length || config.disableWebAccess) {
    const next: ToolUseBlock[] = [];
    for (const call of filtered) {
      if (guardState.managedDisallowedSet.has(call.name.toLowerCase())) {
        blockedResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: `Tool '${call.name}' is blocked by organization policy`,
          is_error: true,
        });
        continue;
      }
      if (config.disableWebAccess && (call.name === "WebFetch" || call.name === "WebSearch")) {
        blockedResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: `Web access tools are disabled by organization policy`,
          is_error: true,
        });
        continue;
      }
      next.push(call);
    }
    filtered = next;
  }

  // Pre-filter by allowed/disallowed lists
  if (config.allowedTools?.length || config.disallowedTools?.length) {
    const next: ToolUseBlock[] = [];
    for (const call of filtered) {
      if (guardState.allowedToolsSet && !guardState.allowedToolsSet.has(call.name.toLowerCase())) {
        blockedResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: `Tool '${call.name}' is not in the allowed tools list`,
          is_error: true,
        });
      } else if (guardState.disallowedToolsSet?.has(call.name.toLowerCase())) {
        blockedResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: `Tool '${call.name}' is in the disallowed tools list`,
          is_error: true,
        });
      } else {
        next.push(call);
      }
    }
    filtered = next;
  }

  return { filtered, blockedResults };
}
