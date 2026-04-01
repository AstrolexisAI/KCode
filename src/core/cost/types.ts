// KCode - Cost Dashboard Types

export interface CostEntry {
  timestamp: number;
  sessionId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolName?: string;
}

export type CostPeriod = "today" | "week" | "month" | "all";

export interface CostSummary {
  period: CostPeriod;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  sessions: number;
  avgCostPerSession: number;
  byModel: Array<{ model: string; costUsd: number; percentage: number }>;
  byDay: Array<{ date: string; costUsd: number }>;
  trend: "up" | "down" | "stable";
  trendPercentage: number;
}
