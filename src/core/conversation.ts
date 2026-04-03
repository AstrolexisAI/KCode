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
import { processSSEStream, type StreamAccumulator } from "./conversation-streaming";
import { handlePostTurn, type PostTurnContext } from "./conversation-post-turn";
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
  /** Countdown seconds when waiting for rate limit retry (0 = not waiting) */
  rateLimitCountdown = 0;
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

      let assistantContent: ContentBlock[];
      let toolCalls: ToolUseBlock[];
      let stopReason: string;
      let turnInputTokens: number;
      let turnOutputTokens: number;
      let textChunks: string[];

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

      // Stream the API response with retry logic (delegated to conversation-streaming.ts)
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

      let streamResult: StreamAccumulator;
      try {
        const streamGen = processSSEStream({
          sseStream,
          tools: this.tools,
          accumulateUsage: (usage) => this.accumulateUsage(usage),
          cumulativeUsage: this.cumulativeUsage,
        });
        // Forward all events from the stream processor
        let genResult = await streamGen.next();
        while (!genResult.done) {
          yield genResult.value;
          genResult = await streamGen.next();
        }
        streamResult = genResult.value;
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

      // Destructure accumulated stream state
      ({ assistantContent, toolCalls, stopReason, textChunks, turnInputTokens, turnOutputTokens } = streamResult);
      const fullText = textChunks.join("");

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
        const blockedBlocks: Array<{ type: string; tool_use_id: string; content: string; is_error: boolean }> = planResult.blockedResults.map((r) => ({
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

      // If no tool calls or stop reason is not tool_use — handle post-turn (delegated to conversation-post-turn.ts)
      if (toolCalls.length === 0 || stopReason !== "tool_use") {
        const postTurnResult = await handlePostTurn({
          config: this.config,
          hooks: this.hooks,
          messages: this.state.messages,
          toolUseCount: this.state.toolUseCount,
          tokenCount: this.state.tokenCount,
          turnStartMs,
          turnCount,
          turnsSinceLastExtraction: this.turnsSinceLastExtraction,
          cacheKey,
          stopReason,
          textChunks,
          thinkingChunks: streamResult.thinkingChunks,
          toolCalls,
          previousTurnTail,
          maxTokensContinuations: guardState.maxTokensContinuations,
          emptyEndTurnCount: guardState.emptyEndTurnCount,
          truncationRetries: guardState.truncationRetries,
          lastEmptyType: guardState.lastEmptyType,
          debugTracer: this.debugTracer,
          collectSessionData: () => this.collectSessionData(),
        });

        // Apply state updates from post-turn handler
        guardState.maxTokensContinuations = postTurnResult.maxTokensContinuations;
        guardState.emptyEndTurnCount = postTurnResult.emptyEndTurnCount;
        guardState.truncationRetries = postTurnResult.truncationRetries;
        guardState.lastEmptyType = postTurnResult.lastEmptyType;
        previousTurnTail = postTurnResult.previousTurnTail;
        this.turnsSinceLastExtraction = postTurnResult.turnsSinceLastExtraction;

        // Emit events
        for (const evt of postTurnResult.events) yield evt;
        // Inject messages
        for (const msg of postTurnResult.injectMessages) this.state.messages.push(msg);

        if (postTurnResult.action === "break") {
          this.abortController = null;
          break;
        }
        if (postTurnResult.action === "continue") continue;
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
      onRetryWait: (seconds) => {
        this.rateLimitCountdown = seconds;
      },
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
