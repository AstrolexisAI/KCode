// KCode - Model Quality Benchmarks
// Tracks model response quality over time using automated evaluation metrics.
// Stores results in SQLite for trend analysis.

import { getDb } from "./db";
import { log } from "./logger";

// ─── Schema ─────────────────────────────────────────────────────

export function initBenchmarkSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS benchmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      task_type TEXT NOT NULL DEFAULT 'general',
      score REAL NOT NULL,
      tokens_used INTEGER DEFAULT 0,
      latency_ms INTEGER DEFAULT 0,
      details TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bench_model ON benchmarks(model)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bench_date ON benchmarks(created_at)`);
}

// ─── Types ──────────────────────────────────────────────────────

export interface BenchmarkResult {
  model: string;
  taskType: string;
  score: number;       // 0.0 - 1.0
  tokensUsed: number;
  latencyMs: number;
  details: Record<string, unknown>;
}

export interface BenchmarkSummary {
  model: string;
  totalRuns: number;
  avgScore: number;
  avgLatencyMs: number;
  totalTokens: number;
  trend: "improving" | "declining" | "stable";
  byTaskType: Record<string, { runs: number; avgScore: number }>;
  recentScores: number[]; // last 10
}

// ─── Quality Scoring ────────────────────────────────────────────

/**
 * Score a model response on multiple quality dimensions.
 * Returns a composite score between 0.0 and 1.0.
 */
export function scoreResponse(params: {
  response: string;
  toolsUsed: number;
  errorsEncountered: number;
  taskCompleted: boolean;
  turnCount: number;
  userSatisfied?: boolean; // from explicit feedback
}): number {
  const weights = {
    completion: 0.35,     // Did it complete the task?
    efficiency: 0.25,     // How many turns / tool calls?
    errorFree: 0.20,      // Were there errors?
    conciseness: 0.10,    // Was the response reasonably sized?
    satisfaction: 0.10,   // Explicit user feedback
  };

  let score = 0;

  // Completion score
  score += weights.completion * (params.taskCompleted ? 1.0 : 0.2);

  // Efficiency: fewer turns = better (normalize: 1 turn = 1.0, 25 turns = 0.1)
  const efficiencyScore = Math.max(0.1, 1.0 - (params.turnCount - 1) / 25);
  score += weights.efficiency * efficiencyScore;

  // Error-free: penalize errors heavily
  const errorScore = params.errorsEncountered === 0 ? 1.0 : Math.max(0, 1.0 - params.errorsEncountered * 0.3);
  score += weights.errorFree * errorScore;

  // Conciseness: penalize very long responses (>5000 chars)
  const responseLen = params.response.length;
  const concisenessScore = responseLen < 2000 ? 1.0 : responseLen < 5000 ? 0.7 : 0.4;
  score += weights.conciseness * concisenessScore;

  // User satisfaction (if provided)
  if (params.userSatisfied !== undefined) {
    score += weights.satisfaction * (params.userSatisfied ? 1.0 : 0.0);
  } else {
    // Redistribute weight to completion
    score += weights.satisfaction * (params.taskCompleted ? 0.8 : 0.3);
  }

  return Math.max(0, Math.min(1, score));
}

// ─── Storage ────────────────────────────────────────────────────

export function saveBenchmark(result: BenchmarkResult): void {
  try {
    const db = getDb();
    db.run(
      `INSERT INTO benchmarks (model, task_type, score, tokens_used, latency_ms, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        result.model,
        result.taskType,
        result.score,
        result.tokensUsed,
        result.latencyMs,
        JSON.stringify(result.details),
      ],
    );
  } catch (err) {
    log.debug("benchmark", `Failed to save benchmark: ${err}`);
  }
}

// ─── Analysis ───────────────────────────────────────────────────

export function getBenchmarkSummary(model?: string, days: number = 30): BenchmarkSummary[] {
  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    interface ModelRow { model: string }
    interface BenchmarkRow { task_type: string; score: number; tokens_used: number; latency_ms: number; created_at: string }

    const models: string[] = model
      ? [model]
      : (db.query(`SELECT DISTINCT model FROM benchmarks WHERE created_at > ?`).all(cutoff) as ModelRow[]).map((r) => r.model);

    const summaries: BenchmarkSummary[] = [];

    for (const m of models) {
      const rows = db.query(
        `SELECT task_type, score, tokens_used, latency_ms, created_at
         FROM benchmarks WHERE model = ? AND created_at > ?
         ORDER BY created_at DESC`,
      ).all(m, cutoff) as BenchmarkRow[];

      if (rows.length === 0) continue;

      const avgScore = rows.reduce((sum, r) => sum + r.score, 0) / rows.length;
      const avgLatencyMs = rows.reduce((sum, r) => sum + r.latency_ms, 0) / rows.length;
      const totalTokens = rows.reduce((sum, r) => sum + r.tokens_used, 0);

      // By task type
      const byTaskType: Record<string, { runs: number; avgScore: number }> = {};
      for (const row of rows) {
        if (!byTaskType[row.task_type]) {
          byTaskType[row.task_type] = { runs: 0, avgScore: 0 };
        }
        byTaskType[row.task_type].runs++;
        byTaskType[row.task_type].avgScore += row.score;
      }
      for (const key of Object.keys(byTaskType)) {
        byTaskType[key].avgScore /= byTaskType[key].runs;
      }

      // Trend: compare first half vs second half
      const midpoint = Math.floor(rows.length / 2);
      const recentAvg = rows.slice(0, midpoint).reduce((s, r) => s + r.score, 0) / (midpoint || 1);
      const olderAvg = rows.slice(midpoint).reduce((s, r) => s + r.score, 0) / ((rows.length - midpoint) || 1);
      const diff = recentAvg - olderAvg;
      const trend = diff > 0.05 ? "improving" : diff < -0.05 ? "declining" : "stable";

      // Recent scores
      const recentScores = rows.slice(0, 10).map((r) => r.score);

      summaries.push({
        model: m,
        totalRuns: rows.length,
        avgScore,
        avgLatencyMs,
        totalTokens,
        trend,
        byTaskType,
        recentScores,
      });
    }

    return summaries;
  } catch (err) {
    log.debug("benchmark", `Failed to get benchmark summary: ${err}`);
    return [];
  }
}

/**
 * Format benchmark summaries as a human-readable string.
 */
export function formatBenchmarks(summaries: BenchmarkSummary[]): string {
  if (summaries.length === 0) return "No benchmark data available.";

  const lines: string[] = ["Model Quality Benchmarks", ""];

  for (const s of summaries) {
    const trendIcon = s.trend === "improving" ? "↑" : s.trend === "declining" ? "↓" : "→";
    lines.push(`${s.model} (${s.totalRuns} runs)`);
    lines.push(`  Score:   ${(s.avgScore * 100).toFixed(1)}% ${trendIcon} ${s.trend}`);
    lines.push(`  Latency: ${s.avgLatencyMs.toFixed(0)}ms avg`);
    lines.push(`  Tokens:  ${s.totalTokens.toLocaleString()} total`);

    if (Object.keys(s.byTaskType).length > 1) {
      lines.push("  By task:");
      for (const [type, data] of Object.entries(s.byTaskType).sort((a, b) => b[1].runs - a[1].runs)) {
        lines.push(`    ${type}: ${(data.avgScore * 100).toFixed(0)}% (${data.runs} runs)`);
      }
    }

    if (s.recentScores.length > 0) {
      const sparkline = s.recentScores.map((sc) => {
        if (sc >= 0.8) return "█";
        if (sc >= 0.6) return "▆";
        if (sc >= 0.4) return "▃";
        return "▁";
      }).join("");
      lines.push(`  Recent: ${sparkline} (last ${s.recentScores.length})`);
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
