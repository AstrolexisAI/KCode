// KCode - Model Certification Suite
// Evaluates model capabilities across 5 categories to assign a certification level.

// ─── Types ──────────────────────────────────────────────────────

export enum CertificationLevel {
  Gold = "Gold",
  Silver = "Silver",
  Bronze = "Bronze",
  Failed = "Failed",
}

export interface CategoryScore {
  category: string;
  score: number;
  maxScore: number;
  passed: number;
  failed: number;
}

export interface CertificationTaskResult {
  taskId: string;
  category: string;
  name: string;
  score: number;
  maxScore: number;
  passed: boolean;
  timeMs: number;
  error?: string;
}

export interface CertificationResult {
  modelName: string;
  level: CertificationLevel;
  totalScore: number;
  maxPossibleScore: number;
  categories: {
    tool_calling: CategoryScore;
    code_generation: CategoryScore;
    instruction_following: CategoryScore;
    context_handling: CategoryScore;
    safety: CategoryScore;
  };
  detailedResults: CertificationTaskResult[];
  timestamp: string;
  durationMs: number;
}

export interface CertificationTask {
  id: string;
  name: string;
  category: "tool_calling" | "code_generation" | "instruction_following" | "context_handling" | "safety";
  prompt: string;
  systemPrompt?: string;
  validation: (response: string) => boolean;
  maxScore: 1 | 2;
  maxTimeMs: number;
}

export interface CertificationConfig {
  modelUrl: string;
  modelName: string;
  apiKey?: string;
}

// ─── Certification Level Logic ─────────────────────────────────

/**
 * Determine certification level from total score.
 * Gold: 45+/50, Silver: 35+/50, Bronze: 25+/50, Failed: <25/50
 */
export function determineCertificationLevel(score: number): CertificationLevel {
  if (score >= 45) return CertificationLevel.Gold;
  if (score >= 35) return CertificationLevel.Silver;
  if (score >= 25) return CertificationLevel.Bronze;
  return CertificationLevel.Failed;
}

// ─── Runner ────────────────────────────────────────────────────

/**
 * Run a single certification task against a model endpoint.
 */
async function runCertificationTask(
  task: CertificationTask,
  config: CertificationConfig,
): Promise<CertificationTaskResult> {
  const start = Date.now();
  let responseText = "";

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.apiKey) {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    const messages: { role: string; content: string }[] = [];
    if (task.systemPrompt) {
      messages.push({ role: "system", content: task.systemPrompt });
    } else {
      messages.push({
        role: "system",
        content: "You are a coding assistant integrated into a terminal IDE. Follow instructions precisely.",
      });
    }
    messages.push({ role: "user", content: task.prompt });

    const body = JSON.stringify({
      model: config.modelName,
      messages,
      max_tokens: 2048,
      stream: true,
    });

    const apiUrl = config.modelUrl.replace(/\/+$/, "") + "/v1/chat/completions";
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(task.maxTimeMs),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      return {
        taskId: task.id,
        category: task.category,
        name: task.name,
        score: 0,
        maxScore: task.maxScore,
        passed: false,
        timeMs: Date.now() - start,
        error: `HTTP ${resp.status}: ${errBody.slice(0, 200)}`,
      };
    }

    // Stream SSE response
    const reader = resp.body?.getReader();
    const decoder = new TextDecoder();

    if (reader) {
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const chunk = JSON.parse(data);
            const content = chunk.choices?.[0]?.delta?.content ?? "";
            responseText += content;
          } catch {
            // skip malformed chunks
          }
        }
      }
    }

    const timeMs = Date.now() - start;
    const passed = task.validation(responseText);

    return {
      taskId: task.id,
      category: task.category,
      name: task.name,
      score: passed ? task.maxScore : 0,
      maxScore: task.maxScore,
      passed,
      timeMs,
    };
  } catch (err) {
    return {
      taskId: task.id,
      category: task.category,
      name: task.name,
      score: 0,
      maxScore: task.maxScore,
      passed: false,
      timeMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Main Certification Runner ─────────────────────────────────

/**
 * Run the full certification suite against a model.
 */
export async function runCertification(
  modelUrl: string,
  modelName: string,
  apiKey?: string,
): Promise<CertificationResult> {
  // Dynamic import to avoid circular dependency
  const { CERTIFICATION_TASKS } = await import("./tasks");

  const config: CertificationConfig = { modelUrl, modelName, apiKey };
  const start = Date.now();
  const detailedResults: CertificationTaskResult[] = [];

  for (const task of CERTIFICATION_TASKS) {
    process.stdout.write(`  Running: ${task.name}...`);
    const result = await runCertificationTask(task, config);
    detailedResults.push(result);

    const status = result.passed ? "PASS" : "FAIL";
    console.log(` ${status} (${result.timeMs}ms)`);

    if (result.error) {
      console.log(`    Error: ${result.error.slice(0, 120)}`);
    }
  }

  const durationMs = Date.now() - start;

  // Aggregate by category
  const categoryNames = [
    "tool_calling",
    "code_generation",
    "instruction_following",
    "context_handling",
    "safety",
  ] as const;

  const categories = {} as CertificationResult["categories"];

  for (const cat of categoryNames) {
    const catResults = detailedResults.filter((r) => r.category === cat);
    categories[cat] = {
      category: cat,
      score: catResults.reduce((s, r) => s + r.score, 0),
      maxScore: catResults.reduce((s, r) => s + r.maxScore, 0),
      passed: catResults.filter((r) => r.passed).length,
      failed: catResults.filter((r) => !r.passed).length,
    };
  }

  const totalScore = detailedResults.reduce((s, r) => s + r.score, 0);
  const maxPossibleScore = detailedResults.reduce((s, r) => s + r.maxScore, 0);
  const level = determineCertificationLevel(totalScore);

  return {
    modelName,
    level,
    totalScore,
    maxPossibleScore,
    categories,
    detailedResults,
    timestamp: new Date().toISOString(),
    durationMs,
  };
}

// ─── Report Formatting ─────────────────────────────────────────

/**
 * Format certification results into a readable report.
 */
export function formatCertificationReport(result: CertificationResult): string {
  const lines: string[] = [];

  const badge = {
    [CertificationLevel.Gold]: "[***] GOLD",
    [CertificationLevel.Silver]: "[**-] SILVER",
    [CertificationLevel.Bronze]: "[*--] BRONZE",
    [CertificationLevel.Failed]: "[---] FAILED",
  };

  lines.push("");
  lines.push("  KCode Model Certification Report");
  lines.push("  " + "=".repeat(56));
  lines.push("");
  lines.push(`  Model:         ${result.modelName}`);
  lines.push(`  Certification: ${badge[result.level]}`);
  lines.push(`  Total Score:   ${result.totalScore}/${result.maxPossibleScore}`);
  lines.push(`  Duration:      ${(result.durationMs / 1000).toFixed(1)}s`);
  lines.push(`  Timestamp:     ${result.timestamp}`);
  lines.push("");
  lines.push("  Category Breakdown");
  lines.push("  " + "-".repeat(56));

  const catLabels: Record<string, string> = {
    tool_calling: "Tool Calling",
    code_generation: "Code Generation",
    instruction_following: "Instruction Following",
    context_handling: "Context Handling",
    safety: "Safety",
  };

  for (const [key, cat] of Object.entries(result.categories)) {
    const label = catLabels[key] ?? key;
    const pct = cat.maxScore > 0 ? Math.round((cat.score / cat.maxScore) * 100) : 0;
    const bar = "#".repeat(Math.round(pct / 5)) + ".".repeat(20 - Math.round(pct / 5));
    lines.push(`  ${label.padEnd(24)} ${cat.score}/${cat.maxScore}  [${bar}] ${pct}%`);
  }

  lines.push("");
  lines.push("  Detailed Results");
  lines.push("  " + "-".repeat(56));

  for (const r of result.detailedResults) {
    const icon = r.passed ? "[+]" : "[-]";
    const status = r.passed ? "PASS" : "FAIL";
    lines.push(`  ${icon} ${status} ${r.taskId.padEnd(35)} ${r.score}/${r.maxScore}  ${r.timeMs}ms`);
    if (r.error) {
      lines.push(`         Error: ${r.error.slice(0, 100)}`);
    }
  }

  lines.push("");
  lines.push("  " + "=".repeat(56));
  lines.push(`  Certification Level: ${badge[result.level]}`);
  lines.push("  Thresholds: Gold 45+, Silver 35+, Bronze 25+, Failed <25");
  lines.push("");

  return lines.join("\n");
}
