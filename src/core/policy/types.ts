// Policy types — limits, violations, and budget tracking

export interface PolicyLimits {
  /** Max tokens (input + output) per session. 0 = unlimited */
  maxTokensPerSession: number;
  /** Max tool calls per individual turn. 0 = unlimited */
  maxToolCallsPerTurn: number;
  /** Max concurrent agents in swarm. 0 = unlimited */
  maxConcurrentAgents: number;
  /** Minimum cooldown between LLM requests in ms. 0 = no cooldown */
  minRequestIntervalMs: number;
  /** Max budget in USD per session. 0 = unlimited */
  maxBudgetUsd: number;
  /** Max budget in USD per day. 0 = unlimited */
  maxDailyBudgetUsd: number;
  /** Tools blocked by policy (by name) */
  blockedTools: string[];
  /** Allowed models (empty = all allowed) */
  allowedModels: string[];
}

export interface PolicyViolation {
  type:
    | "token_limit"
    | "tool_limit"
    | "agent_limit"
    | "rate_limit"
    | "budget_limit"
    | "blocked_tool"
    | "blocked_model";
  message: string;
  current: number;
  limit: number;
}

export type PolicyCheckResult = { allowed: true } | { allowed: false; violation: PolicyViolation };

export interface BudgetSnapshot {
  sessionTokensUsed: number;
  sessionCostUsd: number;
  dailyCostUsd: number;
  activeAgents: number;
  turnToolCalls: number;
}

export interface DailyUsageRecord {
  date: string; // YYYY-MM-DD
  tokensUsed: number;
  costUsd: number;
  sessions: number;
}
