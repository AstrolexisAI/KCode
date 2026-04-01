// KCode - Insights Types

export interface Insight {
  type: "recommendation" | "pattern" | "alert" | "achievement";
  title: string;
  description: string;
  data?: Record<string, unknown>;
  priority: "low" | "medium" | "high";
}

export interface ModelComparison {
  model: string;
  sessions: number;
  avgTokensPerSession: number;
  avgCostPerSession: number;
  avgLatencyMs: number;
  successRate: number;
  toolCallsPerSession: number;
}

export interface ROIMetrics {
  totalCostUsd: number;
  estimatedTimeSavedHours: number;
  estimatedValueUsd: number;
  roi: number;
  topTimeSavers: Array<{ category: string; timeSavedHours: number }>;
}

export interface ChartData {
  label: string;
  value: number;
}

export interface ExportOptions {
  format: "json" | "csv";
  days: number;
  output?: string;
}
