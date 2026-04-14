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
import { emergencyPrune, estimateContextTokens, microcompactToolResults, pruneMessagesIfNeeded } from "./context-manager";
import {
  checkBudgetLimit,
  detectCheckpointMode,
  detectTheoreticalMode,
  evaluateOutputBudgetHint,
  injectSmartContext,
} from "./conversation-message-prep";
import { handlePostTurn, type PostTurnContext } from "./conversation-post-turn";
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
    const _t0 = Date.now();
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

    // Operator-mind phase 5: probe system invariants and prepend any
    // findings as a synthetic user-role message. Throttled per-finding-code
    // so the same warning doesn't nag every turn. Silent when healthy.
    try {
      const { probeOperatorState, formatOperatorBanner, selectFindingsForTurn } = await import(
        "./operator-dashboard.js"
      );
      const probe = probeOperatorState(this.config.workingDirectory);
      const fresh = selectFindingsForTurn(probe.findings);
      const banner = formatOperatorBanner(fresh);
      if (banner) {
        this.state.messages.push({ role: "user", content: banner });
      }
    } catch (err) {
      log.debug("operator-dashboard", `probe failed (non-fatal): ${err}`);
    }

    // Find the most recent assistant message text once — shared by
    // plan reconciliation (phase 12) and claim-vs-reality check (phase 15).
    let lastAssistantText = "";
    for (let i = this.state.messages.length - 1; i >= 0; i--) {
      const m = this.state.messages[i];
      if (m?.role !== "assistant") continue;
      if (typeof m.content === "string") {
        lastAssistantText = m.content;
      } else if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if ((block as { type?: string }).type === "text") {
            lastAssistantText += (block as { text?: string }).text ?? "";
          }
        }
      }
      break;
    }

    // Operator-mind phase 12: plan reconciliation check. If the previous
    // assistant turn declared the task complete (via phrases like "Task
    // completed", "Delivered", "Summary of changes") but the active plan
    // still has unchecked steps, inject a reconciliation reminder as a
    // user-role message so the model is forced to address the mismatch
    // before running any more tools.
    try {
      const { detectAbandonedPlan, buildPlanReconciliationReminder } = await import(
        "../tools/plan.js"
      );
      if (lastAssistantText) {
        const verdict = detectAbandonedPlan(lastAssistantText);
        if (verdict.abandoned && verdict.completionPhrase) {
          const reminder = buildPlanReconciliationReminder(
            verdict.pendingSteps,
            verdict.completionPhrase,
          );
          this.state.messages.push({ role: "user", content: reminder });
          log.info(
            "plan",
            `reconciliation injected: ${verdict.pendingSteps.length} pending steps, phrase="${verdict.completionPhrase}"`,
          );
        }
      }
    } catch (err) {
      log.debug("plan", `reconciliation check failed (non-fatal): ${err}`);
    }

    // Operator-mind phase 15: claim-vs-reality check. If the previous
    // assistant turn made concrete change claims ("Updated X", "Replaced Y")
    // but no mutating tool call (Write/Edit/MultiEdit/GrepReplace/Rename/
    // GitCommit) actually succeeded in that turn, inject a [REALITY CHECK]
    // reminder forcing the model to either make the changes for real or
    // retract the false claims. Most corrosive hallucination pattern —
    // session evidence: model wrote "Updated version v2.1 → v2.3" while
    // the file still had v2.1 untouched.
    try {
      const {
        checkClaimReality,
        buildRealityCheckReminder,
        buildClaimMismatchReminder,
      } = await import("./claim-reality-check.js");
      if (lastAssistantText) {
        const verdict = checkClaimReality(lastAssistantText, this.state.messages);
        if (verdict.isHallucinatedCompletion) {
          const reminder = buildRealityCheckReminder(verdict);
          this.state.messages.push({ role: "user", content: reminder });
          log.info(
            "reality-check",
            `hallucinated completion detected: ${verdict.claims.length} claims, ${verdict.successfulMutations} real mutations`,
          );
        } else if (verdict.isClaimMutationMismatch) {
          // Phase 18: softer reminder when some mutations landed but the
          // claim count is ≥3x the mutation count. Model is padding the
          // summary with improvements that never happened.
          const reminder = buildClaimMismatchReminder(verdict);
          this.state.messages.push({ role: "user", content: reminder });
          log.info(
            "reality-check",
            `claim/mutation mismatch: ${verdict.claims.length} claims, ${verdict.successfulMutations} real mutations`,
          );
        }
      }
    } catch (err) {
      log.debug("reality-check", `check failed (non-fatal): ${err}`);
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

    // Task orchestrator: classify the user's intent and run a deterministic
    // pipeline to pre-process context. The LLM receives focused context +
    // specific prompt instead of raw "figure it out" requests.
    // This is what makes KCode faster than sending everything to the LLM.
    // Level 0: detect multi-step workflow chains (0 tokens, auto-chains engines)
    try {
      const { detectChain, executeChain } = await import("./task-orchestrator/workflow-chain.js");
      const chain = detectChain(userMessage);
      if (chain) {
        this.state.messages.push({ role: "user", content: userMessage });
        const lines: string[] = [`  ⛓ Workflow: ${chain}\n`];
        const result = await executeChain(chain, this.config.workingDirectory, (step, i, total) => {
          const icon = step.status === "done" ? "✅"
            : step.status === "failed" ? "❌"
            : step.status === "skipped" ? "⏭"
            : step.status === "running" ? "⚡" : "⏳";
          // Emit progress per step
          if (step.status !== "pending") {
            lines.push(
              `  ${icon} ${step.name}${step.durationMs ? ` (${(step.durationMs / 1000).toFixed(1)}s)` : ""}` +
              (step.output ? `\n     ${step.output.split("\n")[0]?.slice(0, 80)}` : ""),
            );
          }
        });
        lines.push("");
        lines.push(result.success ? "  ✅ Workflow complete" : "  ⚠️ Workflow completed with issues");
        lines.push(`  Total: ${(result.totalMs / 1000).toFixed(1)}s`);
        const output = lines.join("\n");
        this.state.messages.push({ role: "assistant", content: output });
        yield { type: "text", text: output };
        yield { type: "turn_end", inputTokens: 0, outputTokens: 0 };
        log.info("orchestrator", `Chain "${chain}" completed: ${result.steps.length} steps, ${result.totalMs}ms, 0 tokens`);
        return;
      }
    } catch (err) {
      log.debug("orchestrator", `Chain detection skipped: ${err}`);
    }

    // Agent intent detection: if the user asks to dispatch agents
    // ("liberemos 3 agentes para auditar backend", "spawn 5 workers"),
    // spawn them through the pool BEFORE running the LLM turn. The
    // agents execute asynchronously; their status is injected into
    // the system prompt on every subsequent turn via the agent
    // fragment hook in request-builder, so the model sees them.
    try {
      const { detectAgentIntent } = await import("./agents/intent.js");
      const intent = detectAgentIntent(userMessage, this.config.workingDirectory);
      if (intent && intent.detected && intent.spawned.length > 0) {
        // Show the dispatch summary inline in the assistant response.
        // Don't consume the turn — let the LLM still respond, now
        // with awareness of the new agents in its system prompt.
        this.state.messages.push({ role: "user", content: userMessage });
        yield { type: "text_delta", text: intent.message + "\n\n" };
        // Fall through to the normal turn flow below so the LLM can
        // frame the next steps (e.g., "while Atlas is auditing,
        // let me start looking at the tests").
      }
    } catch (err) {
      log.debug("agents", `Intent detection skipped: ${err}`);
    }

    // Level 1: try to handle deterministically without LLM (0 tokens).
    //
    // Skip the entire level-1 short-circuit when a customFetch is injected —
    // that only happens in in-process test harnesses, where the level-1
    // regexes otherwise consume test prompts like "Run git status" (matches
    // the dev-server start verb) or "test" (matches the test runner) before
    // they reach the scripted fake provider. Production never sets
    // customFetch, so this guard is test-only.
    if (this.config.customFetch) {
      /* test mode — route every user message straight to the LLM path */
    } else try {
      const { tryLevel1 } = await import("./task-orchestrator/level1-handlers.js");
      const lower = userMessage.toLowerCase().trim();
      const isSlowCommand = /(?:levant|start|run\s|launch|arranca|build|compile|construir)/.test(lower) && !(/\b(?:create|make|crea|genera)\b/.test(lower));

      if (isSlowCommand) {
        // Show progress bar for commands that take time (install, build)
        const { engineState, resetEngineState } = await import("./engine-progress.js");
        resetEngineState();
        engineState.active = true;
        engineState.startTime = Date.now();

        const isBuild = /^(?:build|compile|construir|compilar)/i.test(lower);
        engineState.phase = isBuild ? "Building project..." : "Starting server...";
        engineState.step = 1;
        engineState.totalSteps = isBuild ? 2 : 3;

        // Small delay for UI to render progress
        await new Promise(r => setTimeout(r, 100));

        if (!isBuild) {
          engineState.phase = "Installing dependencies...";
          engineState.step = 2;
        }

        const l1 = tryLevel1(userMessage, this.config.workingDirectory);
        if (l1.handled) {
          engineState.phase = isBuild ? "Build complete!" : "Server started!";
          engineState.step = engineState.totalSteps;
          await new Promise(r => setTimeout(r, 200));
          engineState.active = false;

          this.state.messages.push({ role: "user", content: userMessage });
          this.state.messages.push({ role: "assistant", content: l1.output });
          yield { type: "turn_start" };
          yield { type: "text_delta", text: l1.output };
          yield { type: "turn_end", inputTokens: 0, outputTokens: 0, stopReason: "end_turn" };
          log.info("orchestrator", `Level 1 handled: "${userMessage.slice(0, 40)}..." → 0 tokens`);
          return;
        }
        engineState.active = false;
      } else {
        const l1 = tryLevel1(userMessage, this.config.workingDirectory);
        if (l1.handled) {
          this.state.messages.push({ role: "user", content: userMessage });
          this.state.messages.push({ role: "assistant", content: l1.output });
          yield { type: "turn_start" };
          yield { type: "text_delta", text: l1.output };
          yield { type: "turn_end", inputTokens: 0, outputTokens: 0, stopReason: "end_turn" };
          log.info("orchestrator", `Level 1 handled: "${userMessage.slice(0, 40)}..." → 0 tokens`);
          return;
        }
      }
    } catch (err) {
      log.debug("orchestrator", `Level 1 skipped: ${err}`);
    }

    let orchestratedMessage = userMessage;
    try {
      const { classifyTask } = await import("./task-orchestrator/classifier.js");
      const task = classifyTask(userMessage);

      if (task.type !== "general" && task.confidence >= 0.8) {
        // ── Level 2: Machine-first code/web creation ──
        // IMPORTANT: Only activate engine for NEW project creation, NOT for modifications
        const isModification = /\b(?:make|hazlo|fix|arregla|change|cambia|update|actualiza|add|agrega|remove|quita|improve|mejora|refactor|move|mueve|delete|borra|resize|collaps|expand|drag)\b/i.test(userMessage)
          && !/\b(?:create|crea|build|construye|scaffold|genera|new|nueva?o?)\b/i.test(userMessage);

        const isWebRequest = !isModification && /\b(?:website|web\s*(?:site|app|page)|landing|dashboard|blog|portfolio|store|shop|tienda|sitio\s*web|p[aá]gina\s*web|saas|e-?commerce|trading|social|chat|crm|kanban|lms|course|education|iot|monitor|analytics|admin\s*panel|feed|board|panel|platform)\b/i.test(userMessage);

        if (task.type === "implement" && !isModification) {
          const { detectCodeEngine, runCodeEngine } = await import("./code-engine-router.js");
          const engineMatch = detectCodeEngine(userMessage);

          // Try code engine first (Go, Rust, Python, etc.)
          // Then web engine (dashboard, ecommerce, etc.)
          // If engine handles 100%, respond directly without LLM
          let engineHandled = false;

          if (engineMatch) {
            try {
              const result = await runCodeEngine(engineMatch.engine, userMessage, this.config.workingDirectory);
              if (result) {
                // Check if all files are machine-generated (0 LLM needed)
                const hasLlmFiles = result.includes("LLM customization") || result.includes("need LLM") || !result.includes("0 LLM");
                if (!hasLlmFiles) {
                  // 100% machine — respond directly, skip LLM
                  this.state.messages.push({ role: "user", content: userMessage });
                  this.state.messages.push({ role: "assistant", content: result });
                  yield { type: "turn_start" };
                  yield { type: "text_delta", text: result };
                  yield { type: "turn_end", inputTokens: 0, outputTokens: 0, stopReason: "end_turn" };
                  log.info("orchestrator", `Engine handled 100% machine: ${engineMatch.engine} (0 tokens)`);
                  return;
                }
                // Partial machine — send to LLM with focused prompt
                orchestratedMessage = result;
                engineHandled = true;
                log.info("orchestrator", `${engineMatch.engine} engine + LLM for: "${userMessage.slice(0, 50)}"`);
              }
            } catch (err) {
              log.debug("code-engine", `${engineMatch.engine} engine skipped: ${err}`);
            }
          }

          if (!engineHandled && isWebRequest) {
            try {
              log.info("orchestrator", `Trying web engine for: "${userMessage.slice(0, 50)}"`);

              // Activate engine progress BEFORE creating project
              const { engineState, resetEngineState } = await import("./engine-progress.js");
              resetEngineState();
              engineState.active = true;
              engineState.phase = "Detecting project type...";
              engineState.step = 0;
              engineState.startTime = Date.now();

              const { createWebProject } = await import("./web-engine/web-engine.js");
              const webResult = createWebProject(userMessage, this.config.workingDirectory);
              log.info("orchestrator", `Web engine result: type=${webResult.intent.siteType} machine=${webResult.machineFiles} llm=${webResult.llmFiles}`);
              const totalFiles = webResult.machineFiles + webResult.llmFiles;

              if (webResult.llmFiles === 0) {
                // 100% machine — continue with progress bar
                engineState.siteType = webResult.intent.siteType;
                engineState.projectPath = webResult.projectPath;
                engineState.startTime = Date.now();
                engineState.totalSteps = 4;

                yield { type: "turn_start" };

                // Step 1: Scaffolding
                engineState.phase = "Scaffolding project...";
                engineState.step = 1;
                // Small delay so UI can render the progress bar
                await new Promise(r => setTimeout(r, 200));

                // Step 2: Files written
                engineState.phase = `Writing ${totalFiles} files...`;
                engineState.step = 2;
                await new Promise(r => setTimeout(r, 200));

                // Save last project path and update tool workspace
                this.config.workingDirectory = webResult.projectPath;
                (require("../tools/workspace") as typeof import("../tools/workspace")).setToolWorkspace(webResult.projectPath);
                try {
                  process.chdir(webResult.projectPath);
                  const { writeFileSync } = await import("node:fs");
                  const { kcodePath } = await import("./paths.js");
                  writeFileSync(kcodePath("last-project"), webResult.projectPath);
                } catch {}

                // Step 3: Check if user also asked to run
                const runMatch = userMessage.match(/(?:levant|run|start|launch|arranca|ejecuta|inicia|lanza)/i);
                const portMatch = userMessage.match(/(?:(?:en|on|at)\s+)?(?:(?:el\s+)?puerto|port)\s+(\d+)/i);
                let runOutput = "";
                if (runMatch) {
                  const port = portMatch?.[1] ? parseInt(portMatch[1], 10) : 10080;
                  engineState.phase = "Installing dependencies...";
                  engineState.step = 3;
                  await new Promise(r => setTimeout(r, 200));

                  const { tryLevel1 } = await import("./task-orchestrator/level1-handlers.js");
                  const l1 = tryLevel1(`levantalo en el puerto ${port}`, webResult.projectPath);

                  engineState.phase = "Server started!";
                  engineState.step = 4;
                  if (l1.handled) runOutput = "\n" + l1.output;
                } else {
                  engineState.phase = "Done!";
                  engineState.step = 4;
                }

                // Done — deactivate progress, show summary
                await new Promise(r => setTimeout(r, 300));
                engineState.active = false;

                const summary = [
                  `  ✅ ${webResult.intent.siteType} — ${totalFiles} files (${webResult.machineFiles} machine, 0 LLM)`,
                  `  📁 ${webResult.projectPath}`,
                ].join("\n");

                const finalText = summary + runOutput + (runMatch ? "" : `\n\n  To run: "levantalo en el puerto 15623"`);
                yield { type: "text_delta", text: finalText + "\n" };

                const fullText = summary;
                this.state.messages.push({ role: "user", content: userMessage });
                this.state.messages.push({ role: "assistant", content: fullText });
                yield { type: "turn_end", inputTokens: 0, outputTokens: 0, stopReason: "end_turn" };
                log.info("orchestrator", `Web engine 100% machine: ${webResult.intent.siteType} (0 tokens)${runMatch ? " + auto-serve" : ""}`);
                return;
              }

              // Has LLM files — deactivate engine progress, send to LLM
              engineState.active = false;
              orchestratedMessage = `${webResult.prompt}\n\nThe machine already created ${webResult.machineFiles} files at ${webResult.projectPath}.\nYou MUST only edit the ${webResult.llmFiles} files marked for LLM customization.\nDo NOT create new files or restructure the project. Only customize content.\nUSER REQUEST: "${userMessage}"`;
              engineHandled = true;
              log.info("orchestrator", `Web engine + LLM: ${webResult.intent.siteType} (${webResult.llmFiles} files to customize)`);
            } catch (err) {
              engineState.active = false;
              log.debug("web-engine", `Web engine skipped: ${err}`);
            }
          }

          if (!engineHandled) {
            try {
              const { buildImplementPrompt } = await import("./implement-engine/scaffold.js");
              const result = buildImplementPrompt(userMessage, this.config.workingDirectory);
              orchestratedMessage = result.prompt;
              log.info(
                "orchestrator",
                `Implement engine: ${result.project.framework} (${result.project.language}), ` +
                  `${result.patterns.length} patterns found, ${result.estimatedFiles.length} files to create`,
              );
            } catch (err) {
              log.debug("implement-engine", `Implement engine skipped: ${err}`);
            }
          }
        } else if (task.type === "test") {
          try {
            const { buildTestPrompt } = await import("./test-engine/generator.js");
            const files = task.entities.files ?? [];
            if (files.length > 0) {
              const result = buildTestPrompt(files[0]!, userMessage, this.config.workingDirectory);
              orchestratedMessage = result.prompt;
              log.info(
                "orchestrator",
                `Test engine: ${result.functions.length} functions, ` +
                  `${result.edgeCases.length} edge cases, framework: ${result.framework.name}`,
              );
            }
          } catch (err) {
            log.debug("test-engine", `Test engine skipped: ${err}`);
          }
        } else if (task.type === "debug") {
          try {
            const { collectEvidence, buildDebugPrompt } = await import("./debug-engine/evidence-collector.js");
            const evidence = await collectEvidence({
              files: task.entities.files ?? [],
              errorMessage: task.entities.error,
              cwd: this.config.workingDirectory,
            });
            orchestratedMessage = buildDebugPrompt(evidence, userMessage);
            log.info(
              "orchestrator",
              `Debug engine: ${evidence.targetFiles.length} files, ` +
                `${evidence.errorPatterns.length} error patterns, ` +
                `${evidence.testFiles.length} test files, ` +
                `${evidence.callers.length} callers`,
            );
          } catch (err) {
            log.debug("debug-engine", `Debug engine skipped: ${err}`);
          }
        } else {
          // Other task types use the generic pipeline
          const { runPipeline } = await import("./task-orchestrator/pipelines.js");
          const pipelineResult = await runPipeline(task, this.config.workingDirectory);
          if (pipelineResult) {
            orchestratedMessage = pipelineResult.prompt;
            log.info(
              "orchestrator",
              `Classified "${task.type}" (${(task.confidence * 100).toFixed(0)}%) → ` +
                `${pipelineResult.steps.length} pipeline steps, ` +
                `${pipelineResult.context.length} chars context`,
            );
          }
        }
      }
    } catch (err) {
      log.debug("orchestrator", `Pipeline skipped: ${err}`);
    }

    this.state.messages.push({ role: "user", content: orchestratedMessage });

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

      // Sync contextWindowSize from config in case model was switched mid-session (e.g. /model)
      if (this.config.contextWindowSize && this.config.contextWindowSize !== this.contextWindowSize) {
        this.contextWindowSize = this.config.contextWindowSize;
      }

      // Microcompact: proactively clear old tool results every turn (zero LLM cost)
      microcompactToolResults(this.state.messages);

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

  /**
   * Phase 13 anti-fabrication: inspect tool-result blocks for errors
   * on file-path-bearing tools (Read/Edit/Write/MultiEdit), run the
   * fabrication heuristic against the reference corpus (user messages
   * + prior tool results in this.state.messages), and if the path
   * looks fabricated, append a STOP warning to the result content.
   *
   * Mutates the blocks in place and returns the same array for
   * fluent chaining. Zero-cost on successful tool calls (the
   * is_error=false short-circuit skips the heuristic entirely).
   */
  private augmentFabricationWarnings(
    toolResultBlocks: ContentBlock[],
    toolCalls: ToolUseBlock[],
  ): ContentBlock[] {
    try {
      const { collectReferenceTexts, isLikelyFabricated, wrapFabricatedError } =
        require("./anti-fabrication.js") as typeof import("./anti-fabrication.js");
      let referenceTexts: string[] | null = null;
      for (const block of toolResultBlocks) {
        const b = block as ToolResultBlock;
        if (b.type !== "tool_result" || !b.is_error) continue;
        const call = toolCalls.find((tc) => tc.id === b.tool_use_id);
        if (!call) continue;
        const name = call.name;
        if (name !== "Read" && name !== "Edit" && name !== "Write" && name !== "MultiEdit") {
          continue;
        }
        const input = call.input as Record<string, unknown>;
        const attemptedPath = String(input.file_path ?? "");
        if (!attemptedPath) continue;
        const errorText = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        if (referenceTexts === null) {
          referenceTexts = collectReferenceTexts(this.state.messages);
        }
        const verdict = isLikelyFabricated(attemptedPath, errorText, referenceTexts);
        if (verdict.fabricated) {
          const originalContent = typeof b.content === "string" ? b.content : errorText;
          b.content = wrapFabricatedError(
            originalContent,
            attemptedPath,
            verdict.unreferencedTokens,
          );
          log.info(
            "anti-fabrication",
            `fabricated path detected: ${attemptedPath} — unreferenced tokens [${verdict.unreferencedTokens.join(",")}]`,
          );
        }
      }
    } catch (err) {
      log.debug("anti-fabrication", `augment failed (non-fatal): ${err}`);
    }
    return toolResultBlocks;
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
