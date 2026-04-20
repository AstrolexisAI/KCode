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
import { estimateContextTokens } from "./context-manager";
import { runContextMaintenance } from "./conversation-context-maintenance";
import { getEffectiveMaxTurns as _getEffectiveMaxTurns } from "./conversation-effort";
import { augmentFabricationWarnings as _augmentFabricationWarnings } from "./conversation-fabrication";
import { handleInlineWarnings } from "./conversation-inline-warnings";
import { recordTranscriptEvent as _recordTranscriptEvent } from "./conversation-transcript";
import {
  checkBudgetLimit,
  detectCheckpointMode,
  detectTheoreticalMode,
  evaluateOutputBudgetHint,
  injectSmartContext,
} from "./conversation-message-prep";
import { handlePostTurn, type PostTurnContext } from "./conversation-post-turn";
import { runPreTurnChecks } from "./conversation-pre-turn-checks";
import { runTaskRouting } from "./conversation-task-routing";
// routeToModel moved to conversation-retry.ts
import {
  accumulateUsage as _accumulateUsage,
  getModifiedFiles as _getModifiedFiles,
  getRecentMessageText as _getRecentMessageText,
  hashString as _hashString,
} from "./conversation-state";
import { processSSEStream, type StreamAccumulator } from "./conversation-streaming";
import type { DebugTracer } from "./debug-tracer";
import { HookManager } from "./hooks";
import { AutoAgentManager, type AgentStatus } from "./auto-agents";
import { StreamingToolExecutor } from "./streaming-tool-executor";
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
  computeRetryDelay,
  isRetryableError,
  sleep,
} from "./conversation-retry";

// Re-export for any consumers that may have imported these
export { computeRetryDelay, isRetryableError, sleep };

// ─── Checkpoint Logic (extracted to conversation-checkpoint.ts) ──
import {
  getCheckpointCount as _getCheckpointCount,
  listCheckpoints as _listCheckpoints,
  rewindToCheckpoint as _rewindToCheckpoint,
  saveCheckpoint as _saveCheckpoint,
  type Checkpoint,
  MAX_CHECKPOINTS,
} from "./conversation-checkpoint";

// ─── Session Logic (extracted to conversation-session.ts) ────────
import {
  collectSessionData as _collectSessionData,
  forkConversation as _forkConversation,
  formatCostBreakdown as _formatCostBreakdown,
  restoreMessages as _restoreMessages,
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
  private autoAgentManager: AutoAgentManager | null = null;
  /** Callback for Kodi panel agent status updates */
  onAgentProgress: ((statuses: AgentStatus[]) => void) | null = null;
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

    // Phase-stack session-state reset (P1 audit fix).
    // Several modules maintain module-level mutable state that survives
    // across ConversationManager instances in the same process (audit
    // read tracker, file-edit retry history, auto-launch session flag,
    // response-session tracker). Without resetting them here, starting
    // a new conversation in a long-running kcode process (daemon, /clear,
    // /resume, tmux splits) inherits state from the previous conversation
    // and produces false positives in the phase-17/21/22 guards.
    try {
      const { resetReads } = require("./session-tracker") as typeof import("./session-tracker");
      resetReads();
    } catch {
      /* module not loaded */
    }
    try {
      const { clearEditHistory } = require("./file-edit-history") as typeof import("./file-edit-history");
      clearEditHistory();
    } catch {
      /* module not loaded */
    }
    try {
      const { resetAutoLaunchState } = require("./auto-launch-dev-server") as typeof import("./auto-launch-dev-server");
      resetAutoLaunchState();
    } catch {
      /* module not loaded */
    }
    try {
      const { resetSessionState } = require("./response-session") as typeof import("./response-session");
      resetSessionState();
    } catch {
      /* module not loaded */
    }

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

  /** Delegated to conversation-effort.ts — see module doc. */
  private getEffectiveMaxTurns(): number {
    return _getEffectiveMaxTurns(this.config, this.state.messages);
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
    const _t0 = Date.now();
    // Phase 21: record the user's text for downstream guards (write-guards
    // uses this to decide whether doc-file creation was authorized).
    try {
      const { recordUserText } = await import("./session-tracker.js");
      recordUserText(userMessage);
    } catch {
      /* non-fatal */
    }
    // Ensure system prompt is built (async due to Pro check in distillation)
    await this._systemPromptReady;

    // Adaptive prompt: rebuild on first message so local models get lite prompt
    // for simple queries (e.g., "hola") instead of the full 8K+ prompt.
    if (this.state.messages.length === 0) {
      const toolOverhead = estimateToolDefinitionTokens(this.tools);
      const _t1 = Date.now();
      const candidate = await SystemPromptBuilder.build(
        this.config,
        this.config.version,
        toolOverhead,
        userMessage,
      );
      log.debug("perf", `SystemPromptBuilder.build: ${Date.now() - _t1}ms`);
      this.systemPrompt = candidate;
      this.systemPromptHash = this.hashString(candidate);
    }

    // Session limit check: enforce 50/month cap for free users (first message only)
    if (this.state.messages.length === 0) {
      const _t2 = Date.now();
      const { checkSessionLimit } = await import("./pro.js");
      await checkSessionLimit();
      log.debug("perf", `checkSessionLimit: ${Date.now() - _t2}ms`);
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

    // Phase 5/12/15/18/20/25/30 pre-turn checks — see
    // ./conversation-pre-turn-checks.ts for the full detector set.
    await runPreTurnChecks({
      state: this.state,
      config: this.config,
      userMessage,
      contextWindowSize: this.contextWindowSize,
      estimateContextTokens: () => this.estimateContextTokens(),
    });

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
      userMessage,
      this.config.maxTokens,
      this.state.tokenCount,
      this.contextWindowSize,
    );
    if (budgetHint) this.state.messages.push(budgetHint);

    // Begin response session for turn isolation
    try {
      const { beginResponseSession } = await import("./response-session.js");
      beginResponseSession(this.state.messages.length);
    } catch {
      /* module not loaded */
    }

    // Detect audit intent on first message to gate Edit/MultiEdit on
    // source files behind a written AUDIT_REPORT.md. This prevents the
    // model from "correcting" code based on hallucinated findings before
    // the human has reviewed them.
    if (this.state.messages.length === 0) {
      try {
        const { detectAuditIntent, setAuditIntent } = await import("./session-tracker.js");
        if (detectAuditIntent(userMessage)) {
          setAuditIntent(true);
        }
      } catch {
        /* tracker optional */
      }
    }

    // Task orchestrator (level 0/1/2 routing) —
    // see ./conversation-task-routing.ts.
    const routing = await runTaskRouting({
      state: this.state,
      config: this.config,
      userMessage,
    });
    if (routing.action === "handled") {
      for (const evt of routing.events) yield evt;
      return;
    }
    for (const evt of routing.preLlmEvents) yield evt;
    const orchestratedMessage = routing.orchestratedMessage;

    this.state.messages.push({ role: "user", content: orchestratedMessage });

    // Layer 9: Reset intention engine for new turn
    try {
      getIntentionEngine().reset();
    } catch (err) {
      log.debug("intention", "Failed to reset intention engine: " + err);
    }

    // Smart context + RAG + skills injection (delegated to conversation-message-prep)
    const _t3 = Date.now();
    const contextMessages = await injectSmartContext(
      userMessage,
      this.state.messages,
      this.config.workingDirectory,
    );
    log.debug("perf", `injectSmartContext: ${Date.now() - _t3}ms`);
    for (const msg of contextMessages) this.state.messages.push(msg);
    log.debug("perf", `sendMessage pre-loop total: ${Date.now() - _t0}ms`);

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

  /** Delegated to conversation-transcript.ts — see module doc. */
  private recordTranscriptEvent(event: StreamEvent): void {
    _recordTranscriptEvent(
      {
        transcript: this.transcript,
        messages: this.state.messages,
        activeGuardState: this._activeGuardState,
      },
      event,
    );
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
    let actionNudgeUsed = false; // Phase 35: fire once per session

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

      // Sync contextWindowSize from config in case model was switched mid-session (e.g. /model)
      if (this.config.contextWindowSize && this.config.contextWindowSize !== this.contextWindowSize) {
        this.contextWindowSize = this.config.contextWindowSize;
      }

      // Per-turn context maintenance (delegated to conversation-context-maintenance.ts)
      yield* runContextMaintenance({
        state: this.state,
        systemPrompt: this.systemPrompt,
        contextWindowSize: this.contextWindowSize,
        compactThreshold: this.compactThreshold,
        config: this.config,
        debugTracer: this.debugTracer,
      });

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
        const _tStream = Date.now();
        await this.rateLimiter.acquire();
        log.debug("perf", `rateLimiter.acquire: ${Date.now() - _tStream}ms`);
        const _tFetch = Date.now();
        sseStream = await this.createStreamWithRetry();
        log.debug("perf", `createStreamWithRetry (fetch+connect): ${Date.now() - _tFetch}ms`);
      } catch (error) {
        this.rateLimiter.release();
        // If aborted by user (Esc), exit silently — don't show error
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg.includes("aborted") || this.abortController?.signal.aborted) {
          yield { type: "turn_end", stopReason: "aborted" };
          this.abortController = null;
          return;
        }
        yield {
          type: "error",
          error: error instanceof Error ? error : new Error(String(error)),
          retryable: false,
        };
        yield { type: "turn_end", stopReason: "error" };
        return;
      }

      // Streaming tool executor: starts read-only tools while model streams.
      // Only enabled for OpenAI-format providers where tool blocks arrive during
      // streaming. For Anthropic, tools finalize post-stream so no early benefit.
      const isOpenAIFormat = !this.config.apiBase?.includes("anthropic.com") &&
        !this.config.model.toLowerCase().startsWith("claude");
      const streamingExecutor = isOpenAIFormat
        ? new StreamingToolExecutor({
            tools: this.tools,
            permissions: this.permissions,
            config: this.config,
            abortSignal: this.abortController?.signal,
            shouldSkip: (tc) => {
              if (guardState.burnedFingerprints.size === 0) return false;
              for (const fp of guardState.burnedFingerprints) {
                if (fp.split("|")[0] === tc.name) return true;
              }
              return false;
            },
          })
        : null;

      let streamResult: StreamAccumulator;
      try {
        const streamGen = processSSEStream({
          sseStream,
          tools: this.tools,
          accumulateUsage: (usage) => this.accumulateUsage(usage),
          cumulativeUsage: this.cumulativeUsage,
          abortSignal: this.abortController?.signal,
          onToolReady: streamingExecutor ? (tool) => streamingExecutor.addTool(tool) : undefined,
        });
        // Forward all events from the stream processor
        let genResult = await streamGen.next();
        while (!genResult.done) {
          // Check abort between yields — allows Esc to interrupt immediately
          if (this.abortController?.signal.aborted) break;
          yield genResult.value;
          // Drain any events from tools that completed during streaming
          if (streamingExecutor) {
            for (const evt of streamingExecutor.drainEvents()) yield evt;
          }
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
      ({ assistantContent, toolCalls, stopReason, textChunks, turnInputTokens, turnOutputTokens } =
        streamResult);
      const fullText = textChunks.join("");

      // Phase 32 — scan the assistant's prose for phantom-typo claims
      // ("X en lugar de X") and stash the result on guardState so the
      // tool executor can block any Edit/MultiEdit that follows. Reset
      // at the top of each turn below so claims from one turn don't
      // leak into the next.
      try {
        const { detectPhantomTypoClaim } = await import("./phantom-typo-detector.js");
        const phantomMatch = detectPhantomTypoClaim(fullText);
        if (phantomMatch) {
          guardState.activePhantomClaim = phantomMatch;
          log.warn(
            "phase-32",
            `phantom-typo claim detected: "${phantomMatch.phrase.slice(0, 80)}" (token="${phantomMatch.token}")`,
          );
        } else {
          guardState.activePhantomClaim = null;
        }
      } catch (err) {
        log.debug("phase-32", `detector failed (non-fatal): ${err}`);
        guardState.activePhantomClaim = null;
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
      // IMPORTANT: injectMessages are deferred until AFTER tool_result to preserve the
      // assistant[tool_use] → user[tool_result] sequence that Anthropic requires.
      const planResult = await handlePlanCoherence(toolCalls, assistantContent);
      if (planResult.setForceStop) {
        guardState.forceStopLoop = true;
        const textOnly = assistantContent.filter((b) => b.type === "text");
        this.state.messages[this.state.messages.length - 1] = {
          role: "assistant",
          content: textOnly.length > 0 ? textOnly : [{ type: "text" as const, text: "" }],
        };
      }
      // Defer plan inject messages — pushed after tool_result below
      const deferredPlanMessages = planResult.injectMessages;
      if (planResult.stopReason) {
        // If stopping, inject now (no tool_result will follow)
        for (const msg of deferredPlanMessages) {
          this.state.messages.push({ role: "user", content: msg });
        }
        yield { type: "turn_end", stopReason: planResult.stopReason };
        continue;
      }
      if (planResult.blockedResults.length > 0) {
        const blockedBlocks: Array<{
          type: string;
          tool_use_id: string;
          content: string;
          is_error: boolean;
        }> = planResult.blockedResults.map((r) => ({
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
          actionNudgeUsed,
        });

        // Apply state updates from post-turn handler
        guardState.maxTokensContinuations = postTurnResult.maxTokensContinuations;
        guardState.emptyEndTurnCount = postTurnResult.emptyEndTurnCount;
        guardState.truncationRetries = postTurnResult.truncationRetries;
        guardState.lastEmptyType = postTurnResult.lastEmptyType;
        previousTurnTail = postTurnResult.previousTurnTail;
        this.turnsSinceLastExtraction = postTurnResult.turnsSinceLastExtraction;
        actionNudgeUsed = postTurnResult.actionNudgeUsed;

        // Emit events
        for (const evt of postTurnResult.events) yield evt;
        // Inject messages
        for (const msg of postTurnResult.injectMessages) this.state.messages.push(msg);

        if (postTurnResult.action === "break") {
          // Phase 28: USER-VISIBLE reality check. Runs against the
          // CURRENT turn's assistant text before we exit the loop.
          // Difference from phase 15 (which runs at the START of the
          // next turn as a reminder to the model): this fires IN-TURN
          // and emits a text_delta the user sees right after the
          // assistant's false claim. No trust damage — the user
          // reads the warning before deciding to believe the claim.
          //
          // The v2.10.72 Nexus Telemetry chart session was the
          // canonical trigger: model claimed "✅ AUDIT & FIX APLICADO"
          // with zero successful mutations while the chart bug
          // remained. Phase 15 would have flagged it on the NEXT
          // turn, but the user had already seen the false green
          // checkmark and lost confidence in kcode.
          try {
            const { checkClaimReality, countSuccessfulMutations } =
              await import("./claim-reality-check.js");
            // Build the current turn's assistant text from textChunks
            // (collected during streaming) rather than walking the
            // message history, since the assistant message hasn't
            // been pushed yet when postTurn fires.
            const currentAssistantText = textChunks.join("");
            if (currentAssistantText) {
              const verdict = checkClaimReality(
                currentAssistantText,
                this.state.messages,
              );
              if (verdict.isHallucinatedCompletion) {
                const warning =
                  `\n\n⚠️  REALITY CHECK (shown to user)\n` +
                  `   The assistant claimed a fix was applied but ZERO mutation\n` +
                  `   tools (Write/Edit/MultiEdit/GrepReplace) succeeded in this\n` +
                  `   turn. ${verdict.claims.length} completion claim(s) detected in the\n` +
                  `   assistant's text. The file was NOT modified.\n` +
                  `   \n` +
                  `   Before trusting the fix, re-prompt with "show me the Read\n` +
                  `   output first" or verify the file contents directly.`;
                yield { type: "text_delta", text: warning };
                log.info(
                  "reality-check",
                  `phase 28 fired: ${verdict.claims.length} claims, 0 mutations in current turn`,
                );
              } else {
                // Compute the count for logging visibility into near-fires
                const { successful } = countSuccessfulMutations(
                  this.state.messages,
                );
                log.debug(
                  "reality-check",
                  `phase 28 skipped: ${verdict.claims.length} claims, ${successful} mutations`,
                );
              }
            }
          } catch (err) {
            log.debug("reality-check", `phase 28 failed (non-fatal): ${err}`);
          }

          // Phase 22: the model has finished its final response and the
          // agent loop is about to exit. The inner hasRuntimeIntent +
          // hasRunnableWriteInTurn guards inside maybeAutoLaunchDevServer
          // are sufficient; we drop the stopReason === "end_turn" gate
          // because (a) the break path already implies the turn is
          // ending, and (b) the gate was blocking firing on max_tokens
          // or other legitimate end states. Safe to call on every break.
          try {
            const { maybeAutoLaunchDevServer } = await import(
              "./auto-launch-dev-server.js"
            );
            const { getUserTexts } = await import("./session-tracker.js");
            const launchResult = await maybeAutoLaunchDevServer(
              this.config.workingDirectory,
              this.state.messages,
              getUserTexts(),
            );
            if (launchResult) {
              this.state.messages.push({
                role: "assistant",
                content: launchResult.notice,
              });
              yield { type: "text_delta", text: launchResult.notice };
              log.info(
                "auto-launch",
                `phase 22 fired: ${launchResult.url ?? "no url"}`,
              );
            } else {
              log.debug(
                "auto-launch",
                `phase 22 skipped at break (stopReason=${stopReason})`,
              );
            }
          } catch (err) {
            log.debug("auto-launch", `hook failed (non-fatal): ${err}`);
          }
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

      // Collect results from tools that were executed during streaming (OpenAI format only)
      if (streamingExecutor) {
        const earlyResults = await streamingExecutor.waitForAll();
        if (earlyResults.length > 0) {
          log.info(
            "perf",
            `StreamingToolExecutor: ${earlyResults.length} tools pre-executed during streaming`,
          );
          const earlyIds = new Set(earlyResults.map((r) => r.toolUseId));
          for (const r of earlyResults) {
            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: r.toolUseId,
              content: r.result,
              is_error: r.isError,
            } satisfies ToolResultBlock);
            if (r.isError) guardState.recordToolError(r.name, r.result);
          }
          // Count streaming-fast-path tools too — otherwise when all calls
          // were pre-executed, filteredToolCalls becomes empty, the normal
          // executors are skipped via `continue` below, and toolUseCount
          // never advances.
          this.state.toolUseCount += earlyResults.length;
          filteredToolCalls = filteredToolCalls.filter((tc) => !earlyIds.has(tc.id));
          for (const evt of streamingExecutor.drainEvents()) yield evt;
        }
      }

      if (filteredToolCalls.length === 0) {
        this.augmentFabricationWarnings(toolResultBlocks, toolCalls);
        this.state.messages.push({ role: "user", content: toolResultBlocks });
        for (const msg of deferredPlanMessages) this.state.messages.push({ role: "user", content: msg });
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
        this.augmentFabricationWarnings(toolResultBlocks, toolCalls);
        this.state.messages.push({ role: "user", content: toolResultBlocks });
        for (const msg of deferredPlanMessages) this.state.messages.push({ role: "user", content: msg });
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

      this.augmentFabricationWarnings(toolResultBlocks, toolCalls);
      this.state.messages.push({ role: "user", content: toolResultBlocks });
      for (const msg of deferredPlanMessages) this.state.messages.push({ role: "user", content: msg });

      // Auto-agent evaluation: if a Plan was just created/updated with many pending steps,
      // spawn background agents to work on them in parallel
      if (toolCalls.some((tc) => tc.name === "Plan") && !this.autoAgentManager?.isActive()) {
        try {
          const mgr = new AutoAgentManager(
            {
              cwd: this.config.workingDirectory,
              model: this.config.model,
              config: this.config,
            },
            (statuses) => {
              // Forward agent statuses to Kodi panel via callback
              if (this.onAgentProgress) this.onAgentProgress(statuses);
            },
          );
          const { shouldSpawn, steps } = await mgr.evaluate();
          if (shouldSpawn) {
            this.autoAgentManager = mgr;
            const contextSummary = this.state.messages
              .filter((m) => m.role === "user" && typeof m.content === "string")
              .map((m) => (m.content as string).slice(0, 200))
              .join("\n");
            // Fire and forget — agents run in background
            mgr.spawn(steps, contextSummary).then(() => {
              // When agents complete, inject results into next turn
              const results = mgr.getResults();
              if (results.length > 0) {
                const summary = results
                  .map((r) => `[Agent result for step "${r.stepTitle}"]:\n${r.output.slice(0, 1000)}`)
                  .join("\n\n");
                this.state.messages.push({
                  role: "user",
                  content: `[SYSTEM] ${results.length} background agents completed:\n\n${summary}\n\nUpdate the plan to mark these steps as done.`,
                });
                log.info("auto-agents", `Injected ${results.length} agent results into conversation`);
              }
            }).catch((err) => {
              log.warn("auto-agents", `Auto-agent spawn failed: ${err}`);
            });
            log.info("auto-agents", `Auto-spawned ${steps.length} agents for plan steps`);
          }
        } catch (err) {
          log.debug("auto-agents", `Auto-agent evaluation failed: ${err}`);
        }
      }

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
      // (delegated to conversation-inline-warnings.ts)
      handleInlineWarnings({ state: this.state, guardState });

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

      // Phase 22 moved: the correct firing point is inside the
      // handlePostTurn break branch earlier in the loop. Placing it
      // here was dead code — handlePostTurn's `action: "break"` path
      // exits the loop BEFORE reaching this line for every normal
      // end_turn, so the hook never ran in production. See Bug #8
      // in the v2.10.64 audit.

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
    const result = _rewindToCheckpoint(
      this.checkpoints,
      this.state.messages,
      this.undoManager,
      index,
    );
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
    return _collectSessionData(
      this.state.messages,
      this.config.workingDirectory,
      this.state.toolUseCount,
    );
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

  /** Delegated to conversation-fabrication.ts — see module doc. */
  private augmentFabricationWarnings(
    toolResultBlocks: ContentBlock[],
    toolCalls: ToolUseBlock[],
  ): ContentBlock[] {
    return _augmentFabricationWarnings(this.state.messages, toolResultBlocks, toolCalls);
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
