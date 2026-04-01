// KCode - Tool Executor
// Extracted from conversation.ts — tool execution pipeline: permission checking,
// parallel batching, result formatting, loop/dedup guards, undo snapshots

import type { ContentBlock, ToolUseBlock, StreamEvent, KCodeConfig } from "./types";
import type { ToolRegistry } from "./tool-registry";
import type { PermissionManager } from "./permissions";
import type { HookManager } from "./hooks";
import type { UndoManager, FileSnapshot } from "./undo";
import { LoopGuardState, buildDedupKey, extractBashLoopPattern, LOOP_PATTERN_THRESHOLD, LOOP_PATTERN_HARD_STOP } from "./agent-loop-guards";
import { log } from "./logger";
import { getWorldModel } from "./world-model";
import { getIntentionEngine } from "./intentions";
import type { DebugTracer } from "./debug-tracer";

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
    yield { type: "tool_progress", toolUseId: call.id, name: call.name, status: "queued" as const, index: i, total: toolCalls.length };
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
        recordToolEvent({ sessionId: ctx.sessionId, toolName: call.name, model: ctx.config.model, durationMs, isError: !!result.is_error });
      } catch (err) { log.debug("analytics", "Failed to record parallel tool event: " + err); }

      yield { type: "tool_progress", toolUseId: call.id, name: call.name, status: (result.is_error ? "error" : "done") as "done" | "error", index: i, total: toolCalls.length, durationMs };
      yield { type: "tool_result", name: call.name, toolUseId: call.id, result: result.content, isError: result.is_error, durationMs };
      toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: result.content, is_error: result.is_error });
    } else {
      const errMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      yield { type: "tool_progress", toolUseId: call.id, name: call.name, status: "error" as const, index: i, total: toolCalls.length };
      yield { type: "tool_result", name: call.name, toolUseId: call.id, result: `Error: ${errMsg}`, isError: true };
      toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: `Error: ${errMsg}`, is_error: true });
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
      yield { type: "tool_result", name: call.name, toolUseId: call.id, result: skipMsg, isError: true };
      toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: skipMsg, is_error: true });
      continue;
    }

    // Cross-turn dedup
    const crossCount = guardState.trackCrossTurnSig(call.name, sig);

    // Smart redirect: auto-advance Read offset instead of blocking
    if (crossCount >= 2 && call.name === "Read") {
      const input = call.input as Record<string, unknown>;
      const currentOffset = (input.offset as number) || 1;
      const limit = (input.limit as number) || 200;
      const newOffset = currentOffset + (limit * crossCount);
      (call as ToolUseBlock & { _autoAdvancedInput?: Record<string, unknown> })._autoAdvancedInput = { ...input, offset: newOffset, limit: limit };
      log.info("tool", `Auto-advancing Read offset to ${newOffset} (repeat #${crossCount + 1}): ${String(input.file_path ?? "").slice(0, 60)}`);
    }

    // Hard block after many repeats (genuine stuck loop)
    if (crossCount >= 6) {
      const skipMsg = `BLOCKED: You have called ${call.name} with identical parameters ${crossCount + 1} times. STOP this approach entirely. Tell the user what you've tried, what failed, and ask if they want you to try something different. Do NOT retry this same call.`;
      log.warn("tool", `Cross-turn dedup blocked: ${sig.slice(0, 80)} (attempt ${crossCount + 1})`);
      yield { type: "tool_result", name: call.name, toolUseId: call.id, result: skipMsg, isError: true };
      toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: skipMsg, is_error: true });
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
          log.warn("tool", `Loop pattern HARD redirect #${entry.redirects} (${pattern}): ${entry.count} similar calls — forcing strategy change`);
          if (ctx.debugTracer?.isEnabled()) {
            ctx.debugTracer.traceGuard("loop-pattern-hard", true, `Pattern "${pattern}" hit ${entry.count} times (redirect #${entry.redirects})`);
          }
          entry.warned = true;
          entry.count = 0;
          entry.examples = [];
          const urgency = entry.redirects >= 3 ? "CRITICAL" : entry.redirects >= 2 ? "URGENT" : "IMPORTANT";
          const redirectMsg = `SKIPPED (redirect #${entry.redirects}): This "${pattern}" approach has been tried ${LOOP_PATTERN_HARD_STOP} times without success. This call was NOT executed. You MUST now try a COMPLETELY DIFFERENT technique to achieve the user's goal. [${urgency}] Think step by step:\n1. What did "${pattern}" attempts reveal? What is fundamentally wrong with this approach?\n2. What alternative tools, protocols, or angles haven't been tried yet?\n3. Pick the most promising NEW alternative and execute it NOW.\n\nDo NOT give up — the user wants results. Change your approach and keep going.${entry.redirects >= 2 ? "\n\nYou have been redirected " + entry.redirects + " times on this pattern. Try something RADICALLY different — different protocol, different tool, different port, different technique entirely." : ""}`;
          yield { type: "tool_result", name: call.name, toolUseId: call.id, result: redirectMsg, isError: true };
          toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: redirectMsg, is_error: true });
          continue;
        } else if (entry.count >= LOOP_PATTERN_THRESHOLD && !entry.warned) {
          // Soft redirect: inject a strategy hint
          entry.warned = true;
          log.info("tool", `Loop pattern detected (${pattern}): ${entry.count} similar calls, injecting redirect`);
          if (ctx.debugTracer?.isEnabled()) {
            ctx.debugTracer.traceGuard("loop-pattern-soft", true, `Pattern "${pattern}" at ${entry.count} occurrences (soft warning)`);
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
      yield { type: "tool_result", name: call.name, toolUseId: call.id, result: blockedContent, isError: true };
      toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: blockedContent, is_error: true });
      continue;
    }
    if (guardState.disallowedToolsSet?.has(call.name.toLowerCase())) {
      if (ctx.debugTracer?.isEnabled()) {
        ctx.debugTracer.tracePermission(call.name, "blocked", "in disallowed tools list");
      }
      const blockedContent = `Tool '${call.name}' is in the disallowed tools list`;
      yield { type: "tool_result", name: call.name, toolUseId: call.id, result: blockedContent, isError: true };
      toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: blockedContent, is_error: true });
      continue;
    }

    // After a denial, skip all remaining tool calls in this turn
    if (turnHadDenial) {
      const skippedContent = `Skipped: a previous tool call was denied in this turn. Respond to the user with text instead of using more tools.`;
      yield { type: "tool_result", name: call.name, toolUseId: call.id, result: skippedContent, isError: true };
      toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: skippedContent, is_error: true });
      continue;
    }

    // 1. Check permissions before executing
    const permResult = await ctx.permissions.checkPermission(call);
    if (!permResult.allowed) {
      if (ctx.debugTracer?.isEnabled()) {
        ctx.debugTracer.tracePermission(call.name, "denied", permResult.reason ?? "blocked by permission system");
      }
      turnHadDenial = true;
      const deniedContent = `Permission denied: ${permResult.reason ?? "blocked by permission system"}. STOP: Do not retry this tool or any other tools. Respond to the user with text only.`;
      yield { type: "tool_result", name: call.name, toolUseId: call.id, result: deniedContent, isError: true };
      toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: deniedContent, is_error: true });
      continue;
    }

    // 2. Run PreToolUse hooks (may modify input or block)
    let effectiveInput = (call as ToolUseBlock & { _autoAdvancedInput?: Record<string, unknown> })._autoAdvancedInput ?? permResult.updatedInput ?? call.input;
    if (ctx.hooks.hasHooks("PreToolUse")) {
      const hookResult = await ctx.hooks.runPreToolUse(call);
      if (!hookResult.allowed) {
        const blockedContent = `Blocked by hook: ${hookResult.reason ?? "PreToolUse hook denied execution"}`;
        yield { type: "tool_result", name: call.name, toolUseId: call.id, result: blockedContent, isError: true };
        toolResultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: blockedContent, is_error: true });
        continue;
      }
      if (hookResult.updatedInput) {
        effectiveInput = hookResult.updatedInput;
      }
    }

    // 3a. Auto-checkpoint conversation state before file modifications
    // (checkpoint saving is handled by the caller — we just yield an event marker)

    // 3b. Capture undo snapshot for file-modifying tools
    let undoSnapshot: FileSnapshot | null = null;
    let undoSnapshots: FileSnapshot[] | null = null;
    if ((call.name === "Edit" || call.name === "Write") && typeof effectiveInput.file_path === "string") {
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
    try { prediction = getWorldModel().predict(call.name, effectiveInput); } catch (err) { log.debug("world-model", "Failed to predict outcome for " + call.name + ": " + err); }

    // Execute the tool
    yield { type: "tool_executing", name: call.name, toolUseId: call.id, input: effectiveInput };

    const toolStartMs = Date.now();
    let result: import("./types").ToolResult;

    // Stream Bash output in real-time via tool_stream events
    if (call.name === "Bash" && !(effectiveInput as Record<string, unknown>).run_in_background) {
      const streamQueue: string[] = [];
      const { setBashStreamCallback } = await import("../tools/bash.js");
      setBashStreamCallback((chunk: string) => { streamQueue.push(chunk); });
      const toolPromise = ctx.tools.execute(call.name, effectiveInput);

      // Poll for stream chunks while the tool is running
      let done = false;
      let toolResult: import("./types").ToolResult | undefined;
      toolPromise
        .then((r: import("./types").ToolResult) => { toolResult = r; done = true; })
        .catch((err: unknown) => {
          toolResult = { tool_use_id: call.id, content: `Error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
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
    } catch (err) { log.debug("analytics", "Failed to record tool event: " + err); }

    // World Model: Compare prediction with actual result
    try { if (prediction) getWorldModel().compare(prediction, result.content, result.is_error); } catch (err) { log.debug("world-model", "Failed to compare prediction for " + call.name + ": " + err); }

    // Intention Engine: Record action for post-task evaluation
    try { getIntentionEngine().recordAction(call.name, effectiveInput, result.content, result.is_error); } catch (err) { log.debug("intention", "Failed to record action for " + call.name + ": " + err); }

    // Auto-pin: Track file accesses for intelligent auto-pinning
    if (!result.is_error && typeof effectiveInput.file_path === "string") {
      try {
        const { getAutoPinManager } = await import("./auto-pin.js");
        const isEdit = call.name === "Edit" || call.name === "Write" || call.name === "MultiEdit";
        getAutoPinManager(ctx.config.workingDirectory ?? process.cwd()).recordAccess(effectiveInput.file_path as string, isEdit);
      } catch (err) { log.debug("auto-pin", `Failed to record access: ${err}`); }
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
            await new Promise(r => setTimeout(r, 500));
            const diagMsg = lsp.formatDiagnosticsForFile(filePath);
            if (diagMsg) {
              result = { ...result, content: result.content + "\n\n" + diagMsg };
            }
          }
        }
      } catch (err) { log.debug("lsp", "Failed to get LSP diagnostics after file change: " + err); }
    }

    // After successful Edit/Write, reset cross-turn dedup for Bash/Read
    if (!result.is_error && (call.name === "Edit" || call.name === "Write")) {
      guardState.resetAfterFileEdit();
      // Also reset intention engine's action history for Bash/Read
      try { getIntentionEngine().resetTestFixCycle(); } catch (err) { log.debug("intention", "Failed to reset test-fix cycle: " + err); }

      // Invalidate tool cache for modified files
      try {
        const { getToolCache } = await import("./tool-cache.js");
        const filePath = String(effectiveInput.file_path ?? "");
        if (filePath) getToolCache().invalidate(filePath);
      } catch (err) { log.debug("cache", "Failed to invalidate tool cache for edited file: " + err); }
    } else if (!result.is_error && call.name === "MultiEdit") {
      try {
        const { getToolCache } = await import("./tool-cache.js");
        const edits = effectiveInput.edits as Array<{ file_path?: string }> | undefined;
        if (edits) {
          for (const edit of edits) {
            if (edit.file_path) getToolCache().invalidate(edit.file_path);
          }
        }
      } catch (err) { log.debug("cache", "Failed to invalidate tool cache for multi-edited files: " + err); }
    }

    // Record undo action if snapshot was captured and tool succeeded
    if (undoSnapshot && !result.is_error) {
      const desc = call.name === "Edit"
        ? `Edit ${effectiveInput.file_path}`
        : `Write ${effectiveInput.file_path}`;
      ctx.undoManager.pushAction(call.name, [undoSnapshot], desc);
    } else if (undoSnapshots && undoSnapshots.length > 0 && !result.is_error) {
      ctx.undoManager.pushAction("MultiEdit", undoSnapshots, `MultiEdit ${undoSnapshots.length} file(s)`);
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
      contextContent = contextContent.slice(0, maxResultChars)
        + `\n\n... [truncated: result was ${result.content.length} chars, showing first ${maxResultChars}]`;
      log.warn("tool", `Truncated ${call.name} result from ${result.content.length} to ${maxResultChars} chars`);
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
    if ((call.name === "Edit" || call.name === "Write" || call.name === "MultiEdit") && !result.is_error) {
      try {
        const { getTestSuggestion } = await import("./auto-test.js");
        const inp = call.input as Record<string, unknown>;
        const fp = String(inp?.file_path ?? (inp?.edits as Record<string, unknown>[] | undefined)?.[0]?.file_path ?? "");
        if (fp) {
          const suggestion = getTestSuggestion(fp, ctx.config.workingDirectory);
          if (suggestion) {
            const useRunner = ctx.tools.has("TestRunner");
            yield {
              type: "suggestion",
              suggestions: [{
                type: "test",
                message: useRunner
                  ? `Related test found: ${suggestion.testFile} — use TestRunner tool to run it`
                  : `Related test: ${suggestion.testFile} -- run with: ${suggestion.command}`,
                priority: "low",
              }],
            };
          }
        }
      } catch (err) { log.debug("auto-test", "Failed to detect related tests: " + err); }
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
        blockedResults.push({ type: "tool_result", tool_use_id: call.id, content: `Tool '${call.name}' is blocked by organization policy`, is_error: true });
        continue;
      }
      if (config.disableWebAccess && (call.name === "WebFetch" || call.name === "WebSearch")) {
        blockedResults.push({ type: "tool_result", tool_use_id: call.id, content: `Web access tools are disabled by organization policy`, is_error: true });
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
        blockedResults.push({ type: "tool_result", tool_use_id: call.id, content: `Tool '${call.name}' is not in the allowed tools list`, is_error: true });
      } else if (guardState.disallowedToolsSet?.has(call.name.toLowerCase())) {
        blockedResults.push({ type: "tool_result", tool_use_id: call.id, content: `Tool '${call.name}' is in the disallowed tools list`, is_error: true });
      } else {
        next.push(call);
      }
    }
    filtered = next;
  }

  return { filtered, blockedResults };
}
