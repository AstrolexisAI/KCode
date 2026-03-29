// KCode - Conversation Manager
// Handles the main conversation loop with local LLM API (OpenAI-compatible) using SSE streaming

import type {
  Message,
  ContentBlock,
  ToolUseBlock,
  KCodeConfig,
  ConversationState,
  StreamEvent,
  TokenUsage,
  TurnCostEntry,
} from "./types";
import { routeToModel } from "./router";
import { ToolRegistry } from "./tool-registry";
import { SystemPromptBuilder } from "./system-prompt";
import { PermissionManager } from "./permissions";
import { HookManager } from "./hooks";
import { RateLimiter } from "./rate-limiter";
import { UndoManager } from "./undo";
import { TranscriptManager } from "./transcript";
import { log } from "./logger";
import { setSudoPasswordPromptFn as _setSudoPasswordPromptFn, type SudoPasswordPromptFn } from "../tools/bash";
import { getUserModel } from "./user-model";
import { generateCacheKey, getCachedResponse } from "./response-cache";
import { getIntentionEngine } from "./intentions";
import { type SSEChunk } from "./sse-parser";
import { getBranchManager } from "./branch-manager";
import { extractToolCallsFromText } from "./tool-call-extractor";
import type { DebugTracer } from "./debug-tracer";

// Extracted modules
import { executeModelRequest } from "./request-builder";
import {
  MAX_AGENT_TURNS,
  MAX_CONSECUTIVE_DENIALS,
  LOOP_PATTERN_THRESHOLD,
  LOOP_PATTERN_HARD_STOP,
  LoopGuardState,
  validateModelOutput,
} from "./agent-loop-guards";
import { estimateContextTokens, pruneMessagesIfNeeded, emergencyPrune } from "./context-manager";
import { executeToolsParallel, executeToolsSequential, preFilterToolCalls } from "./tool-executor";
import {
  cacheResponseIfEligible,
  processKnowledgeAndBenchmark,
  evaluateIntentionSuggestions,
  sendDesktopNotification,
} from "./post-turn";

// ─── Constants ───────────────────────────────────────────────────

const DEFAULT_CONTEXT_WINDOW = 32_000;
// Context window margin removed — compactThreshold (default 0.75) is used instead
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8000;

/**
 * Heuristic: does the text look like it was cut off mid-sentence?
 * Catches responses that end in prepositions, articles, open brackets, etc.
 */
export function looksIncomplete(text: string): boolean {
  if (text.length < 10) return false;
  const trimmed = text.trimEnd();
  // Ends with an open code block that was never closed
  const openFences = (trimmed.match(/```/g) || []).length;
  if (openFences % 2 !== 0) return true;
  // Ends with an open table row
  if (trimmed.endsWith("|")) return true;
  // Ends with a hyphen (word split mid-token: "preser-", "no-de")
  if (/[-–—]\s*$/.test(trimmed)) return true;
  // Ends with open bracket/paren (unclosed expression)
  if (/[(\[{]\s*$/.test(trimmed)) return true;
  // Ends with a backtick (broken inline code)
  if (/`\s*$/.test(trimmed) && openFences % 2 === 0) return true;
  // Last word looks like a truncated prefix (2-4 chars, no punctuation, not a common word)
  const lastWord = trimmed.match(/(\S+)\s*$/)?.[1] ?? "";
  if (lastWord.length >= 2 && lastWord.length <= 4 && /^[a-zA-Z]+$/.test(lastWord)) {
    const commonShortWords = new Set(["ok", "yes", "is", "it", "or", "if", "do", "so", "go", "at", "be", "we", "he", "up", "by", "my", "me", "us", "am", "oh", "ya"]);
    if (!commonShortWords.has(lastWord.toLowerCase()) && !/[.!?:;)]$/.test(trimmed)) return true;
  }
  // Ends mid-sentence: preposition, article, conjunction (English + Spanish)
  const lastLine = trimmed.split("\n").pop() ?? "";
  const midSentenceEndings = new RegExp(
    "\\b(" +
    // English
    "the|a|an|of|in|to|for|with|and|or|but|that|is|are|was|from|by|as|at|on|into|" +
    "not only|not just|rather|although|because|since|while|whereas|however|" +
    "this|these|which|where|when|how|if|than|between|through|about|over|under|" +
    "provides?|contains?|includes?|requires?|ensures?|means|implies|suggests|" +
    // Spanish
    "del?|la|los|las|un|una|unos|unas|en|para|con|sin|sobre|entre|que|como|" +
    "sino|aunque|porque|mientras|según|también|además|entonces|pero|ni|" +
    "mediante|donde|cuando|hacia|desde|hasta|por|al|su|sus|este|esta|estos|estas|" +
    "ya que|dado que|puesto que|siempre que|a menos que|no solo|no sólo|" +
    "preserva|caracteriza|reduce|incluye|requiere|permite|genera|produce|define|" +
    // French/Portuguese common
    "le|les|des|du|dans|avec|pour|sur|sous|qui|dont|mais|donc|" +
    "ou|et|das|dos|nas|nos|pelo|pela|uma|com|sem|sobre" +
    ")\\s*$",
    "i"
  );
  if (midSentenceEndings.test(lastLine)) return true;
  return false;
}

/**
 * Simple language detection by keyword frequency.
 */
export function detectLanguage(text: string): "es" | "fr" | "pt" | "en" {
  const lower = text.toLowerCase();
  const es = (lower.match(/\b(que|del?|para|con|por|como|una?|los?|las?|sobre|entre|desde|hasta|también|puede|tiene|cada|este|esta|demuestra|dado|propón|diseña)\b/g) || []).length;
  const fr = (lower.match(/\b(les?|des|une?|dans|pour|avec|qui|sur|sont|cette|aussi|peut|chaque|mais|donc)\b/g) || []).length;
  const pt = (lower.match(/\b(uma?|dos?|das?|para|com|que|sobre|entre|desde|também|pode|cada|este|esta)\b/g) || []).length;
  if (es > fr && es > pt && es >= 3) return "es";
  if (fr > es && fr > pt && fr >= 3) return "fr";
  if (pt > es && pt > fr && pt >= 3) return "pt";
  return "en";
}

/**
 * Heuristic: does the prompt look like a theoretical/formal question
 * that should be answered with text only, no tools?
 */
export function looksTheoretical(prompt: string): boolean {
  const lower = prompt.toLowerCase();

  // ── Strong signals: formal proof/analysis language ──────────
  const strongPatterns = [
    /\bdemuestra\s+(formalmente|que)\b/,
    /\bprove\s+(that|formally)\b/,
    /\bdemostrar\s+que\b/,
    /\bformal(ly)?\s+(prove|verify|demonstrate|analysis)\b/,
    /\breducible\s+(al?|to)\b/,
    /\bdecidib(le|ility)\b/,
    /\bequivalencia\s+observacional\b/,
    /\bobservational\s+equivalence\b/,
    /\balgorit(hm|mo)\s+(que|that|which)\b.*\b(decid|optim|preserv)/,
    /\bcaracteriza\s+(el|bajo|the)\b/,
    /\bcharacterize\s+(the|under|when)\b/,
    /\bespacio\s+de\s+trade-?offs\b/,
    /\btrade-?off\s+space\b/,
    /\bsistema\s+de\s+transici[oó]n\b/,
    /\btransition\s+system\b/,
  ];
  if (strongPatterns.some(p => p.test(lower))) return true;

  // ── Structured reasoning prompt: long, multiline, with sections ──
  // Prompts with structured sections (###, PARTE, numbered tasks) and
  // reasoning keywords are analytical exercises, not code tasks.
  const hasStructuredSections = /^#{2,4}\s+/m.test(prompt) || /\bparte\s+\d/i.test(prompt) || /\b(task|tarea)\s*\d/i.test(prompt);
  const hasDataTables = /\|.*\|.*\|/m.test(prompt);
  const hasReasoningKeywords = [
    "razonamiento", "reasoning", "paso a paso", "step by step",
    "trade-off", "contraejemplo", "counterexample", "diagnóstico",
    "diagnostic", "optimización", "optimization", "consistencia",
    "consistency", "meta razonamiento", "meta reasoning",
    "maximizar", "maximize", "minimizar", "minimize",
  ].filter(kw => lower.includes(kw)).length;

  // Long prompt (>500 chars) with sections + reasoning language = theoretical
  if (prompt.length > 500 && hasStructuredSections && hasReasoningKeywords >= 1) return true;
  // Prompt with data tables + reasoning keywords = analytical exercise
  if (hasDataTables && hasReasoningKeywords >= 2) return true;

  // ── Moderate signals: multiple formal keywords ─────────────
  const formalKeywords = [
    "demuestra", "prove", "formalmente", "formally", "reducible",
    "decidible", "decidability", "equivalencia", "equivalence",
    "alcanzabilidad", "reachability", "idempotent", "append-only",
    "subsecuencia", "subsequence", "compaction", "preservar",
    "filesystem", "tool calls", "restricciones", "constraints",
  ];
  const matches = formalKeywords.filter(kw => lower.includes(kw));
  if (matches.length >= 3) return true;

  return false;
}


/**
 * Detect if the user is requesting staged/incremental execution
 * (i.e., "do the first step and show me", "just the initial structure").
 * When detected, KCode should stop after completing that stage.
 */
export function looksCheckpointed(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  const patterns = [
    /\b(primer|first)\s+(paso|step)\b/,
    /\b(estructura|structure)\s+(inicial|initial|base|básica)\b/,
    /\b(solo|only|just)\s+(la base|the base|el setup|the setup|el esqueleto|the skeleton)\b/,
    /\bmuéstrame\s+(cuando|el resultado|qué hiciste)\b/,
    /\bshow\s+me\s+when\s+(done|finished|ready)\b/,
    /\bcuando\s+termines\b/,
    /\bhaz\s+primero\b/,
    /\bstart\s+with\b.*\b(then|and)\s+(show|tell|stop)\b/,
    /\bsolo\s+(la|el|las|los)\s+\w+\s+(inicial|base|primero|first)\b/,
    /\b(empieza|empezá|comienza|comenzá)\s+(con|por)\b.*\b(muéstrame|y\s+par[áa])\b/,
    /\b(start|begin)\s+(with|by)\b.*\b(show|stop|then)\b/,
  ];
  return patterns.some(p => p.test(lower));
}

/**
 * Strip overlapping content between a previous response tail and a continuation.
 * Uses line-level matching first, then falls back to char-level.
 * Returns the cleaned continuation text.
 */
export function dedupContinuation(previousTail: string, continuation: string): string {
  if (previousTail.length === 0 || continuation.length === 0) return continuation;

  // Line-level dedup: check if continuation starts with lines from the tail
  const tailLines = previousTail.split("\n");
  const newLines = continuation.split("\n");
  if (tailLines.length >= 2 && newLines.length >= 2) {
    for (let i = 0; i < Math.min(newLines.length, 10); i++) {
      const line = newLines[i].trim();
      if (line.length < 10) continue;
      const tailIdx = tailLines.findIndex(tl => tl.trim() === line);
      if (tailIdx >= 0 && tailIdx >= tailLines.length - 10) {
        const remainingTailLines = tailLines.length - tailIdx;
        const stripCount = Math.min(remainingTailLines, newLines.length);
        return newLines.slice(stripCount).join("\n").trim();
      }
    }
  }

  // Char-level dedup fallback
  const tailToMatch = previousTail.slice(-200);
  for (let overlapLen = Math.min(tailToMatch.length, continuation.length); overlapLen >= 20; overlapLen--) {
    const tailSuffix = tailToMatch.slice(-overlapLen);
    if (continuation.startsWith(tailSuffix)) {
      return continuation.slice(overlapLen);
    }
  }

  return continuation;
}

// ─── Retry Logic ─────────────────────────────────────────────────

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Retry on network errors and common HTTP errors
    if (
      msg.includes("network") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("unable to connect") ||
      msg.includes("timeout") ||
      msg.includes("socket") ||
      msg.includes("429") ||
      msg.includes("500") ||
      msg.includes("502") ||
      msg.includes("503")
    ) {
      return true;
    }
  }
  return false;
}

function computeRetryDelay(attempt: number): number {
  // Exponential backoff: 0.5s, 1s, 2s, 4s, 8s capped at MAX_RETRY_DELAY_MS
  const baseDelay = Math.min(
    BASE_RETRY_DELAY_MS * Math.pow(2, attempt),
    MAX_RETRY_DELAY_MS,
  );
  // 75-100% jitter
  const jitter = 0.75 + Math.random() * 0.25;
  return Math.round(baseDelay * jitter);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  private checkpoints: Array<{ label: string; messageIndex: number; undoSize: number; timestamp: number }> = [];
  private static MAX_CHECKPOINTS = 10;
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

  constructor(config: KCodeConfig, tools: ToolRegistry) {
    this.config = config;
    this.tools = tools;
    this.systemPrompt = ""; // initialized async via initSystemPrompt()
    this.systemPromptHash = "";
    this._systemPromptReady = this.initSystemPrompt();
    this.contextWindowSize = config.contextWindowSize ?? DEFAULT_CONTEXT_WINDOW;
    this.compactThreshold = config.compactThreshold ?? 0.75;
    this.maxRetries = config.maxRetries ?? MAX_RETRIES;
    this.permissions = new PermissionManager(config.permissionMode, config.workingDirectory, config.additionalDirs, config.permissionRules);
    this.hooks = new HookManager(config.workingDirectory);

    // Anchor tools (Glob, Grep) to the session's working directory
    const { setToolWorkspace } = require("../tools/workspace") as typeof import("../tools/workspace");
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
    this.systemPrompt = await SystemPromptBuilder.build(this.config, this.config.version);
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
    switch (this.config.effortLevel) {
      case "low": return 5;
      case "high": return 40;
      case "max": return 60;
      default: return MAX_AGENT_TURNS; // "medium" or unset = 25
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

    // Session limit check: enforce 50/month cap for free users (first message only)
    if (this.state.messages.length === 0) {
      const { checkSessionLimit } = await import("./pro.js");
      await checkSessionLimit();
    }

    // Budget guard: check if session has exceeded max budget
    if (this.config.maxBudgetUsd && this.config.maxBudgetUsd > 0) {
      try {
        const { getModelPricing, calculateCost } = await import("./pricing.js");
        const pricing = await getModelPricing(this.config.model);
        if (pricing) {
          const cost = calculateCost(pricing, this.cumulativeUsage.inputTokens, this.cumulativeUsage.outputTokens);
          if (cost >= this.config.maxBudgetUsd) {
            yield { type: "error", error: new Error(`Budget limit reached: $${cost.toFixed(2)} >= $${this.config.maxBudgetUsd.toFixed(2)}. Use --max-budget-usd to increase.`), retryable: false };
            yield { type: "turn_end", stopReason: "error" };
            return;
          }
        } else {
          log.warn("budget", `No pricing data for model "${this.config.model}" — budget limit ($${this.config.maxBudgetUsd}) cannot be enforced`);
        }
      } catch (err) { log.debug("budget", "Failed to check budget limit: " + err); }
    }

    // Start transcript session on first message (skip if --no-session-persistence)
    if (!this.config.noSessionPersistence) {
      if (!this.transcript.isActive) {
        this.transcript.startSession(userMessage, this.config.sessionName);
      } else {
        this.transcript.append("user", "user_message", userMessage);
      }
    }

    // Auto-detect theoretical/formal prompts — disable tools at execution level
    if (looksTheoretical(userMessage)) {
      const lang = detectLanguage(userMessage);
      log.info("session", `Detected theoretical prompt (lang=${lang}) — strict analysis mode`);
      this._theoreticalMode = true;
      this._theoreticalRetries = 0;
      const langHint = lang !== "en" ? ` You MUST respond in ${lang === "es" ? "Spanish" : lang === "fr" ? "French" : lang === "pt" ? "Portuguese" : "the user's language"}.` : "";
      this.state.messages.push({
        role: "user",
        content: `[SYSTEM] STRICT ANALYSIS MODE: The user's question is theoretical/formal. Rules:\n` +
          `1. Respond with text only — do NOT use any tools.\n` +
          `2. Use Unicode for math (fᵢ : S → S, not LaTeX).\n` +
          `3. Be precise and concise — avoid verbose introductions and repetitive conclusions.\n` +
          `4. If data is missing for some items, state "No data provided for X" — do NOT invent values.\n` +
          `5. End with a single, clear conclusion — do NOT repeat the conclusion.\n` +
          `6. If your response will be long, prioritize structure over length.${langHint}`,
      });
    } else {
      this._theoreticalMode = false;
    }

    // Auto-detect staged/checkpoint requests — limit execution scope
    if (looksCheckpointed(userMessage)) {
      log.info("session", "Detected checkpoint request — will limit tool execution to initial stage");
      this._checkpointMode = true;
      this._checkpointToolCount = 0;
      // If a plan gets created during this turn, auto-set stopAfterStepId to the first step
      try {
        const { onPlanChange } = await import("../tools/plan.js");
        const unsubCheckpoint = onPlanChange((plan) => {
          if (plan && plan.steps.length > 0 && !plan.stopAfterStepId) {
            plan.stopAfterStepId = plan.steps[0].id;
            log.info("session", `Checkpoint: auto-set stopAfterStepId to "${plan.steps[0].id}"`);
          }
          unsubCheckpoint(); // Only need to catch the first plan creation
        });
      } catch { /* plan module not loaded */ }
      this.state.messages.push({
        role: "user",
        content: "[SYSTEM] The user asked for ONLY the first step or initial structure. Complete ONLY that stage, then STOP and provide a summary. Do NOT continue to additional features, pages, or implementation beyond the initial setup.",
      });
    } else {
      this._checkpointMode = false;
    }

    // Output budget: estimate if response will exceed output limit
    try {
      const { evaluateOutputBudget } = await import("./output-budget.js");
      const contextPct = this.state.tokenCount > 0
        ? Math.round((this.state.tokenCount / this.contextWindowSize) * 100)
        : 0;
      const budget = evaluateOutputBudget(userMessage, this.config.maxTokens, contextPct);
      if (budget.strategy !== "normal" && budget.systemHint) {
        log.info("session", `Output budget: ${budget.strategy} (est. ${budget.estimatedOutputTokens} tokens, max ${budget.maxAllowedTokens})`);
        this.state.messages.push({ role: "user", content: budget.systemHint });
      }
    } catch { /* module not loaded */ }

    // Begin response session for turn isolation
    try {
      const { beginResponseSession } = await import("./response-session.js");
      beginResponseSession(this.state.messages.length);
    } catch { /* module not loaded */ }

    this.state.messages.push({
      role: "user",
      content: userMessage,
    });

    // Layer 7: Update user model from message signals
    try { getUserModel().updateFromMessage(userMessage); } catch (err) { log.debug("user-model", "Failed to update user model from message: " + err); }

    // Layer 9: Reset intention engine for new turn
    try { getIntentionEngine().reset(); } catch (err) { log.debug("intention", "Failed to reset intention engine: " + err); }

    // Smart context: inject relevant file hints + code snippets based on user query
    try {
      const { getCodebaseIndex } = await import("./codebase-index.js");
      const idx = getCodebaseIndex(this.config.workingDirectory);

      if (this.state.messages.length <= 6) {
        // Early messages: inject rich snippets with actual code
        const snippets = idx.formatRelevantSnippets(userMessage, 60);
        if (snippets) {
          this.state.messages.push({
            role: "user",
            content: `[SYSTEM CONTEXT] ${snippets}`,
          });
        }
      } else if (this.state.messages.length <= 20) {
        // Later messages: inject lighter file hints only
        const contextHint = idx.formatRelevantContext(userMessage);
        if (contextHint) {
          this.state.messages.push({
            role: "user",
            content: `[SYSTEM CONTEXT] ${contextHint}`,
          });
        }
      }
    } catch (err) { log.debug("context", "Failed to inject smart context hints: " + err); }

    // Auto-invoke skills: match user message against trigger patterns
    // Injects Level 2 (full body) of matched skills as system context
    try {
      const { SkillManager } = await import("./skills.js");
      const sm = new SkillManager(this.config.workingDirectory);
      const matched = sm.matchAutoInvoke(userMessage);
      if (matched.length > 0) {
        const skillContext = matched
          .map((s) => {
            const body = sm.getLevel2Body(s.name);
            return body ? `[SKILL: ${s.name}]\n${body}` : null;
          })
          .filter(Boolean)
          .join("\n\n");
        if (skillContext) {
          this.state.messages.push({
            role: "user",
            content: `[SYSTEM CONTEXT — Auto-invoked skills]\n${skillContext}`,
          });
        }
      }
    } catch (err) { log.debug("skills", "Failed to auto-invoke skills: " + err); }

    // Auto-save checkpoint before each agent loop starts
    try {
      this.saveCheckpoint("auto:agent-loop-start");
    } catch (err) { log.warn("checkpoint", "Failed to save pre-loop checkpoint: " + err); }

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
        this.transcript.append("assistant", "tool_use", JSON.stringify({
          id: event.toolUseId,
          name: event.name,
          input: event.input,
        }));
        break;
      case "tool_result":
        this.transcript.append("tool", "tool_result", JSON.stringify({
          tool_use_id: event.toolUseId,
          name: event.name,
          content: (event.result ?? "").slice(0, 2000),
          is_error: event.isError,
        }));
        // Track error fingerprints for retry discipline
        if (event.isError && event.result && this._activeGuardState) {
          const burned = this._activeGuardState.recordToolError(event.name, event.result);
          if (burned) {
            log.warn("session", `Tool error fingerprint burned: ${event.name} — same error seen twice, will block retries`);
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
    // Track the tail of text from previous turn iteration (for dedup on truncation retry)
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
        const candidate = await SystemPromptBuilder.build(this.config, this.config.version);
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
          this.debugTracer.traceGuard("max-turns", true, `Turn ${turnCount} exceeds limit of ${effectiveMaxTurns} (effort: ${this.config.effortLevel ?? "medium"})`);
        }
        this.state.messages.push({
          role: "user",
          content: `[SYSTEM] STOP. You have used ${turnCount} consecutive tool turns. Summarize what you accomplished and stop. Do NOT make any more tool calls.`,
        });
        guardState.forceStopLoop = true;
      } else if (turnCount === 15) {
        this.state.messages.push({
          role: "user",
          content: "[SYSTEM] You have been running tools for 15 turns. Please wrap up your current task soon and report your progress. Only continue if you are close to finishing.",
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
          this.debugTracer.trace("context", "Compaction triggered", `Estimated ${preTokens} tokens >= threshold ${Math.floor(threshold)} (${Math.round(this.compactThreshold * 100)}% of ${this.contextWindowSize})`, { tokens: preTokens, threshold: Math.floor(threshold) });
        }
      }
      yield* pruneMessagesIfNeeded(this.state, this.systemPrompt, this.contextWindowSize, this.compactThreshold, this.config);

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

      const activeToolCalls = new Map<
        number,
        { id: string; name: string; argChunks: string[] }
      >();
      let textChunks: string[] = [];

      // Check response cache before making API call
      const cacheDisabled = this.config.noCache || this.config.thinking;
      const cacheKey = cacheDisabled ? "" : generateCacheKey(
        this.config.model,
        this.state.messages.map(m => ({
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
                const estimatedTokens = Math.round(streamedOutputChars / 4);
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
                yield { type: "tool_use_start", toolUseId: chunk.toolCallId, name: chunk.functionName };
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
                yield { type: "tool_input_delta", toolUseId: active.id, partialJson: chunk.functionArgDelta };
                const estimatedTokens = Math.round(streamedOutputChars / 4);
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
          if (extracted[0].prefixText.trim()) {
            assistantContent.push({ type: "text", text: extracted[0].prefixText.trim() });
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
            log.debug("parse", "Failed to parse tool call JSON (" + fullJson.length + " chars): " + err);
            if (fullJson.length > 50000) {
              parsedInput = { _raw: `[truncated: ${fullJson.length} chars of malformed JSON]` };
              log.warn("llm", `Truncated malformed tool args: ${fullJson.length} chars`);
            } else {
              parsedInput = { _raw: fullJson };
            }
          }
        }
        const toolBlock: ToolUseBlock = { type: "tool_use", id: active.id, name: active.name, input: parsedInput };
        assistantContent.push(toolBlock);
        toolCalls.push(toolBlock);
      }

      // Store assistant message in conversation history
      this.state.messages.push({ role: "assistant", content: assistantContent });

      // If force-stop is set, refuse to execute any more tools
      if (guardState.forceStopLoop && toolCalls.length > 0) {
        log.warn("session", `Force-stop active but model returned ${toolCalls.length} tool calls — dropping them`);
        const textOnly = assistantContent.filter(b => b.type === "text");
        if (textOnly.length > 0) {
          this.state.messages[this.state.messages.length - 1] = { role: "assistant", content: textOnly };
        }
        yield { type: "turn_end", stopReason: "force_stop" };
        this.abortController = null;
        return;
      }

      // Theoretical mode: drop all tool calls and force text-only response
      if (this._theoreticalMode && toolCalls.length > 0) {
        this._theoreticalRetries = (this._theoreticalRetries ?? 0) + 1;
        log.info("session", `Theoretical mode: dropping ${toolCalls.length} tool call(s) (attempt ${this._theoreticalRetries})`);
        const textOnly = assistantContent.filter(b => b.type === "text");
        this.state.messages[this.state.messages.length - 1] = {
          role: "assistant",
          content: textOnly.length > 0 ? textOnly : [{ type: "text", text: "" }],
        };

        // After 2 retries, accept whatever text exists and stop.
        // Do NOT disable theoretical mode — tools must never execute.
        if (this._theoreticalRetries >= 2) {
          log.warn("session", "Theoretical mode: model persists with tool calls after 2 retries — accepting text and stopping");
          // If there's any text content, the user gets that. If not, yield
          // an error so the user knows the model refused to comply.
          if (textOnly.length === 0 || textOnly.every(b => !(b as any).text)) {
            yield { type: "error", error: new Error("The model could not produce a text-only response for this theoretical question. Try rephrasing or using a different model."), retryable: false };
          }
          yield { type: "turn_end", stopReason: "theoretical_no_tools" };
          this._theoreticalRetries = 0;
          return;
        }

        this.state.messages.push({
          role: "user",
          content: "[SYSTEM] Tools are disabled for theoretical questions. Answer with text only. Do not attempt any tool calls.",
        });
        yield { type: "turn_end", stopReason: "theoretical_no_tools" };
        continue;
      }

      // Checkpoint mode: after enough tools for initial setup, force stop
      // This prevents the model from continuing to implement features
      // beyond what the user asked for (e.g., "just the initial structure").
      // Threshold: 4 tool calls — a tight limit for "first step only".
      // Scaffold typically needs: mkdir/create (1) + config write (2-3) + install (4).
      if (this._checkpointMode && toolCalls.length > 0) {
        this._checkpointToolCount += toolCalls.length;
        if (this._checkpointToolCount >= 4) {
          log.info("session", `Checkpoint mode: ${this._checkpointToolCount} tools used — forcing stop for stage summary`);
          const textOnly = assistantContent.filter(b => b.type === "text");
          this.state.messages[this.state.messages.length - 1] = {
            role: "assistant",
            content: textOnly.length > 0 ? textOnly : [{ type: "text", text: "" }],
          };
          this.state.messages.push({
            role: "user",
            content: "[SYSTEM] CHECKPOINT REACHED: You have completed enough work for the initial stage the user requested. STOP executing tools NOW. Provide a clear summary of: (1) what was created, (2) what still needs to be done, (3) suggested next step. Do NOT continue implementing.",
          });
          this._checkpointMode = false; // Disable after firing once
          guardState.forceStopLoop = true;
          yield { type: "turn_end", stopReason: "checkpoint_reached" };
          continue;
        }
      }

      // Plan coherence: validate execution against active plan step
      try {
        const { countInProgressSteps, getActiveStep, shouldStopAfterCurrentStep, classifyToolCoherence } = await import("../tools/plan.js");

        // Check if stopAfterStep was reached
        if (shouldStopAfterCurrentStep()) {
          log.info("session", "Plan stopAfterStep reached — forcing stop");
          const textOnly = assistantContent.filter(b => b.type === "text");
          this.state.messages[this.state.messages.length - 1] = {
            role: "assistant",
            content: textOnly.length > 0 ? textOnly : [{ type: "text", text: "" }],
          };
          this.state.messages.push({
            role: "user",
            content: "[SYSTEM] The plan's stop-after step has been completed. STOP and provide a summary of what was done. Do NOT continue to further steps.",
          });
          guardState.forceStopLoop = true;
          yield { type: "turn_end", stopReason: "plan_stop_reached" };
          continue;
        }

        // Check multiple in_progress
        const inProgress = countInProgressSteps();
        if (inProgress > 1) {
          log.warn("session", `Plan coherence: ${inProgress} steps in_progress simultaneously — injecting correction`);
          this.state.messages.push({
            role: "user",
            content: `[SYSTEM] Plan coherence warning: you have ${inProgress} steps marked as in_progress simultaneously. Finish the current step before starting another. Update the plan to reflect actual progress.`,
          });
        }

        // Check tool coherence against active step — warn or block
        const activeStep = getActiveStep();
        if (activeStep && toolCalls.length > 0) {
          const blocked: typeof toolCalls = [];
          const kept: typeof toolCalls = [];
          let warned = false;

          for (const tc of toolCalls) {
            const coherence = classifyToolCoherence(tc.name, tc.input as Record<string, unknown>, activeStep.title);
            if (coherence === "block") {
              log.warn("session", `Plan block: tool ${tc.name} contradicts step "${activeStep.title}" — blocking`);
              blocked.push(tc);
            } else if (coherence === "warn" && !warned) {
              warned = true;
              log.warn("session", `Plan deviation: tool ${tc.name} may not match step "${activeStep.title}"`);
              this.state.messages.push({
                role: "user",
                content: `[SYSTEM] Plan deviation detected: your action (${tc.name}) doesn't seem to match the current plan step "${activeStep.id}. ${activeStep.title}". Finish the current step first, or update the plan if you're intentionally changing approach.`,
              });
              kept.push(tc); // Warn but still allow
            } else {
              kept.push(tc);
            }
          }

          if (blocked.length > 0) {
            // Inject synthetic tool results for blocked calls
            const blockedResults: any[] = blocked.map(tc => ({
              type: "tool_result",
              tool_use_id: tc.id,
              content: `BLOCKED by plan: "${tc.name}" contradicts the current step "${activeStep.id}. ${activeStep.title}". Finish or update the current step first.`,
              is_error: true,
            }));
            this.state.messages.push({ role: "user", content: blockedResults });
            for (const tc of blocked) {
              yield { type: "tool_result" as const, name: tc.name, toolUseId: tc.id, result: blockedResults.find((r: any) => r.tool_use_id === tc.id)?.content ?? "Blocked", isError: true };
            }
            toolCalls = kept;
            if (kept.length === 0) continue; // All tools blocked, retry
          }
        }
      } catch { /* plan module not loaded */ }

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
            toolCalls: toolCalls.map(tc => tc.name),
            timestamp: Date.now(),
          });
          if (this.turnCosts.length > ConversationManager.MAX_TURN_COSTS) {
            this.turnCosts = this.turnCosts.slice(-ConversationManager.MAX_TURN_COSTS);
          }
        } catch (err) { log.debug("pricing", "Failed to track turn cost: " + err); }
      }

      // Client-side JSON schema validation (delegated to agent-loop-guards)
      if (this.config.jsonSchema && toolCalls.length === 0 && fullText.length > 0) {
        const { retryMessage, shouldAccept } = validateModelOutput(fullText, this.config.jsonSchema, guardState.jsonSchemaRetries);
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
          log.info("session", `Model hit output token limit (continuation ${guardState.maxTokensContinuations}/3) — injecting continue prompt`);
          if (this.debugTracer?.isEnabled()) {
            this.debugTracer.trace("decision", `max_tokens continuation ${guardState.maxTokensContinuations}/3`, "Model output was truncated, auto-continuing", { turn: turnCount });
          }
          this.state.messages.push({
            role: "user",
            content: "[SYSTEM] Your previous response was cut off because you hit the output token limit. Continue EXACTLY where you left off. Do not repeat what you already said — pick up mid-sentence if needed.",
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
            content: "You stopped before completing the task. Continue working — create the actual files and finish what you planned. Do not re-plan, just execute.",
          });
          yield { type: "turn_end", stopReason };
          continue;
        }

        // Cache text-only responses (delegated to post-turn)
        cacheResponseIfEligible(cacheKey, stopReason, toolCalls.length, textChunks, this.config.model, this.state.messages, this.state.tokenCount);

        // Knowledge distillation + benchmark scoring (delegated to post-turn)
        processKnowledgeAndBenchmark(stopReason, turnCount, this.state.messages, this.config.workingDirectory, this.config.model, this.state.toolUseCount, this.state.tokenCount);

        // Safety net: classify empty responses and retry with context-aware prompts
        const hasTextOutput = textChunks.join("").trim().length > 0;
        const hasThinkingOutput = thinkingChunks.length > 0 || (this.state.messages.at(-1) as any)?.thinkingContent;
        const hasToolOutput = toolCalls.length > 0;

        // Classify empty responses — persisted so the final turn_end carries it
        if (!hasTextOutput && stopReason === "end_turn") {
          guardState.lastEmptyType = hasThinkingOutput && !hasToolOutput ? "thinking_only"
            : hasToolOutput && !hasThinkingOutput ? "tools_only"
            : hasThinkingOutput && hasToolOutput ? "thinking_and_tools"
            : "no_output";
        } else {
          guardState.lastEmptyType = undefined;
        }

        if (!hasTextOutput && stopReason === "end_turn" && guardState.emptyEndTurnCount < 2) {
          guardState.emptyEndTurnCount++;

          log.info("session", `Empty response (${guardState.lastEmptyType}) on turn ${turnCount} — retry ${guardState.emptyEndTurnCount}/2`);

          // Context-aware retry prompt — include what was done so the model can summarize
          const toolCount = this.state.toolUseCount;
          const retryPrompt = guardState.lastEmptyType === "thinking_only"
            ? "[SYSTEM] You reasoned but produced no visible answer. Stop thinking and answer the user directly in plain text now."
            : guardState.lastEmptyType === "tools_only" || toolCount > 0
            ? `[SYSTEM] You executed ${toolCount} tools but didn't provide any response text. You MUST now write a brief summary (3-6 sentences) of what you accomplished. Do NOT use any more tools — just respond with text.`
            : guardState.lastEmptyType === "thinking_and_tools"
            ? "[SYSTEM] You reasoned and used tools but gave no visible answer. Provide a direct response to the user now."
            : "[SYSTEM] Your previous turn produced no output at all. Respond directly to the user now.";

          this.state.messages.push({ role: "user", content: retryPrompt });
          yield { type: "turn_end", stopReason: "empty_response_retry", emptyType: guardState.lastEmptyType };
          continue;
        }

        // Truncation heuristic: detect suspiciously incomplete responses
        // Check on any terminal stop (end_turn or tool_use — text before tools may be truncated)
        // Allow up to 2 retries for continuation
        if (hasTextOutput && (stopReason === "end_turn" || stopReason === "tool_use")) {
          let fullText = textChunks.join("").trim();

          // Dedup: if this is a continuation and the model repeated content
          if (previousTurnTail.length > 0 && fullText.length > 0) {
            const { mergeContinuation: mergeContFn } = await import("./continuation-merge.js");
            const mergeResult = mergeContFn(previousTurnTail, fullText);
            if (mergeResult.merged !== fullText) {
              log.info("session", `Continuation merge: stripped ${mergeResult.strippedChars} chars, ${mergeResult.strippedLines} lines${mergeResult.repeatedPrefixDetected ? " (heading restart)" : ""}`);
              fullText = mergeResult.merged;
              const lastMsg = this.state.messages[this.state.messages.length - 1];
              if (lastMsg?.role === "assistant" && Array.isArray(lastMsg.content)) {
                const textBlocks = (lastMsg.content as ContentBlock[]).filter(b => b.type === "text");
                if (textBlocks.length > 0) {
                  (textBlocks[0] as any).text = fullText;
                }
              }
            }
          }

          if (guardState.truncationRetries < 2 && looksIncomplete(fullText)) {
            guardState.truncationRetries++;
            log.info("session", `Response looks truncated (attempt ${guardState.truncationRetries}) — pushing for continuation`);
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
            yield { type: "text_delta" as const, text: "\n\n---\n*[Response may be incomplete — model reached output limit]*\n" };
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
          sendDesktopNotification("KCode", `Task completed (${turnCount} turns, ${Math.round(elapsedMs / 1000)}s)`);
        }

        // If turn had tool use but ends with no/minimal text output, emit structured
        // partial progress so the user sees what was accomplished.
        // "Minimal" = less than 20 chars of actual text (not just whitespace).
        const finalTextLen = textChunks.join("").trim().length;
        if (this.state.toolUseCount > 0 && finalTextLen < 20) {
          const elapsed = Date.now() - turnStartMs;
          const summary = this.collectSessionData();
          const lastError = summary.errorsEncountered > 0
            ? this.state.messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
                .filter((b: any) => b.type === "tool_result" && b.is_error)
                .map((b: any) => String(b.content ?? "").slice(0, 100))
                .pop() ?? ""
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
          const { closeResponseSession, getActiveResponseSession } = await import("./response-session.js");
          const session = getActiveResponseSession();
          if (session) {
            const finalText = textChunks.join("").trim();
            const isComplete = finalText.length >= 20 && !looksIncomplete(finalText);
            closeResponseSession(
              isComplete ? "completed" : (finalTextLen < 20 ? "failed" : "incomplete"),
              stopReason,
              guardState.lastEmptyType === "no_output" ? "Model returned no text" : undefined,
            );
          }
        } catch { /* module not loaded */ }

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
      let { filtered: filteredToolCalls, blockedResults } = preFilterToolCalls(toolCalls, guardState, this.config);
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
            } as any);
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
      const allParallelSafe = toolCalls.length > 1 && toolCalls.every((c) => this.tools.isParallelSafe(c.name));
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
          try { this.saveCheckpoint(`auto:before-${call.name}`); } catch (err) { log.warn("checkpoint", "Failed to save pre-edit checkpoint: " + err); }
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
          log.warn("session", `Loop redirect #${entry.redirects} for pattern "${pattern}" (${entry.count} calls) — forcing strategy change`);
          entry.count = 0;
          entry.examples = [];
          break;
        } else if (entry.count >= LOOP_PATTERN_THRESHOLD && entry.warned) {
          const redirectMsg = `[SYSTEM — PATTERN NOTICE] You have run ${entry.count} similar "${pattern}" commands. This approach doesn't seem to be working. Try a different strategy — different tools, different protocols, different angle. Keep working toward the user's goal.`;
          this.state.messages.push({ role: "user", content: redirectMsg });
          log.info("session", `Loop redirect SOFT injected for pattern "${pattern}" (${entry.count} calls)`);
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
            const cost = calculateCost(pricing, this.cumulativeUsage.inputTokens, this.cumulativeUsage.outputTokens);
            const pct = Math.round((cost / this.config.maxBudgetUsd) * 100);
            if (cost >= this.config.maxBudgetUsd) {
              yield { type: "budget_warning", costUsd: cost, limitUsd: this.config.maxBudgetUsd, pct: 100 };
              yield { type: "error", error: new Error(`Budget exhausted mid-loop: $${cost.toFixed(2)} >= $${this.config.maxBudgetUsd.toFixed(2)}`), retryable: false };
              yield { type: "turn_end", stopReason: "budget_exceeded" };
              return;
            } else if (pct >= 80) {
              yield { type: "budget_warning", costUsd: cost, limitUsd: this.config.maxBudgetUsd, pct };
            }
          }
        } catch (err) { log.debug("budget", "Failed to check mid-loop budget: " + err); }
      }

      // Layer 9: Inline warning — detect wasted context mid-loop
      try {
        const inlineWarning = getIntentionEngine().getInlineWarning();
        if (inlineWarning) {
          guardState.inlineWarningCount++;
          log.warn("intentions", `Inline warning #${guardState.inlineWarningCount}: ${inlineWarning.slice(0, 100)}`);

          if (guardState.inlineWarningCount >= 5) {
            log.warn("intentions", "Infinite loop detected: forcing agent loop stop after 5 inline warnings");
            this.state.messages.push({
              role: "user",
              content: `[SYSTEM] FORCE STOP: You have been warned ${guardState.inlineWarningCount} times about repeating the same actions. The agent loop is being terminated. Reply with text only — summarize what you accomplished and what you could not complete.`,
            });
            guardState.forceStopLoop = true;
          } else if (guardState.inlineWarningCount >= 2) {
            log.warn("intentions", `Inline warning #${guardState.inlineWarningCount}: model repeating actions, injecting strong redirect`);
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
      } catch (err) { log.debug("intention", "Failed to generate inline warning: " + err); }

      // Track consecutive permission denials to prevent infinite loops
      if (turnHadDenial) {
        guardState.consecutiveDenials++;

        if (this.config.permissionMode === "deny") {
          log.info("session", "Deny mode: stopping agent loop after first denial");
          this.state.messages.push({
            role: "user",
            content: "[SYSTEM] Permission mode is 'deny'. All tools are blocked. Do NOT attempt any tool calls. Reply with text only, explaining that you cannot perform this action because all tools are blocked. Suggest using -p auto or -p ask.",
          });
          guardState.consecutiveDenials = MAX_CONSECUTIVE_DENIALS - 1;
        } else if (guardState.consecutiveDenials >= MAX_CONSECUTIVE_DENIALS) {
          log.warn("session", `${MAX_CONSECUTIVE_DENIALS} consecutive permission denials, stopping agent loop`);
          yield { type: "turn_end", stopReason: "permission_denied" };
          this.abortController = null;
          return;
        } else {
          this.state.messages.push({
            role: "user",
            content: "[SYSTEM] Tool call was denied by the permission system. Do NOT retry the same tool. Reply with a text message explaining what happened.",
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
   * Delegates to extracted executeModelRequest() for the actual request.
   */
  private async createStreamWithRetry(): Promise<AsyncGenerator<SSEChunk>> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        let effectiveModel = this.config.model;
        if (this.config.autoRoute !== false && !this.config.modelExplicitlySet) {
          const recentText = this.getRecentMessageText();
          effectiveModel = await routeToModel(this.config.model, recentText);
          if (this.debugTracer?.isEnabled() && effectiveModel !== this.config.model) {
            this.debugTracer.traceModelSwitch(this.config.model, effectiveModel, "Auto-router selected different model based on message content");
          }
        }

        const requestStart = Date.now();
        const stream = await executeModelRequest(effectiveModel, this.config, this.systemPrompt, this.state.messages, this.tools, this.abortController);
        log.debug("llm", `Stream opened in ${Date.now() - requestStart}ms`);
        return stream;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // If the router sent us to a different model and it failed, fall back to primary
        {
          let effectiveModel = this.config.model;
          if (this.config.autoRoute !== false && !this.config.modelExplicitlySet) {
            const recentText = this.getRecentMessageText();
            effectiveModel = await routeToModel(this.config.model, recentText);
          }
          if (effectiveModel !== this.config.model) {
            log.warn("llm", `Routed model ${effectiveModel} failed, falling back to primary ${this.config.model}`);
            try {
              const stream = await executeModelRequest(this.config.model, this.config, this.systemPrompt, this.state.messages, this.tools, this.abortController);
              log.info("llm", `Primary model ${this.config.model} connected after routed model failure`);
              return stream;
            } catch (primaryErr) {
              log.error("llm", `Primary model also failed: ${primaryErr instanceof Error ? primaryErr.message : primaryErr}`);
            }
          }
        }

        if (attempt < this.maxRetries && isRetryableError(error)) {
          const delay = computeRetryDelay(attempt);
          log.warn("llm", `Retryable error (attempt ${attempt + 1}/${this.maxRetries}), retrying in ${delay}ms`, lastError);
          await sleep(delay);
          continue;
        }

        // Fallback model
        if (this.config.fallbackModel && this.config.fallbackModel !== this.config.model) {
          log.warn("llm", `Primary model failed, switching to fallback: ${this.config.fallbackModel}`);
          if (this.debugTracer?.isEnabled()) {
            this.debugTracer.traceModelSwitch(this.config.model, this.config.fallbackModel, `Primary model failed after ${attempt + 1} attempts: ${lastError?.message}`);
          }
          try {
            const stream = await executeModelRequest(this.config.fallbackModel, this.config, this.systemPrompt, this.state.messages, this.tools, this.abortController);
            log.info("llm", `Fallback model ${this.config.fallbackModel} connected`);
            return stream;
          } catch (fallbackErr) {
            log.error("llm", `Fallback model also failed: ${fallbackErr instanceof Error ? fallbackErr.message : fallbackErr}`);
          }
        }

        // Tertiary model
        if (this.config.tertiaryModel && this.config.tertiaryModel !== this.config.model && this.config.tertiaryModel !== this.config.fallbackModel) {
          log.warn("llm", `Primary + fallback failed, trying tertiary model: ${this.config.tertiaryModel}`);
          try {
            const stream = await executeModelRequest(this.config.tertiaryModel, this.config, this.systemPrompt, this.state.messages, this.tools, this.abortController, {
              maxTokens: Math.min(this.config.maxTokens, 4096),
              includeTools: false,
            });
            log.info("llm", `Tertiary model ${this.config.tertiaryModel} connected (no tools)`);
            return stream;
          } catch (tertiaryErr) {
            log.error("llm", `Tertiary model also failed: ${tertiaryErr instanceof Error ? tertiaryErr.message : tertiaryErr}`);
          }
        }

        // Fallback chain
        if (this.config.fallbackModels && this.config.fallbackModels.length > 0) {
          const triedModels = new Set([this.config.model, this.config.fallbackModel, this.config.tertiaryModel].filter(Boolean));
          for (const chainModel of this.config.fallbackModels) {
            if (triedModels.has(chainModel)) continue;
            triedModels.add(chainModel);
            log.warn("llm", `Falling back to model: ${chainModel}`);
            try {
              const stream = await executeModelRequest(chainModel, this.config, this.systemPrompt, this.state.messages, this.tools, this.abortController);
              log.info("llm", `Fallback chain model ${chainModel} connected`);
              return stream;
            } catch (chainErr) {
              log.error("llm", `Fallback chain model ${chainModel} failed: ${chainErr instanceof Error ? chainErr.message : chainErr}`);
            }
          }
        }

        log.error("llm", `Request failed: ${lastError.message}`, lastError);
        throw lastError;
      }
    }

    throw lastError ?? new Error("Unexpected retry exhaustion");
  }

  /** Rough estimate of current context size in tokens (delegates to context-manager). */
  private estimateContextTokens(): number {
    return estimateContextTokens(this.systemPrompt, this.state.messages);
  }

  // ─── Usage Tracking ─────────────────────────────────────────────

  private accumulateUsage(usage: TokenUsage): void {
    this.cumulativeUsage.inputTokens += usage.inputTokens;
    this.cumulativeUsage.outputTokens += usage.outputTokens;
    this.cumulativeUsage.cacheCreationInputTokens += usage.cacheCreationInputTokens;
    this.cumulativeUsage.cacheReadInputTokens += usage.cacheReadInputTokens;

    // Update legacy tokenCount
    this.state.tokenCount =
      this.cumulativeUsage.inputTokens + this.cumulativeUsage.outputTokens;
  }

  // ─── Router Helpers ────────────────────────────────────────────

  /**
   * Extract text from recent messages for routing heuristics.
   * Looks at the last few messages (user + tool results) to detect content type.
   */
  private getRecentMessageText(): string {
    const parts: string[] = [];
    // Check the last 4 messages (enough to catch recent tool results)
    const recent = this.state.messages.slice(-4);
    for (const msg of recent) {
      if (typeof msg.content === "string") {
        parts.push(msg.content);
      } else {
        for (const block of msg.content) {
          if (block.type === "text") {
            parts.push(block.text);
          } else if (block.type === "tool_result") {
            if (typeof block.content === "string") {
              parts.push(block.content);
            } else {
              for (const sub of block.content) {
                if (sub.type === "text") {
                  parts.push(sub.text);
                }
              }
            }
          }
        }
      }
    }
    return parts.join("\n");
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
    if (this.turnCosts.length === 0) return "";
    const lines: string[] = ["", "Turn-by-turn breakdown:"];
    for (const t of this.turnCosts) {
      const toolSuffix = t.toolCalls.length > 0 ? ` (${t.toolCalls.length} tool${t.toolCalls.length !== 1 ? "s" : ""})` : "";
      const costStr = t.costUsd > 0
        ? (t.costUsd < 0.01 ? `$${t.costUsd.toFixed(4)}` : `$${t.costUsd.toFixed(2)}`)
        : "$0.00";
      lines.push(
        `  Turn ${t.turnIndex}: ${t.model}${toolSuffix} — ${t.inputTokens.toLocaleString()} in / ${t.outputTokens.toLocaleString()} out — ${costStr}`,
      );
    }
    return lines.join("\n");
  }

  /**
   * Save a checkpoint of the current conversation state.
   * @param label Optional label for the checkpoint (defaults to auto-generated)
   */
  saveCheckpoint(label?: string): void {
    const cpLabel = label ?? `checkpoint-${this.checkpoints.length + 1}`;
    // Only checkpoint if message count is reasonable (avoid OOM)
    if (this.state.messages.length > 500) return;

    this.checkpoints.push({
      label: cpLabel,
      messageIndex: this.state.messages.length,
      undoSize: this.undoManager.size,
      timestamp: Date.now(),
    });
    if (this.checkpoints.length > ConversationManager.MAX_CHECKPOINTS) {
      this.checkpoints.shift();
    }
  }

  /**
   * Rewind conversation to a specific checkpoint by index.
   * If no index is provided, rewinds to the most recent checkpoint.
   * Also undoes file changes back to that point.
   * Returns a description of what was rewound, or null if no checkpoints.
   */
  rewindToCheckpoint(index?: number): string | null {
    if (this.checkpoints.length === 0) return null;

    // Determine which checkpoint to rewind to
    let cpIndex: number;
    if (index === undefined) {
      cpIndex = this.checkpoints.length - 1;
    } else if (index < 0 || index >= this.checkpoints.length) {
      return `Invalid checkpoint index ${index}. Available: 0-${this.checkpoints.length - 1}`;
    } else {
      cpIndex = index;
    }

    const cp = this.checkpoints[cpIndex]!;

    // Remove this checkpoint and all after it
    this.checkpoints = this.checkpoints.slice(0, cpIndex);

    // Undo file changes back to checkpoint's undo stack size
    const undosNeeded = this.undoManager.size - cp.undoSize;
    const undone: string[] = [];
    for (let i = 0; i < undosNeeded; i++) {
      const result = this.undoManager.undo();
      if (result) undone.push(result);
    }

    // Truncate messages back to checkpoint's message index (clamped to current length in case pruning shortened the array)
    const safeIndex = Math.min(cp.messageIndex, this.state.messages.length);
    this.state.messages = this.state.messages.slice(0, safeIndex);
    const age = Math.round((Date.now() - cp.timestamp) / 1000);

    return [
      `Rewound to checkpoint "${cp.label}" (${age}s ago, message index ${cp.messageIndex})`,
      undone.length > 0 ? `File changes undone:\n${undone.join("\n")}` : "No file changes to undo.",
      `Remaining checkpoints: ${this.checkpoints.length}`,
    ].join("\n");
  }

  /**
   * List all saved checkpoints with their labels and timestamps.
   */
  listCheckpoints(): Array<{ index: number; label: string; messageIndex: number; timestamp: number; age: string }> {
    return this.checkpoints.map((cp, i) => {
      const ageMs = Date.now() - cp.timestamp;
      const ageSec = Math.round(ageMs / 1000);
      let age: string;
      if (ageSec < 60) age = `${ageSec}s ago`;
      else if (ageSec < 3600) age = `${Math.round(ageSec / 60)}m ago`;
      else age = `${Math.round(ageSec / 3600)}h ago`;

      return {
        index: i,
        label: cp.label,
        messageIndex: cp.messageIndex,
        timestamp: cp.timestamp,
        age,
      };
    });
  }

  /**
   * Get number of available checkpoints.
   */
  getCheckpointCount(): number {
    return this.checkpoints.length;
  }

  /**
   * Restore messages from a previous session (for --continue).
   * Sets the message history and estimates token count from content length.
   */
  restoreMessages(messages: Message[]): void {
    this.state.messages = [...messages];
    // Rough token estimate: ~4 chars per token
    let totalChars = 0;
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        totalChars += msg.content.length;
      } else {
        for (const block of msg.content) {
          if (block.type === "text") {
            totalChars += block.text.length;
          } else if (block.type === "thinking") {
            totalChars += block.thinking.length;
          } else if (block.type === "tool_use") {
            totalChars += JSON.stringify(block.input).length;
          } else if (block.type === "tool_result") {
            totalChars += typeof block.content === "string"
              ? block.content.length
              : JSON.stringify(block.content).length;
          }
        }
      }
    }
    this.state.tokenCount = Math.ceil(totalChars / 4);
  }

  /**
   * Fork the conversation: keep current messages but start a new transcript.
   * Optionally truncate to a specific message count (fork from a point in history).
   */
  forkConversation(keepMessages?: number): { messageCount: number; sessionId: string } {
    const previousSessionId = this.sessionId;
    const msgs = keepMessages
      ? this.state.messages.slice(0, keepMessages)
      : [...this.state.messages];
    // Start a new transcript (only if session persistence is enabled)
    this.transcript = new TranscriptManager();
    const summary = msgs.length > 0
      ? (typeof msgs[0].content === "string" ? msgs[0].content : "[forked session]").slice(0, 80)
      : "forked session";
    if (!this.config.noSessionPersistence) {
      this.transcript.startSession(`[FORK] ${summary}`);
    }
    this.state.messages = msgs;

    // Generate new session ID for the fork
    const newSessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.sessionId = newSessionId;

    // Persist branch relationship (only if session persistence is enabled)
    if (!this.config.noSessionPersistence) {
      try {
        const bm = getBranchManager();
        // Ensure parent branch is registered (if not already)
        const parentBranch = bm.getBranch(previousSessionId);
        if (!parentBranch) {
          bm.saveBranch(previousSessionId, null, summary, `session-${previousSessionId}`, msgs.length);
        }
        bm.saveBranch(newSessionId, previousSessionId, `[FORK] ${summary}`, `session-${newSessionId}`, msgs.length);
      } catch (err) {
        log.warn("branch", "Failed to persist branch data during fork: " + err);
      }
    }

    return { messageCount: msgs.length, sessionId: newSessionId };
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
    const toolsUsed: string[] = [];
    const filesModified: string[] = [];
    let errorsEncountered = 0;

    for (const msg of this.state.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            toolsUsed.push(block.name);
            if (block.name === "Write" || block.name === "Edit") {
              const fp = String((block.input as any)?.file_path ?? "");
              if (fp && !filesModified.includes(fp)) filesModified.push(fp);
            }
          }
          if (block.type === "tool_result" && block.is_error) {
            errorsEncountered++;
          }
        }
      }
    }

    return {
      project: this.config.workingDirectory,
      messagesCount: this.state.messages.length,
      toolsUsed,
      actionsCount: this.state.toolUseCount,
      topicsDiscussed: [],
      errorsEncountered,
      filesModified,
    };
  }

  /**
   * Reset conversation state for a new session.
   */
  reset(): void {
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
    this.turnCosts = [];
  }

  /** Fast string hash for cache comparison (djb2). */
  private hashString(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }

  /** Get session start time for elapsed time tracking. */
  getSessionStartTime(): number {
    return this.sessionStartTime;
  }

  /** Send a desktop notification (Linux: notify-send, macOS: osascript). */
  sendNotification(title: string, body: string): void {
    sendDesktopNotification(title, body);
  }

  /** Get list of files modified in this session (from undo manager). */
  getModifiedFiles(): string[] {
    const files: string[] = [];
    for (const msg of this.state.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use" && (block.name === "Write" || block.name === "Edit")) {
            const fp = String((block.input as any)?.file_path ?? "");
            if (fp && !files.includes(fp)) files.push(fp);
          }
        }
      }
    }
    return files;
  }
}
