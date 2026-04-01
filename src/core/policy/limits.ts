// Policy Engine — Enforces configurable limits on tokens, tools, agents, budget.
// Checks are non-blocking: they return allowed/denied but never throw.

import type { BudgetSnapshot, PolicyCheckResult, PolicyLimits, PolicyViolation } from "./types";

export const DEFAULT_LIMITS: PolicyLimits = {
  maxTokensPerSession: 0, // unlimited
  maxToolCallsPerTurn: 50, // safety net
  maxConcurrentAgents: 10, // prevent fork bombs
  minRequestIntervalMs: 0, // no cooldown
  maxBudgetUsd: 0, // unlimited
  maxDailyBudgetUsd: 0, // unlimited
  blockedTools: [],
  allowedModels: [],
};

export class PolicyEngine {
  private limits: PolicyLimits;
  private sessionTokens = 0;
  private turnToolCalls = 0;
  private activeAgents = 0;
  private lastRequestTime = 0;
  private sessionCostUsd = 0;
  private dailyCostUsd = 0;
  private dailyDate: string;

  constructor(limits: Partial<PolicyLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.dailyDate = new Date().toISOString().slice(0, 10);
  }

  /** Check if an LLM request is allowed */
  checkRequest(estimatedTokens: number): PolicyCheckResult {
    // Token limit
    if (
      this.limits.maxTokensPerSession > 0 &&
      this.sessionTokens + estimatedTokens > this.limits.maxTokensPerSession
    ) {
      return this.violation(
        "token_limit",
        `Session token limit reached (${this.sessionTokens}/${this.limits.maxTokensPerSession})`,
        this.sessionTokens,
        this.limits.maxTokensPerSession,
      );
    }

    // Rate limit
    if (this.limits.minRequestIntervalMs > 0) {
      const elapsed = Date.now() - this.lastRequestTime;
      if (this.lastRequestTime > 0 && elapsed < this.limits.minRequestIntervalMs) {
        const wait = this.limits.minRequestIntervalMs - elapsed;
        return this.violation(
          "rate_limit",
          `Cooldown: wait ${wait}ms before next request`,
          elapsed,
          this.limits.minRequestIntervalMs,
        );
      }
    }

    return { allowed: true };
  }

  /** Check if a tool call is allowed */
  checkToolCall(toolName: string): PolicyCheckResult {
    if (this.limits.blockedTools.includes(toolName)) {
      return this.violation("blocked_tool", `Tool '${toolName}' is blocked by policy`, 0, 0);
    }

    if (
      this.limits.maxToolCallsPerTurn > 0 &&
      this.turnToolCalls >= this.limits.maxToolCallsPerTurn
    ) {
      return this.violation(
        "tool_limit",
        `Max ${this.limits.maxToolCallsPerTurn} tool calls per turn`,
        this.turnToolCalls,
        this.limits.maxToolCallsPerTurn,
      );
    }

    return { allowed: true };
  }

  /** Check if a model is allowed */
  checkModel(modelId: string): PolicyCheckResult {
    if (this.limits.allowedModels.length > 0 && !this.limits.allowedModels.includes(modelId)) {
      return this.violation("blocked_model", `Model '${modelId}' not in allowed list`, 0, 0);
    }
    return { allowed: true };
  }

  /** Check if another agent can be spawned */
  checkAgentSpawn(): PolicyCheckResult {
    if (
      this.limits.maxConcurrentAgents > 0 &&
      this.activeAgents >= this.limits.maxConcurrentAgents
    ) {
      return this.violation(
        "agent_limit",
        `Max ${this.limits.maxConcurrentAgents} concurrent agents`,
        this.activeAgents,
        this.limits.maxConcurrentAgents,
      );
    }
    return { allowed: true };
  }

  /** Check budget */
  checkBudget(estimatedCostUsd: number): PolicyCheckResult {
    this.rollDailyIfNeeded();

    if (
      this.limits.maxBudgetUsd > 0 &&
      this.sessionCostUsd + estimatedCostUsd > this.limits.maxBudgetUsd
    ) {
      return this.violation(
        "budget_limit",
        `Session budget exhausted ($${this.sessionCostUsd.toFixed(4)}/$${this.limits.maxBudgetUsd})`,
        this.sessionCostUsd,
        this.limits.maxBudgetUsd,
      );
    }

    if (
      this.limits.maxDailyBudgetUsd > 0 &&
      this.dailyCostUsd + estimatedCostUsd > this.limits.maxDailyBudgetUsd
    ) {
      return this.violation(
        "budget_limit",
        `Daily budget exhausted ($${this.dailyCostUsd.toFixed(4)}/$${this.limits.maxDailyBudgetUsd})`,
        this.dailyCostUsd,
        this.limits.maxDailyBudgetUsd,
      );
    }

    return { allowed: true };
  }

  // ── Recording ──

  /** Record usage after a successful request */
  recordUsage(tokens: number, costUsd: number): void {
    this.rollDailyIfNeeded();
    this.sessionTokens += tokens;
    this.sessionCostUsd += costUsd;
    this.dailyCostUsd += costUsd;
    this.lastRequestTime = Date.now();
  }

  recordToolCall(): void {
    this.turnToolCalls++;
  }

  resetTurnToolCalls(): void {
    this.turnToolCalls = 0;
  }

  recordAgentSpawn(): void {
    this.activeAgents++;
  }

  recordAgentComplete(): void {
    this.activeAgents = Math.max(0, this.activeAgents - 1);
  }

  // ── Getters ──

  /** Get current status for UI / /cost command */
  getStatus(): BudgetSnapshot & { limits: PolicyLimits } {
    return {
      sessionTokensUsed: this.sessionTokens,
      sessionCostUsd: this.sessionCostUsd,
      dailyCostUsd: this.dailyCostUsd,
      activeAgents: this.activeAgents,
      turnToolCalls: this.turnToolCalls,
      limits: { ...this.limits },
    };
  }

  /** Update limits at runtime (e.g., from MDM or /policy command) */
  updateLimits(partial: Partial<PolicyLimits>): void {
    Object.assign(this.limits, partial);
  }

  // ── Internal ──

  private rollDailyIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyDate) {
      this.dailyCostUsd = 0;
      this.dailyDate = today;
    }
  }

  private violation(
    type: PolicyViolation["type"],
    message: string,
    current: number,
    limit: number,
  ): PolicyCheckResult {
    return { allowed: false, violation: { type, message, current, limit } };
  }
}
