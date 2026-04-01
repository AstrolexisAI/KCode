// KCode - Conversation Manager
// Handles the main conversation loop with local LLM API (OpenAI-compatible) using SSE streaming

import {
  setSudoPasswordPromptFn as _setSudoPasswordPromptFn,
  type SudoPasswordPromptFn,
} from "../tools/bash";
import {
  LOOP_PATTERN_HARD_STOP,
  LOOP_PATTERN_THRESHOLD,
  LoopGuardState,
  MAX_AGENT_TURNS,
  MAX_CONSECUTIVE_DENIALS,
  validateModelOutput,
} from "./agent-loop-guards";
import { getMemoryTitles, runAutoMemoryExtraction } from "./auto-memory/extractor";
import { parseAutoMemoryConfig } from "./auto-memory/types";
// getBranchManager moved to conversation-session.ts
import { emergencyPrune, estimateContextTokens, pruneMessagesIfNeeded } from "./context-manager";
import type { DebugTracer } from "./debug-tracer";
import { HookManager } from "./hooks";
import { getIntentionEngine } from "./intentions";
import { log } from "./logger";
import { PermissionManager } from "./permissions";
import {
  cacheResponseIfEligible,
  evaluateIntentionSuggestions,
  processKnowledgeAndBenchmark,
  sendDesktopNotification,
} from "./post-turn";
import { RateLimiter } from "./rate-limiter";
// Extracted modules
import { estimateToolDefinitionTokens, executeModelRequest } from "./request-builder";
import { generateCacheKey, getCachedResponse } from "./response-cache";
import {
  classifyEmptyResponse,
  handleEmptyResponseRetry,
  handleIntentionSuggestions,
  handleMaxTokensContinue,
  handlePostTurnNotifications,
  handleTruncationRetry,
} from "./response-handlers";
// routeToModel moved to conversation-retry.ts
import {
  accumulateUsage as _accumulateUsage,
  getModifiedFiles as _getModifiedFiles,
  getRecentMessageText as _getRecentMessageText,
  hashString as _hashString,
} from "./conversation-state";
import {
  checkBudgetLimit,
  detectCheckpointMode,
  detectTheoreticalMode,
  evaluateOutputBudgetHint,
  injectSmartContext,
} from "./conversation-message-prep";
import type { SSEChunk } from "./sse-parser";
import {
  handleCheckpointMode,
  handleForceStop,
  handlePlanCoherence,
  handleTheoreticalMode,
} from "./stop-conditions";
import { SystemPromptBuilder } from "./system-prompt";
import { CHARS_PER_TOKEN } from "./token-budget";
import { extractToolCallsFromText } from "./tool-call-extractor";
import { executeToolsParallel, executeToolsSequential, preFilterToolCalls } from "./tool-executor";
import type { ToolRegistry } from "./tool-registry";
import { TranscriptManager } from "./transcript";
import type {
  ContentBlock,
  ConversationState,
  KCodeConfig,
  Message,
  StreamEvent,
  TokenUsage,
  ToolResultBlock,
  ToolUseBlock,
  TurnCostEntry,
} from "./types";
import { UndoManager } from "./undo";
import { getUserModel } from "./user-model";

// ─── Constants ───────────────────────────────────────────────────

const DEFAULT_CONTEXT_WINDOW = 32_000;
// Context window margin removed — compactThreshold (default 0.75) is used instead
const MAX_RETRIES = 2;

// Re-export prompt analysis functions (extracted to prompt-analysis.ts)
import {
  dedupContinuation,
  detectLanguage,
  looksCheckpointed,
  looksIncomplete,
  looksTheoretical,
} from "./prompt-analysis";

export { dedupContinuation, detectLanguage, looksCheckpointed, looksIncomplete, looksTheoretical };

// looksCheckpointed and dedupContinuation extracted to prompt-analysis.ts

// ─── Retry Logic (extracted to conversation-retry.ts) ────────────
import {
  createStreamWithRetry as _createStreamWithRetry,
  isRetryableError,
  computeRetryDelay,
  sleep,
} from "./conversation-retry";

// Re-export for any consumers that may have imported these
export { isRetryableError, computeRetryDelay, sleep };

// ─── Checkpoint Logic (extracted to conversation-checkpoint.ts) ──
import {
  type Checkpoint,
  MAX_CHECKPOINTS,
  saveCheckpoint as _saveCheckpoint,
  rewindToCheckpoint as _rewindToCheckpoint,
  listCheckpoints as _listCheckpoints,
  getCheckpointCount as _getCheckpointCount,
} from "./conversation-checkpoint";

// ─── Session Logic (extracted to conversation-session.ts) ────────
import {
  forkConversation as _forkConversation,
  restoreMessages as _restoreMessages,
  collectSessionData as _collectSessionData,
  formatCostBreakdown as _formatCostBreakdown,
  createFreshState,
} from "./conversation-session";

// ─── Conversation Manager ────────────────────────────────────────

export class ConversationManager {
  private config: KCodeConfig;
  private state: ConversationState;
  private tools: ToolRegistry;
  private systemPrompt: string;
  private _systemPromptReady: Promise<void>;
  private contextWindowSize: number;
  private maxRetries: number;
  private cumulativeUsage: TokenUsage;
  private permissions: PermissionManager;
  private hooks: HookManager;
  private rateLimiter: RateLimiter;
  private undoManager: UndoManager;
  private transcript: TranscriptManager;
  private compactThreshold: number;
  private checkpoints: Checkpoint[] = [];
  private abortController: AbortController | null = null;
  private _theoreticalMode = false;
  private _theoreticalRetries = 0;
  private _checkpointMode = false;
  private _checkpointToolCount = 0;
  private _activeGuardState: import("./agent-loop-guards").LoopGuardState | null = null;
  private turnsSincePromptRebuild = 0;
  private systemPromptHash = "";
  private sessionStartTime = Date.now();
  private sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  private static MAX_TURN_COSTS = 500; // cap to prevent unbounded memory growth
  private turnCosts: TurnCostEntry[] = [];
  private debugTracer: DebugTracer | null = null;
  private turnsSinceLastExtraction = 0;

  constructor(config: KCodeConfig, tools: ToolRegistry) {
    this.config = { ...config }; // shallow copy to avoid mutating caller's config
    this.tools = tools;

    // Apply model profile adjustments for small models
    try {
      const { getModelProfile } = require("./model-profile") as typeof import("./model-profile");
      const profile = getModelProfile(config.model);
      log.info(
        "session",
        `Model profile: ${profile.size} (maxTokens=${profile.maxTokens}, turns=${profile.maxAgentTurns}, prompt=${profile.promptMode})`,
      );

      // Only override if user hasn't set explicit values
      if (!config.maxTokens || config.maxTokens === 16384) {
        config.maxTokens = profile.maxTokens;
      }
      if (profile.compactThreshold < (config.compactThreshold ?? 0.75)) {
        config.compactThreshold = profile.compactThreshold;
      }
    } catch {
      /* module not loaded */
    }

    this.systemPrompt = ""; // initialized async via initSystemPrompt()
    this.systemPromptHash = "";
    this._systemPromptReady = this.initSystemPrompt();
    this.contextWindowSize = config.contextWindowSize ?? DEFAULT_CONTEXT_WINDOW;
    this.compactThreshold = config.compactThreshold ?? 0.75;
    this.maxRetries = config.maxRetries ?? MAX_RETRIES;
    this.permissions = new PermissionManager(
      config.permissionMode,
      config.workingDirectory,
      config.additionalDirs,
      config.permissionRules,
    );
    this.hooks = new HookManager(config.workingDirectory);

    // Anchor tools (Glob, Grep) to the session's working directory
    const { setToolWorkspace } =
      require("../tools/workspace") as typeof import("../tools/workspace");
    setToolWorkspace(config.workingDirectory);
    this.rateLimiter = new RateLimiter(
      config.rateLimit?.maxPerMinute ?? 60,
      config.rateLimit?.maxConcurrent ?? 2,
    );
    this.undoManager = new UndoManager();
    this.transcript = new TranscriptManager();
    this.state = {
      messages: [],
      tokenCount: 0,
      toolUseCount: 0,
    };
    this.cumulativeUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };

    // Initialize audit logging if enabled by managed policy
    if (config.auditLog) {
      try {
        const { initAuditLogger, auditLog } = require("./audit-logger.js");
        initAuditLogger({ enabled: true, orgId: config.orgId });
        auditLog({
          eventType: "session_start",
          action: `Session started (model: ${config.model})`,
          status: "success",
          model: config.model,
          sessionId: this.sessionId,
          orgId: config.orgId,
        });
      } catch (err) {
        log.debug("audit", "Failed to initialize audit logger: " + err);
      }
    }
  }

  /** Build system prompt asynchronously (distillation requires async Pro check). */
  private async initSystemPrompt(): Promise<void> {
    const toolOverhead = estimateToolDefinitionTokens(this.tools);
    this.systemPrompt = await SystemPromptBuilder.build(
      this.config,
      this.config.version,
      toolOverhead,
    );
    this.systemPromptHash = this.hashString(this.systemPrompt);
  }

  /** Access the permission manager (e.g., to set the prompt callback from the UI). */
  getPermissions(): PermissionManager {
    return this.permissions;
  }

  /** Set the sudo password prompt callback (called from UI layer). */
  setSudoPasswordPromptFn(fn: SudoPasswordPromptFn | undefined): void {
    _setSudoPasswordPromptFn(fn);
  }

  /** Access the hook manager (e.g., to force reload). */
  getHooks(): HookManager {
    return this.hooks;
  }

  /** Access the undo manager (e.g., for /undo command). */
  getUndo(): UndoManager {
    return this.undoManager;
  }

  /** Access the rate limiter (e.g., for /ratelimit dashboard). */
  getRateLimiter(): RateLimiter {
    return this.rateLimiter;
  }

  /** Access the config (e.g., for /config inspector). */
  getConfig(): KCodeConfig {
    return this.config;
  }

  /** Override the session ID (e.g., from --session-id flag). */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /**
   * Detect and restore coordinator mode from a previous session.
   * Checks if a scratchpad exists for this session ID and injects progress context.
   */
  async detectAndRestoreCoordinatorMode(): Promise<boolean> {
    const { detectCoordinatorSession, loadCoordinatorProgress } = await import(
      "./coordinator/coordinator.js"
    );
    if (!this.sessionId || !detectCoordinatorSession(this.sessionId)) {
      return false;
    }

    // Restore coordinator env
    process.env.KCODE_COORDINATOR_MODE = "coordinator";

    // Load previous progress and inject as context
    const progress = loadCoordinatorProgress(this.sessionId);
    if (progress) {
      this.messages.unshift({
        role: "user",
        content: `[Coordinator session restored]\n\nPrevious progress:\n${progress}`,
      });
    }

    return true;
  }

  /** Attach a debug tracer for agent decision logging. */
  setDebugTracer(tracer: DebugTracer): void {
    this.debugTracer = tracer;
  }

  /** Get the attached debug tracer (if any). */
  getDebugTracer(): DebugTracer | null {
    return this.debugTracer;
  }

  /** Get the effective max agent turns based on effort level. */
  private getEffectiveMaxTurns(): number {
    // Use configured effort level, or auto-detect from recent messages
    let level = this.config.effortLevel;
    if (!level) {
      try {
        const { classifyEffort } =
          require("./effort-classifier") as typeof import("./effort-classifier");
        const recentUserMsg =
          this.state.messages
            .filter((m) => m.role === "user")
            .map((m) => (typeof m.content === "string" ? m.content : ""))
            .pop() ?? "";
        if (recentUserMsg) {
          const result = classifyEffort(recentUserMsg);
          if (result.confidence >= 0.5) level = result.level;
        }
      } catch {
        /* effort-classifier not available, use default */
      }
    }

    switch (level) {
      case "low":
        return 5;
      case "high":
        return 40;
      case "max":
        return 60;
      default:
        return MAX_AGENT_TURNS; // "medium" or unset = 25
    }
  }

  /** Abort the current LLM request / agent loop. */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      log.info("session", "Request aborted by user");
    }
  }

  /** Whether a request is currently in progress. */
  get isRunning(): boolean {
    return this.abortController !== null;
  }

  /**
   * Send a user message and get back an async generator of StreamEvents.
   * The generator runs the full agent loop: streaming response, tool execution, repeat.
   */
  async *sendMessage(userMessage: string): AsyncGenerator<StreamEvent> {
    // Ensure system prompt is built (async due to Pro check in distillation)
    await this._systemPromptReady;

    // Adaptive prompt: rebuild on first message so local models get lite prompt
    // for simple queries (e.g., "hola") instead of the full 8K+ prompt.
    if (this.state.messages.length === 0) {
      const toolOverhead = estimateToolDefinitionTokens(this.tools);
      const candidate = await SystemPromptBuilder.build(
        this.config,
        this.config.version,
        toolOverhead,
        userMessage,
      );
      this.systemPrompt = candidate;
      this.systemPromptHash = this.hashString(candidate);
    }

    // Session limit check: enforce 50/month cap for free users (first message only)
    if (this.state.messages.length === 0) {
      const { checkSessionLimit } = await import("./pro.js");
      await checkSessionLimit();
    }

    // Budget guard: check if session has exceeded max budget (delegated to conversation-message-prep)
    for await (const evt of checkBudgetLimit(this.config, this.cumulativeUsage)) {
      yield evt;
      if (evt.type === "turn_end") return;
    }

    // Start transcript session on first message (skip if --no-session-persistence)
    if (!this.config.noSessionPersistence) {
      if (!this.transcript.isActive) {
        this.transcript.startSession(userMessage, this.config.sessionName);
      } else {
        this.transcript.append("user", "user_message", userMessage);
      }
    }

    // Auto-detect theoretical/formal prompts (delegated to conversation-message-prep)
    const theoreticalResult = detectTheoreticalMode(userMessage);
    this._theoreticalMode = theoreticalResult.isTheoretical;
    if (theoreticalResult.isTheoretical) this._theoreticalRetries = 0;
    for (const msg of theoreticalResult.injectedMessages) this.state.messages.push(msg);

    // Auto-detect staged/checkpoint requests (delegated to conversation-message-prep)
    const checkpointResult = await detectCheckpointMode(userMessage);
    this._checkpointMode = checkpointResult.isCheckpoint;
    if (checkpointResult.isCheckpoint) this._checkpointToolCount = 0;
    for (const msg of checkpointResult.injectedMessages) this.state.messages.push(msg);

    // Output budget hint (delegated to conversation-message-prep)
    const budgetHint = await evaluateOutputBudgetHint(
      userMessage, this.config.maxTokens, this.state.tokenCount, this.contextWindowSize,
    );
    if (budgetHint) this.state.messages.push(budgetHint);

    // Begin response session for turn isolation
    try {
      const { beginResponseSession } = await import("./response-session.js");
      beginResponseSession(this.state.messages.length);
    } catch {
      /* module not loaded */
    }

    this.state.messages.push({ role: "user", content: userMessage });

    // Layer 7: Update user model from message signals
    try {
      getUserModel().updateFromMessage(userMessage);
    } catch (err) {
      log.debug("user-model", "Failed to update user model from message: " + err);
    }

    // Layer 9: Reset intention engine for new turn
    try {
      getIntentionEngine().reset();
    } catch (err) {
      log.debug("intention", "Failed to reset intention engine: " + err);
    }

    // Smart context + RAG + skills injection (delegated to conversation-message-prep)
    const contextMessages = await injectSmartContext(
      userMessage, this.state.messages, this.config.workingDirectory,
    );
    for (const msg of contextMessages) this.state.messages.push(msg);

    // Auto-save checkpoint before each agent loop starts
    try {
      this.saveCheckpoint("auto:agent-loop-start");
    } catch (err) {
      log.warn("checkpoint", "Failed to save pre-loop checkpoint: " + err);
    }

    // Wrap the agent loop to record events to transcript
    for await (const event of this.runAgentLoop()) {
      this.recordTranscriptEvent(event);
      yield event;
    }
  }

  private recordTranscriptEvent(event: StreamEvent): void {
    switch (event.type) {
      case "text_delta":
        // Text deltas are accumulated — we record the final text in turn_end via messages
        break;
      case "thinking_delta":
        break;
      case "tool_executing":
        this.transcript.append(
          "assistant",
          "tool_use",
          JSON.stringify({
            id: event.toolUseId,
            name: event.name,
            input: event.input,
          }),
        );
        break;
      case "tool_result":
        this.transcript.append(
          "tool",
          "tool_result",
          JSON.stringify({
            tool_use_id: event.toolUseId,
            name: event.name,
            content: (event.result ?? "").slice(0, 2000),
            is_error: event.isError,
          }),
        );
        // Track error fingerprints for retry discipline
        if (event.isError && event.result && this._activeGuardState) {
          const burned = this._activeGuardState.recordToolError(event.name, event.result);
          if (burned) {
            log.warn(
              "session",
              `Tool error fingerprint burned: ${event.name} — same error seen twice, will block retries`,
            );
          }
        }
        break;
      case "error":
        this.transcript.append("system", "error", event.error.message);
        break;
      case "turn_end": {
        // Record the final assistant text from the last message
        const lastMsg = this.state.messages[this.state.messages.length - 1];
        if (lastMsg?.role === "assistant" && Array.isArray(lastMsg.content)) {
          for (const block of lastMsg.content) {
            if (block.type === "text") {
              this.transcript.append("assistant", "assistant_text", block.text);
            } else if (block.type === "thinking") {
              this.transcript.append("assistant", "thinking", block.thinking);
            }
          }
        }
        break;
      }
    }
  }

  /**
   * Agent loop: stream a response from the LLM, collect tool calls, execute them, and loop.
   * Stops when the LLM's finish_reason is "stop" or there are no tool calls.
   */
  private async *runAgentLoop(): AsyncGenerator<StreamEvent> {
    this.abortController = new AbortController();
    let turnCount = 0;
    const guardState = new LoopGuardState(
      this.config.managedDisallowedTools,
      this.config.allowedTools,
      this.config.disallowedTools,
    );
    this._activeGuardState = guardState;
    const turnStartMs = Date.now();
    // Track the last ~300 chars of text from the previous turn iteration so that
    // when a truncation retry re-streams overlapping content we can deduplicate it
    // via mergeContFn. This variable is read/written deep inside the while-loop
    // (~500 lines below) but must be declared here because its value persists
    // across loop iterations. A future refactor of runAgentLoop into smaller
    // functions should encapsulate this state (see L5 audit finding).
    let previousTurnTail = "";

    while (true) {
      // Hard break after force-stop allowed one final text turn
      if (guardState.forceStopLoop) {
        log.warn("session", "Force-stop: breaking agent loop after final text turn");
        yield { type: "turn_end", stopReason: "force_stop" };
        this.abortController = null;
        return;
      }

      turnCount++;

      // Periodically rebuild system prompt (includes dynamic data like git status, user model)
      this.turnsSincePromptRebuild++;
      if (this.turnsSincePromptRebuild >= 5) {
        const candidate = await SystemPromptBuilder.build(
          this.config,
          this.config.version,
          estimateToolDefinitionTokens(this.tools),
        );
        const candidateHash = this.hashString(candidate);
        if (candidateHash !== this.systemPromptHash) {
          this.systemPrompt = candidate;
          this.systemPromptHash = candidateHash;
          log.info("session", "System prompt rebuilt (content changed)");
        }
        this.turnsSincePromptRebuild = 0;
      }

      const effectiveMaxTurns = this.getEffectiveMaxTurns();
      if (turnCount > effectiveMaxTurns + 1) {
        log.warn("session", `Agent loop hard-killed at turn ${turnCount} — model refused to stop`);
        yield { type: "turn_end", stopReason: "force_stop" };
        this.abortController = null;
        return;
      } else if (turnCount > effectiveMaxTurns) {
        log.warn("session", `Agent loop exceeded ${effectiveMaxTurns} turns, forcing stop`);
        if (this.debugTracer?.isEnabled()) {
          this.debugTracer.traceGuard(
            "max-turns",
            true,
            `Turn ${turnCount} exceeds limit of ${effectiveMaxTurns} (effort: ${this.config.effortLevel ?? "medium"})`,
          );
        }
        this.state.messages.push({
          role: "user",
          content: `[SYSTEM] STOP. You have used ${turnCount} consecutive tool turns. Summarize what you accomplished and stop. Do NOT make any more tool calls.`,
        });
        guardState.forceStopLoop = true;
      } else if (turnCount === 15) {
        this.state.messages.push({
          role: "user",
          content:
            "[SYSTEM] You have been running tools for 15 turns. Please wrap up your current task soon and report your progress. Only continue if you are close to finishing.",
        });
      }

      if (this.abortController?.signal.aborted) {
        yield { type: "turn_end", stopReason: "aborted" };
        this.abortController = null;
        return;
      }

      // Prune context if approaching the limit (auto-compacts via LLM when possible)
      if (this.debugTracer?.isEnabled()) {
        const preTokens = estimateContextTokens(this.systemPrompt, this.state.messages);
        const threshold = this.contextWindowSize * this.compactThreshold;
        if (preTokens >= threshold) {
          this.debugTracer.trace(
            "context",
            "Compaction triggered",
            `Estimated ${preTokens} tokens >= threshold ${Math.floor(threshold)} (${Math.round(this.compactThreshold * 100)}% of ${this.contextWindowSize})`,
            { tokens: preTokens, threshold: Math.floor(threshold) },
          );
        }
      }
      yield* pruneMessagesIfNeeded(
        this.state,
        this.systemPrompt,
        this.contextWindowSize,
        this.compactThreshold,
        this.config,
      );

      // Hard safety: emergency prune if still over 95%
      for (const evt of emergencyPrune(this.state, this.systemPrompt, this.contextWindowSize)) {
        yield evt;
      }

      yield { type: "turn_start" };

      const assistantContent: ContentBlock[] = [];
      let toolCalls: ToolUseBlock[] = [];
      let stopReason = "end_turn";
      let turnInputTokens = 0;
      let turnOutputTokens = 0;
      let thinkingChunks: string[] = [];

      const activeToolCalls = new Map<number, { id: string; name: string; argChunks: string[] }>();
      const textChunks: string[] = [];

      // Check response cache before making API call
      const cacheDisabled = this.config.noCache || this.config.thinking;
      const cacheKey = cacheDisabled
        ? ""
        : generateCacheKey(
            this.config.model,
            this.state.messages.map((m) => ({
              role: m.role,
              content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            })),
            this.systemPrompt,
          );
      const cachedText = cacheKey ? getCachedResponse(cacheKey) : null;
      if (cachedText) {
        log.info("cache", "Cache hit — replaying response");
        const words = cachedText.split(" ");
        for (let wi = 0; wi < words.length; wi++) {
          const chunk = (wi > 0 ? " " : "") + words[wi];
          yield { type: "text_delta", text: chunk };
          textChunks.push(chunk);
        }
        assistantContent.push({ type: "text", text: cachedText });
        this.state.messages.push({ role: "assistant", content: cachedText });
        yield { type: "turn_end", stopReason: "end_turn" };
        break;
      }

      // Ensemble: try multi-model consensus if enabled and triggered
      try {
        if (this.config.ensemble?.enabled && this.turnCount === 1) {
          const { EnsembleOrchestrator } = await import("./ensemble/orchestrator.js");
          const orchestrator = new EnsembleOrchestrator(
            {
              execute: async (model, msgs, maxTokens) => {
                const start = Date.now();
                const { executeModelRequest: execReq } = await import("./request-builder.js");
                const stream = await execReq(
                  model,
                  this.config,
                  this.systemPrompt,
                  msgs,
                  this.tools,
                  null,
                );
                let content = "";
                for await (const chunk of stream) {
                  if (chunk.type === "content" && chunk.text) content += chunk.text;
                }
                return {
                  content,
                  tokensUsed: Math.round(content.length / 4),
                  durationMs: Date.now() - start,
                };
              },
            },
            { ...this.config.ensemble, enabled: true },
          );

          const recentText =
            this.state.messages
              .filter((m) => m.role === "user")
              .map((m) => (typeof m.content === "string" ? m.content : ""))
              .pop() ?? "";

          const result = await orchestrator.tryRun(
            this.state.messages,
            recentText,
            this.cumulativeUsage.inputTokens,
          );
          if (result) {
            // Ensemble produced a response — emit as text deltas
            for (let i = 0; i < result.finalResponse.length; i += 20) {
              yield { type: "text_delta" as const, text: result.finalResponse.slice(i, i + 20) };
            }
            assistantContent.push({ type: "text", text: result.finalResponse });
            this.state.messages.push({ role: "assistant", content: result.finalResponse });
            log.info("ensemble", `Ensemble response via ${result.strategy}: ${result.reasoning}`);
            yield { type: "turn_end", stopReason: "end_turn" };
            break;
          }
        }
      } catch (err) {
        log.debug("ensemble", `Ensemble skipped: ${err}`);
      }

      // Stream the API response with retry logic
      let sseStream: AsyncGenerator<SSEChunk>;
      try {
        await this.rateLimiter.acquire();
        sseStream = await this.createStreamWithRetry();
      } catch (error) {
        this.rateLimiter.release();
        yield {
          type: "error",
          error: error instanceof Error ? error : new Error(String(error)),
          retryable: false,
        };
        yield { type: "turn_end", stopReason: "error" };
        return;
      }

      let streamedOutputChars = 0;

      try {
        for await (const chunk of sseStream) {
          switch (chunk.type) {
            case "thinking_delta": {
              if (chunk.thinking) {
                thinkingChunks.push(chunk.thinking);
                streamedOutputChars += chunk.thinking.length;
                yield { type: "thinking_delta", thinking: chunk.thinking };
              }
              break;
            }

            case "content_delta": {
              if (chunk.content) {
                if (thinkingChunks.length > 0) {
                  const fullThinking = thinkingChunks.join("");
                  if (fullThinking.trim()) {
                    assistantContent.push({ type: "thinking", thinking: fullThinking });
                  }
                  thinkingChunks = [];
                }
                textChunks.push(chunk.content);
                streamedOutputChars += chunk.content.length;
                yield { type: "text_delta", text: chunk.content };
                const estimatedTokens = Math.round(streamedOutputChars / CHARS_PER_TOKEN);
                yield { type: "token_count", tokens: estimatedTokens };
              }
              break;
            }

            case "tool_call_delta": {
              const idx = chunk.toolCallIndex ?? 0;
              let active = activeToolCalls.get(idx);

              if (chunk.toolCallId && chunk.functionName) {
                active = { id: chunk.toolCallId, name: chunk.functionName, argChunks: [] };
                activeToolCalls.set(idx, active);
                yield {
                  type: "tool_use_start",
                  toolUseId: chunk.toolCallId,
                  name: chunk.functionName,
                };
              } else if (!active && chunk.toolCallId) {
                active = { id: chunk.toolCallId, name: "", argChunks: [] };
                activeToolCalls.set(idx, active);
              } else if (!active && chunk.functionName) {
                const id = `call_${Date.now()}_${idx}`;
                active = { id, name: chunk.functionName, argChunks: [] };
                activeToolCalls.set(idx, active);
                yield { type: "tool_use_start", toolUseId: id, name: chunk.functionName };
              }

              if (active && chunk.functionName && !active.name) {
                active.name = chunk.functionName;
                yield { type: "tool_use_start", toolUseId: active.id, name: active.name };
              }

              if (active && chunk.functionArgDelta) {
                active.argChunks.push(chunk.functionArgDelta);
                streamedOutputChars += chunk.functionArgDelta.length;
                yield {
                  type: "tool_input_delta",
                  toolUseId: active.id,
                  partialJson: chunk.functionArgDelta,
                };
                const estimatedTokens = Math.round(streamedOutputChars / CHARS_PER_TOKEN);
                yield { type: "token_count", tokens: estimatedTokens };
              }
              break;
            }

            case "finish": {
              if (chunk.finishReason === "tool_calls") {
                stopReason = "tool_use";
              } else if (chunk.finishReason === "stop") {
                stopReason = "end_turn";
              } else if (chunk.finishReason === "length") {
                stopReason = "max_tokens";
              } else {
                stopReason = chunk.finishReason ?? "end_turn";
              }
              break;
            }

            case "usage": {
              const usage: TokenUsage = {
                inputTokens: chunk.promptTokens ?? 0,
                outputTokens: chunk.completionTokens ?? 0,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
              };
              turnInputTokens += usage.inputTokens;
              turnOutputTokens += usage.outputTokens;
              this.accumulateUsage(usage);
              yield { type: "usage_update", usage: { ...this.cumulativeUsage } };
              break;
            }
          }
        }
      } catch (error) {
        yield {
          type: "error",
          error: error instanceof Error ? error : new Error(String(error)),
          retryable: false,
        };
        yield { type: "turn_end", stopReason: "error" };
        return;
      } finally {
        this.rateLimiter.release();
      }

      // Finalize any remaining thinking
      if (thinkingChunks.length > 0) {
        const fullThinking = thinkingChunks.join("");
        if (fullThinking.trim()) {
          assistantContent.push({ type: "thinking", thinking: fullThinking });
        }
        thinkingChunks = [];
      }

      // Finalize text content
      const fullText = textChunks.join("");

      // Extract tool calls from text when the model doesn't use native tool_calls
      if (activeToolCalls.size === 0 && fullText.length > 0) {
        const extracted = extractToolCallsFromText(fullText, this.tools);
        if (extracted.length > 0) {
          if (extracted[0]!.prefixText.trim()) {
            assistantContent.push({ type: "text", text: extracted[0]!.prefixText.trim() });
          }
          for (const ext of extracted) {
            const toolBlock: ToolUseBlock = {
              type: "tool_use",
              id: `toolu_text_${crypto.randomUUID().slice(0, 8)}`,
              name: ext.name,
              input: ext.input,
            };
            assistantContent.push(toolBlock);
            toolCalls.push(toolBlock);
          }
          stopReason = "tool_use";
        } else if (fullText.length > 0) {
          assistantContent.push({ type: "text", text: fullText });
        }
      } else if (fullText.length > 0) {
        assistantContent.push({ type: "text", text: fullText });
      }

      // Finalize tool calls from streaming
      for (const [, active] of activeToolCalls) {
        const fullJson = active.argChunks.join("");
        let parsedInput: Record<string, unknown> = {};
        if (fullJson.length > 0) {
          try {
            parsedInput = JSON.parse(fullJson);
          } catch (err) {
            log.debug(
              "parse",
              "Failed to parse tool call JSON (" + fullJson.length + " chars): " + err,
            );
            if (fullJson.length > 50000) {
              parsedInput = {
                _parseError: true,
                _raw: `[truncated: ${fullJson.length} chars of malformed JSON]`,
              };
              log.warn("llm", `Truncated malformed tool args: ${fullJson.length} chars`);
            } else {
              // Store raw text for debugging but mark as unparsed — tool handlers should
              // check for _parseError and reject the input rather than using _raw directly
              parsedInput = { _parseError: true, _raw: fullJson };
            }
          }
        }
        const toolBlock: ToolUseBlock = {
          type: "tool_use",
          id: active.id,
          name: active.name,
          input: parsedInput,
        };
        assistantContent.push(toolBlock);
        toolCalls.push(toolBlock);
      }

      // Store assistant message in conversation history
      this.state.messages.push({ role: "assistant", content: assistantContent });

      // ─── Stop condition checks (delegated to stop-conditions.ts) ───

      // Force-stop: refuse to execute any more tools
      const forceStopResult = handleForceStop(
        guardState.forceStopLoop,
        toolCalls,
        assistantContent,
      );
      if (forceStopResult.action !== "pass") {
        if (forceStopResult.updatedContent) {
          this.state.messages[this.state.messages.length - 1] = {
            role: "assistant",
            content: forceStopResult.updatedContent,
          };
        }
        yield { type: "turn_end", stopReason: forceStopResult.stopReason! };
        this.abortController = null;
        return;
      }

      // Theoretical mode: drop tool calls and force text-only
      const theoreticalResult = handleTheoreticalMode(
        this._theoreticalMode,
        toolCalls,
        assistantContent,
        this._theoreticalRetries ?? 0,
      );
      if (theoreticalResult.action !== "pass") {
        this._theoreticalRetries = theoreticalResult.newRetryCount;
        if (theoreticalResult.updatedContent) {
          this.state.messages[this.state.messages.length - 1] = {
            role: "assistant",
            content: theoreticalResult.updatedContent,
          };
        }
        if (theoreticalResult.error) {
          yield { type: "error", error: theoreticalResult.error, retryable: false };
        }
        if (theoreticalResult.injectMessage) {
          this.state.messages.push({ role: "user", content: theoreticalResult.injectMessage });
        }
        yield { type: "turn_end", stopReason: theoreticalResult.stopReason! };
        if (theoreticalResult.action === "break") return;
        continue;
      }

      // Checkpoint mode: stop after enough tools for initial setup
      const checkpointResult = handleCheckpointMode(
        this._checkpointMode,
        toolCalls,
        this._checkpointToolCount,
        assistantContent,
      );
      if (checkpointResult.action !== "pass") {
        this._checkpointToolCount = checkpointResult.newToolCount;
        if (checkpointResult.updatedContent) {
          this.state.messages[this.state.messages.length - 1] = {
            role: "assistant",
            content: checkpointResult.updatedContent,
          };
        }
        if (checkpointResult.injectMessage) {
          this.state.messages.push({ role: "user", content: checkpointResult.injectMessage });
        }
        if (checkpointResult.setForceStop) {
          this._checkpointMode = false;
          guardState.forceStopLoop = true;
        }
        yield { type: "turn_end", stopReason: checkpointResult.stopReason! };
        continue;
      } else {
        this._checkpointToolCount = checkpointResult.newToolCount;
      }

      // Plan coherence: validate execution against active plan step (delegated to stop-conditions.ts)
      const planResult = await handlePlanCoherence(toolCalls, assistantContent);
      if (planResult.setForceStop) {
        guardState.forceStopLoop = true;
        const textOnly = assistantContent.filter((b) => b.type === "text");
        this.state.messages[this.state.messages.length - 1] = {
          role: "assistant",
          content: textOnly.length > 0 ? textOnly : [{ type: "text" as const, text: "" }],
        };
      }
      for (const msg of planResult.injectMessages) {
        this.state.messages.push({ role: "user", content: msg });
      }
      if (planResult.stopReason) {
        yield { type: "turn_end", stopReason: planResult.stopReason };
        continue;
      }
      if (planResult.blockedResults.length > 0) {
        const blockedBlocks: any[] = planResult.blockedResults.map((r) => ({
          type: "tool_result",
          tool_use_id: r.tool_use_id,
          content: r.content,
          is_error: true,
        }));
        this.state.messages.push({ role: "user", content: blockedBlocks });
        for (const r of planResult.blockedResults) {
          yield {
            type: "tool_result" as const,
            name: r.name,
            toolUseId: r.tool_use_id,
            result: r.content,
            isError: true,
          };
        }
        toolCalls = planResult.keptCalls;
        if (toolCalls.length === 0) continue;
      }

      // Record per-turn cost entry
      if (turnInputTokens > 0 || turnOutputTokens > 0) {
        try {
          const { getModelPricing, calculateCost } = await import("./pricing.js");
          const pricing = await getModelPricing(this.config.model);
          const costUsd = pricing ? calculateCost(pricing, turnInputTokens, turnOutputTokens) : 0;
          this.turnCosts.push({
            turnIndex: this.turnCosts.length + 1,
            model: this.config.model,
            inputTokens: turnInputTokens,
            outputTokens: turnOutputTokens,
            costUsd,
            toolCalls: toolCalls.map((tc) => tc.name),
            timestamp: Date.now(),
          });
          if (this.turnCosts.length > ConversationManager.MAX_TURN_COSTS) {
            this.turnCosts = this.turnCosts.slice(-ConversationManager.MAX_TURN_COSTS);
          }
        } catch (err) {
          log.debug("pricing", "Failed to track turn cost: " + err);
        }
      }

      // Client-side JSON schema validation (delegated to agent-loop-guards)
      if (this.config.jsonSchema && toolCalls.length === 0 && fullText.length > 0) {
        const { retryMessage, shouldAccept } = validateModelOutput(
          fullText,
          this.config.jsonSchema,
          guardState.jsonSchemaRetries,
        );
        if (!shouldAccept && retryMessage) {
          guardState.jsonSchemaRetries++;
          this.state.messages.push({ role: "user", content: retryMessage });
          yield { type: "turn_end", stopReason: "tool_use" };
          continue;
        }
      }

      // If no tool calls or stop reason is not tool_use, we're done
      if (toolCalls.length === 0 || stopReason !== "tool_use") {
        // Auto-continue on max_tokens
        if (stopReason === "max_tokens" && guardState.maxTokensContinuations < 3) {
          guardState.maxTokensContinuations++;
          log.info(
            "session",
            `Model hit output token limit (continuation ${guardState.maxTokensContinuations}/3) — injecting continue prompt`,
          );
          if (this.debugTracer?.isEnabled()) {
            this.debugTracer.trace(
              "decision",
              `max_tokens continuation ${guardState.maxTokensContinuations}/3`,
              "Model output was truncated, auto-continuing",
              { turn: turnCount },
            );
          }
          this.state.messages.push({
            role: "user",
            content:
              "[SYSTEM] Your previous response was cut off because you hit the output token limit. Continue EXACTLY where you left off. Do not repeat what you already said — pick up mid-sentence if needed.",
          });
          yield { type: "turn_end", stopReason: "max_tokens_continue" };
          continue;
        }

        // Layer 9: Evaluate intentions and emit suggestions (delegated to post-turn)
        const { suggestions, hasHighPrioritySuggestion } = evaluateIntentionSuggestions();
        if (suggestions.length > 0) {
          yield { type: "suggestion", suggestions };
        }

        // Auto-continue: if the model stopped but has incomplete tasks, push it to continue
        if (hasHighPrioritySuggestion && turnCount <= 3) {
          log.info("session", "Auto-continuing: model stopped with incomplete tasks");
          this.state.messages.push({
            role: "user",
            content:
              "You stopped before completing the task. Continue working — create the actual files and finish what you planned. Do not re-plan, just execute.",
          });
          yield { type: "turn_end", stopReason };
          continue;
        }

        // Cache text-only responses (delegated to post-turn)
        cacheResponseIfEligible(
          cacheKey,
          stopReason,
          toolCalls.length,
          textChunks,
          this.config.model,
          this.state.messages,
          this.state.tokenCount,
        );

        // Knowledge distillation + benchmark scoring (delegated to post-turn)
        processKnowledgeAndBenchmark(
          stopReason,
          turnCount,
          this.state.messages,
          this.config.workingDirectory,
          this.config.model,
          this.state.toolUseCount,
          this.state.tokenCount,
        );

        // Safety net: classify empty responses and retry with context-aware prompts
        const hasTextOutput = textChunks.join("").trim().length > 0;
        const hasThinkingOutput =
          thinkingChunks.length > 0 ||
          (this.state.messages.at(-1) as Record<string, unknown> | undefined)?.thinkingContent;
        const hasToolOutput = toolCalls.length > 0;

        // Classify empty responses — persisted so the final turn_end carries it
        if (!hasTextOutput && stopReason === "end_turn") {
          guardState.lastEmptyType =
            hasThinkingOutput && !hasToolOutput
              ? "thinking_only"
              : hasToolOutput && !hasThinkingOutput
                ? "tools_only"
                : hasThinkingOutput && hasToolOutput
                  ? "thinking_and_tools"
                  : "no_output";
        } else {
          guardState.lastEmptyType = undefined;
        }

        if (!hasTextOutput && stopReason === "end_turn" && guardState.emptyEndTurnCount < 2) {
          guardState.emptyEndTurnCount++;

          log.info(
            "session",
            `Empty response (${guardState.lastEmptyType}) on turn ${turnCount} — retry ${guardState.emptyEndTurnCount}/2`,
          );

          // Context-aware retry prompt — include what was done so the model can summarize
          const toolCount = this.state.toolUseCount;
          const retryPrompt =
            guardState.lastEmptyType === "thinking_only"
              ? "[SYSTEM] You reasoned but produced no visible answer. Stop thinking and answer the user directly in plain text now."
              : guardState.lastEmptyType === "tools_only" || toolCount > 0
                ? `[SYSTEM] You executed ${toolCount} tools but didn't provide any response text. You MUST now write a brief summary (3-6 sentences) of what you accomplished. Do NOT use any more tools — just respond with text.`
                : guardState.lastEmptyType === "thinking_and_tools"
                  ? "[SYSTEM] You reasoned and used tools but gave no visible answer. Provide a direct response to the user now."
                  : "[SYSTEM] Your previous turn produced no output at all. Respond directly to the user now.";

          this.state.messages.push({ role: "user", content: retryPrompt });
          yield {
            type: "turn_end",
            stopReason: "empty_response_retry",
            emptyType: guardState.lastEmptyType,
          };
          continue;
        }

        // Truncation heuristic: detect suspiciously incomplete responses
        // Check on end_turn too — llama.cpp reports "stop" even when the model hit token limits
        // (especially with thinking mode consuming most of max_tokens).
        if (hasTextOutput && (stopReason === "end_turn" || stopReason === "max_tokens")) {
          let fullText = textChunks.join("").trim();

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
              const lastMsg = this.state.messages[this.state.messages.length - 1];
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

          if (guardState.truncationRetries < 2 && looksIncomplete(fullText)) {
            guardState.truncationRetries++;
            log.info(
              "session",
              `Response looks truncated (attempt ${guardState.truncationRetries}) — pushing for continuation`,
            );
            previousTurnTail = fullText.slice(-300);
            const tail = fullText.slice(-200);
            this.state.messages.push({
              role: "user",
              content: `[SYSTEM] Your response was cut off. Here is how it ended:\n\n"…${tail}"\n\nContinue EXACTLY from that point. Do NOT repeat any previous content. Do NOT restart the response. Just write the next sentence.`,
            });
            yield { type: "turn_end", stopReason: "truncation_retry" };
            continue;
          }

          // After all retries, if still incomplete, notify the user
          if (guardState.truncationRetries >= 2 && looksIncomplete(fullText)) {
            log.warn("session", "Response still incomplete after 2 continuation retries");
            yield {
              type: "text_delta" as const,
              text: "\n\n---\n*[Response may be incomplete — model reached output limit]*\n",
            };
          }
        }

        // Fire Stop hook — can block the conversation from ending
        if (this.hooks.hasHooks("Stop")) {
          try {
            const stopResult = await this.hooks.runStopHook("Stop", {
              stopReason,
              turnCount,
              toolsUsed: this.state.toolUseCount,
            });
            if (stopResult.blocked) {
              log.info("session", `Stop hook blocked conversation end: ${stopResult.reason}`);
              this.state.messages.push({
                role: "user",
                content: `[SYSTEM] Stop hook prevented conversation end: ${stopResult.reason}. Continue the conversation.`,
              });
              yield { type: "turn_end", stopReason: "stop_hook_blocked" };
              continue;
            }
          } catch (err) {
            log.warn("hooks", `Stop hook error: ${err instanceof Error ? err.message : err}`);
          }
        }

        // Desktop notification for long-running tasks (delegated to post-turn)
        const elapsedMs = Date.now() - turnStartMs;
        if (elapsedMs > 30_000 || turnCount >= 3) {
          sendDesktopNotification(
            "KCode",
            `Task completed (${turnCount} turns, ${Math.round(elapsedMs / 1000)}s)`,
          );
        }

        // If turn had tool use but ends with no/minimal text output, emit structured
        // partial progress so the user sees what was accomplished.
        // "Minimal" = less than 20 chars of actual text (not just whitespace).
        const finalTextLen = textChunks.join("").trim().length;
        if (this.state.toolUseCount > 0 && finalTextLen < 20) {
          const elapsed = Date.now() - turnStartMs;
          const summary = this.collectSessionData();
          const lastError =
            summary.errorsEncountered > 0
              ? (this.state.messages
                  .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
                  .filter((b: any) => b.type === "tool_result" && b.is_error)
                  .map((b: any) => String(b.content ?? "").slice(0, 100))
                  .pop() ?? "")
              : "";

          yield {
            type: "partial_progress" as const,
            toolsUsed: this.state.toolUseCount,
            elapsedMs: elapsed,
            filesModified: summary.filesModified,
            lastError: lastError || undefined,
            summary: `Turn ended after ${this.state.toolUseCount} tool uses over ${Math.round(elapsed / 1000)}s`,
          };
        }

        // Close response session with appropriate status
        try {
          const { closeResponseSession, getActiveResponseSession } = await import(
            "./response-session.js"
          );
          const session = getActiveResponseSession();
          if (session) {
            const finalText = textChunks.join("").trim();
            const isComplete = finalText.length >= 20 && !looksIncomplete(finalText);
            closeResponseSession(
              isComplete ? "completed" : finalTextLen < 20 ? "failed" : "incomplete",
              stopReason,
              guardState.lastEmptyType === "no_output" ? "Model returned no text" : undefined,
            );
          }
        } catch {
          /* module not loaded */
        }

        // Auto-memory extraction: fire-and-forget background LLM call
        this.turnsSinceLastExtraction++;
        try {
          const autoMemConfig = parseAutoMemoryConfig(this.config.autoMemory ?? true);
          if (
            autoMemConfig.enabled &&
            stopReason === "end_turn" &&
            this.turnsSinceLastExtraction >= autoMemConfig.cooldownTurns
          ) {
            this.turnsSinceLastExtraction = 0;
            const recentMessages = this.state.messages.slice(-6);
            getMemoryTitles(this.config.workingDirectory)
              .then((existingTitles) => {
                runAutoMemoryExtraction({
                  recentMessages,
                  existingTitles,
                  config: autoMemConfig,
                  projectPath: this.config.workingDirectory,
                  model: this.config.tertiaryModel,
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

        yield { type: "turn_end", stopReason, emptyType: guardState.lastEmptyType };
        this.abortController = null;
        break;
      }

      // Check abort between tool calls
      if (this.abortController?.signal.aborted) {
        yield { type: "turn_end", stopReason: "aborted" };
        this.abortController = null;
        return;
      }

      // Pre-filter tool calls by managed policy and allowed/disallowed lists (delegated to tool-executor)
      let { filtered: filteredToolCalls, blockedResults } = preFilterToolCalls(
        toolCalls,
        guardState,
        this.config,
      );
      const toolResultBlocks: ContentBlock[] = [...blockedResults];

      // Check if any burned error fingerprints match — block tools that failed 2+ times with the same error
      if (guardState.burnedFingerprints.size > 0) {
        const burnedNames = new Set<string>();
        for (const fp of guardState.burnedFingerprints) {
          const toolName = fp.split("|")[0];
          if (toolName) burnedNames.add(toolName);
        }
        const notBurned: typeof filteredToolCalls = [];
        for (const tc of filteredToolCalls) {
          if (burnedNames.has(tc.name)) {
            log.warn("session", `Blocking tool call ${tc.name} — burned error fingerprint`);
            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: tc.id,
              content: `BLOCKED: This tool (${tc.name}) failed twice with the same error. You MUST try a completely different approach or explain why you cannot proceed.`,
              is_error: true,
            } satisfies ToolResultBlock);
          } else {
            notBurned.push(tc);
          }
        }
        filteredToolCalls = notBurned;
      }

      if (filteredToolCalls.length === 0) {
        this.state.messages.push({ role: "user", content: toolResultBlocks });
        continue;
      }
      toolCalls = filteredToolCalls;

      // Parallel fast-path: if ALL tool calls are read-only, execute them concurrently
      const allParallelSafe =
        toolCalls.length > 1 && toolCalls.every((c) => this.tools.isParallelSafe(c.name));
      if (allParallelSafe && this.permissions.getMode() === "auto") {
        const toolExecCtx = {
          config: this.config,
          tools: this.tools,
          permissions: this.permissions,
          hooks: this.hooks,
          undoManager: this.undoManager,
          sessionId: this.sessionId,
          contextWindowSize: this.contextWindowSize,
          abortController: this.abortController,
          toolUseCount: this.state.toolUseCount,
          debugTracer: this.debugTracer,
        };
        const gen = executeToolsParallel(toolCalls, toolExecCtx);
        let genResult = await gen.next();
        while (!genResult.done) {
          const ev = genResult.value;
          // Record error fingerprints inline so they're available for the next iteration
          if (ev.type === "tool_result" && ev.isError && ev.result) {
            guardState.recordToolError(ev.name, ev.result);
          }
          yield ev;
          genResult = await gen.next();
        }
        const parallelResults = genResult.value;
        this.state.toolUseCount = toolExecCtx.toolUseCount;
        toolResultBlocks.push(...parallelResults);
        this.state.messages.push({ role: "user", content: toolResultBlocks });
        continue;
      }

      // Sequential execution with full permission/dedup/loop guards (delegated to tool-executor)
      // Auto-checkpoint before file modifications
      for (const call of toolCalls) {
        if (call.name === "Edit" || call.name === "Write" || call.name === "MultiEdit") {
          try {
            this.saveCheckpoint(`auto:before-${call.name}`);
          } catch (err) {
            log.warn("checkpoint", "Failed to save pre-edit checkpoint: " + err);
          }
          break; // only need one checkpoint per batch
        }
      }

      const toolExecCtx = {
        config: this.config,
        tools: this.tools,
        permissions: this.permissions,
        hooks: this.hooks,
        undoManager: this.undoManager,
        sessionId: this.sessionId,
        contextWindowSize: this.contextWindowSize,
        abortController: this.abortController,
        toolUseCount: this.state.toolUseCount,
        debugTracer: this.debugTracer,
      };
      const seqGen = executeToolsSequential(toolCalls, toolExecCtx, guardState);
      let seqResult = await seqGen.next();
      while (!seqResult.done) {
        const ev = seqResult.value;
        // Record error fingerprints inline for retry discipline
        if (ev.type === "tool_result" && ev.isError && ev.result) {
          guardState.recordToolError(ev.name, ev.result);
        }
        yield ev;
        seqResult = await seqGen.next();
      }
      const { toolResultBlocks: seqToolResults, turnHadDenial } = seqResult.value;
      this.state.toolUseCount = toolExecCtx.toolUseCount;
      toolResultBlocks.push(...seqToolResults);

      this.state.messages.push({ role: "user", content: toolResultBlocks });

      // Semantic loop redirect: check if any pattern has crossed the threshold
      for (const [pattern, entry] of guardState.loopPatterns) {
        if (entry.count >= LOOP_PATTERN_HARD_STOP) {
          const examples = entry.examples.join("\n  - ");
          entry.redirects++;
          const redirectMsg = `[SYSTEM — STRATEGY CHANGE REQUIRED] You have run ${entry.count} similar "${pattern}" commands (redirect #${entry.redirects}):\n  - ${examples}\n\nThis approach is not working. You MUST now try a COMPLETELY DIFFERENT technique. Think about what other tools, protocols, or methods could achieve the user's goal. Change strategy and KEEP WORKING — do not give up.`;
          this.state.messages.push({ role: "user", content: redirectMsg });
          log.warn(
            "session",
            `Loop redirect #${entry.redirects} for pattern "${pattern}" (${entry.count} calls) — forcing strategy change`,
          );
          entry.count = 0;
          entry.examples = [];
          break;
        } else if (entry.count >= LOOP_PATTERN_THRESHOLD && entry.warned) {
          const redirectMsg = `[SYSTEM — PATTERN NOTICE] You have run ${entry.count} similar "${pattern}" commands. This approach doesn't seem to be working. Try a different strategy — different tools, different protocols, different angle. Keep working toward the user's goal.`;
          this.state.messages.push({ role: "user", content: redirectMsg });
          log.info(
            "session",
            `Loop redirect SOFT injected for pattern "${pattern}" (${entry.count} calls)`,
          );
          entry.warned = false;
          break;
        }
      }

      // Mid-loop budget guard: warn at 80%, stop at 100%
      if (this.config.maxBudgetUsd && this.config.maxBudgetUsd > 0) {
        try {
          const { getModelPricing, calculateCost } = await import("./pricing.js");
          const pricing = await getModelPricing(this.config.model);
          if (pricing) {
            const cost = calculateCost(
              pricing,
              this.cumulativeUsage.inputTokens,
              this.cumulativeUsage.outputTokens,
            );
            const pct = Math.round((cost / this.config.maxBudgetUsd) * 100);
            if (cost >= this.config.maxBudgetUsd) {
              yield {
                type: "budget_warning",
                costUsd: cost,
                limitUsd: this.config.maxBudgetUsd,
                pct: 100,
              };
              yield {
                type: "error",
                error: new Error(
                  `Budget exhausted mid-loop: $${cost.toFixed(2)} >= $${this.config.maxBudgetUsd.toFixed(2)}`,
                ),
                retryable: false,
              };
              yield { type: "turn_end", stopReason: "budget_exceeded" };
              return;
            } else if (pct >= 80) {
              yield {
                type: "budget_warning",
                costUsd: cost,
                limitUsd: this.config.maxBudgetUsd,
                pct,
              };
            }
          }
        } catch (err) {
          log.debug("budget", "Failed to check mid-loop budget: " + err);
        }
      }

      // Layer 9: Inline warning — detect wasted context mid-loop
      try {
        const inlineWarning = getIntentionEngine().getInlineWarning();
        if (inlineWarning) {
          guardState.inlineWarningCount++;
          log.warn(
            "intentions",
            `Inline warning #${guardState.inlineWarningCount}: ${inlineWarning.slice(0, 100)}`,
          );

          if (guardState.inlineWarningCount >= 5) {
            log.warn(
              "intentions",
              "Infinite loop detected: forcing agent loop stop after 5 inline warnings",
            );
            this.state.messages.push({
              role: "user",
              content: `[SYSTEM] FORCE STOP: You have been warned ${guardState.inlineWarningCount} times about repeating the same actions. The agent loop is being terminated. Reply with text only — summarize what you accomplished and what you could not complete.`,
            });
            guardState.forceStopLoop = true;
          } else if (guardState.inlineWarningCount >= 2) {
            log.warn(
              "intentions",
              `Inline warning #${guardState.inlineWarningCount}: model repeating actions, injecting strong redirect`,
            );
            this.state.messages.push({
              role: "user",
              content: `[SYSTEM] WARNING #${guardState.inlineWarningCount}: You are repeating the same tool calls. The repeated calls are being BLOCKED. MOVE ON to a different task or try a completely different approach. Do NOT keep reading the same file — use offset/limit to read different sections, or use Bash with sed/grep to find what you need.`,
            });
          } else {
            this.state.messages.push({
              role: "user",
              content: `\u26a0\ufe0f SYSTEM WARNING: ${inlineWarning}`,
            });
          }
        }
      } catch (err) {
        log.debug("intention", "Failed to generate inline warning: " + err);
      }

      // Track consecutive permission denials to prevent infinite loops
      if (turnHadDenial) {
        guardState.consecutiveDenials++;

        if (this.config.permissionMode === "deny") {
          log.info("session", "Deny mode: stopping agent loop after first denial");
          this.state.messages.push({
            role: "user",
            content:
              "[SYSTEM] Permission mode is 'deny'. All tools are blocked. Do NOT attempt any tool calls. Reply with text only, explaining that you cannot perform this action because all tools are blocked. Suggest using -p auto or -p ask.",
          });
          guardState.consecutiveDenials = MAX_CONSECUTIVE_DENIALS - 1;
        } else if (guardState.consecutiveDenials >= MAX_CONSECUTIVE_DENIALS) {
          log.warn(
            "session",
            `${MAX_CONSECUTIVE_DENIALS} consecutive permission denials, stopping agent loop`,
          );
          yield { type: "turn_end", stopReason: "permission_denied" };
          this.abortController = null;
          return;
        } else {
          this.state.messages.push({
            role: "user",
            content:
              "[SYSTEM] Tool call was denied by the permission system. Do NOT retry the same tool. Reply with a text message explaining what happened.",
          });
        }
      } else {
        guardState.consecutiveDenials = 0;
      }

      yield { type: "turn_end", stopReason };
      // Loop continues for next agent turn
    }
  }

  /**
   * Create a streaming API call with exponential backoff retry.
   * Delegates to conversation-retry.ts for the actual retry/fallback logic.
   */
  private async createStreamWithRetry(): Promise<AsyncGenerator<SSEChunk>> {
    return _createStreamWithRetry({
      config: this.config,
      systemPrompt: this.systemPrompt,
      messages: this.state.messages,
      tools: this.tools,
      maxRetries: this.maxRetries,
      abortController: this.abortController,
      debugTracer: this.debugTracer,
      getRecentMessageText: () => this.getRecentMessageText(),
    });
  }

  /** Rough estimate of current context size in tokens (delegates to context-manager). */
  private estimateContextTokens(): number {
    return estimateContextTokens(this.systemPrompt, this.state.messages);
  }

  // ─── Usage Tracking (delegated to conversation-state.ts) ────────

  private accumulateUsage(usage: TokenUsage): void {
    _accumulateUsage(this.cumulativeUsage, usage, this.state);
  }

  // ─── Router Helpers (delegated to conversation-state.ts) ───────

  private getRecentMessageText(): string {
    return _getRecentMessageText(this.state.messages);
  }

  // ─── State Access ───────────────────────────────────────────────

  getState(): ConversationState {
    return { ...this.state };
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getUsage(): TokenUsage {
    return { ...this.cumulativeUsage };
  }

  getCompactThreshold(): number {
    return this.compactThreshold;
  }

  setCompactThreshold(value: number): void {
    this.compactThreshold = Math.max(0, Math.min(0.99, value));
  }

  getTurnCosts(): TurnCostEntry[] {
    return [...this.turnCosts];
  }

  formatCostBreakdown(): string {
    return _formatCostBreakdown(this.turnCosts);
  }

  /**
   * Save a checkpoint of the current conversation state.
   * @param label Optional label for the checkpoint (defaults to auto-generated)
   */
  saveCheckpoint(label?: string): void {
    _saveCheckpoint(this.checkpoints, this.state.messages.length, this.undoManager.size, label);
  }

  /**
   * Rewind conversation to a specific checkpoint by index.
   * If no index is provided, rewinds to the most recent checkpoint.
   * Also undoes file changes back to that point.
   * Returns a description of what was rewound, or null if no checkpoints.
   */
  rewindToCheckpoint(index?: number): string | null {
    const result = _rewindToCheckpoint(this.checkpoints, this.state.messages, this.undoManager, index);
    this.checkpoints = result.updatedCheckpoints;
    this.state.messages = result.updatedMessages as Message[];
    return result.description;
  }

  /**
   * List all saved checkpoints with their labels and timestamps.
   */
  listCheckpoints(): Array<{
    index: number;
    label: string;
    messageIndex: number;
    timestamp: number;
    age: string;
  }> {
    return _listCheckpoints(this.checkpoints);
  }

  /**
   * Get number of available checkpoints.
   */
  getCheckpointCount(): number {
    return _getCheckpointCount(this.checkpoints);
  }

  /**
   * Restore messages from a previous session (for --continue).
   * Sets the message history and estimates token count from content length.
   */
  restoreMessages(messages: Message[]): void {
    const result = _restoreMessages(messages);
    this.state.messages = result.restoredMessages;
    this.state.tokenCount = result.estimatedTokenCount;
  }

  /**
   * Fork the conversation: keep current messages but start a new transcript.
   * Optionally truncate to a specific message count (fork from a point in history).
   */
  forkConversation(keepMessages?: number): { messageCount: number; sessionId: string } {
    const result = _forkConversation(
      this.state.messages,
      this.sessionId,
      this.config,
      keepMessages,
    );
    this.state.messages = result.forkedMessages;
    this.transcript = result.newTranscript;
    this.sessionId = result.newSessionId;
    return { messageCount: result.messageCount, sessionId: result.newSessionId };
  }

  /**
   * Collect session data for the narrative system (Layer 10).
   */
  collectSessionData(): {
    project: string;
    messagesCount: number;
    toolsUsed: string[];
    actionsCount: number;
    topicsDiscussed: string[];
    errorsEncountered: number;
    filesModified: string[];
  } {
    return _collectSessionData(this.state.messages, this.config.workingDirectory, this.state.toolUseCount);
  }

  /**
   * Reset conversation state for a new session.
   */
  reset(): void {
    const fresh = createFreshState();
    this.state = fresh.state;
    this.cumulativeUsage = fresh.cumulativeUsage;
    this.turnCosts = [];
  }

  /** Fast string hash for cache comparison (delegated to conversation-state.ts). */
  private hashString(str: string): string {
    return _hashString(str);
  }

  /** Get session start time for elapsed time tracking. */
  getSessionStartTime(): number {
    return this.sessionStartTime;
  }

  /** Send a desktop notification (Linux: notify-send, macOS: osascript). */
  sendNotification(title: string, body: string): void {
    sendDesktopNotification(title, body);
  }

  /** Get list of files modified in this session (delegated to conversation-state.ts). */
  getModifiedFiles(): string[] {
    return _getModifiedFiles(this.state.messages);
  }
}
