// KCode - Benchmark Suite
// Measures model performance on coding tasks: correctness, speed, token usage.

// ─── Types ──────────────────────────────────────────────────────

export interface BenchmarkTask {
  id: string;
  name: string;
  category: "coding" | "tools" | "context" | "speed";
  prompt: string;
  expectedBehavior: string;
  maxTimeMs: number;
}

export interface BenchmarkResult {
  taskId: string;
  passed: boolean;
  timeMs: number;
  tokensUsed: number;
  firstTokenMs: number;
  error?: string;
}

export interface BenchmarkConfig {
  model: string;
  apiBase: string;
  apiKey?: string;
  maxConcurrency?: number;
}

// ─── Runner ────────────────────────────────────────────────────

/**
 * Run a single benchmark task against a model endpoint.
 */
export async function runBenchmark(
  task: BenchmarkTask,
  config: BenchmarkConfig,
): Promise<BenchmarkResult> {
  const start = Date.now();
  let firstTokenMs = 0;
  let tokensUsed = 0;
  let responseText = "";

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.apiKey) {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    const body = JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "system",
          content:
            "You are a coding assistant. Respond with code and brief explanations. Be concise.",
        },
        { role: "user", content: task.prompt },
      ],
      max_tokens: 2048,
      stream: true,
    });

    const apiUrl = config.apiBase.replace(/\/+$/, "") + "/v1/chat/completions";
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
        passed: false,
        timeMs: Date.now() - start,
        tokensUsed: 0,
        firstTokenMs: 0,
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
            if (content && firstTokenMs === 0) {
              firstTokenMs = Date.now() - start;
            }
            responseText += content;
            tokensUsed += 1; // approximate token count from chunks
          } catch {
            // skip malformed chunks
          }
        }
      }
    }

    const timeMs = Date.now() - start;
    const passed = validateResponse(responseText, task);

    return {
      taskId: task.id,
      passed,
      timeMs,
      tokensUsed,
      firstTokenMs,
    };
  } catch (err) {
    return {
      taskId: task.id,
      passed: false,
      timeMs: Date.now() - start,
      tokensUsed,
      firstTokenMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Validate that a response meets the expected behavior criteria.
 */
function validateResponse(response: string, task: BenchmarkTask): boolean {
  if (!response || response.trim().length === 0) return false;

  const lower = response.toLowerCase();
  const expected = task.expectedBehavior.toLowerCase();

  // Check if the response contains key indicators from expected behavior
  const keywords = expected
    .split(/[,;|]/)
    .map((k) => k.trim())
    .filter(Boolean);

  if (keywords.length === 0) return response.trim().length > 10;

  // At least half of the expected keywords should be present
  const matches = keywords.filter((kw) => lower.includes(kw));
  return matches.length >= Math.ceil(keywords.length / 2);
}

// ─── Report ────────────────────────────────────────────────────

/**
 * Format benchmark results into a readable report.
 */
export function formatBenchmarkReport(results: BenchmarkResult[]): string {
  const lines: string[] = [];

  lines.push("  KCode Benchmark Report");
  lines.push("  " + "=".repeat(50));
  lines.push("");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const avgTime = results.length > 0
    ? Math.round(results.reduce((s, r) => s + r.timeMs, 0) / results.length)
    : 0;
  const avgFirstToken = results.filter((r) => r.firstTokenMs > 0).length > 0
    ? Math.round(
        results.filter((r) => r.firstTokenMs > 0).reduce((s, r) => s + r.firstTokenMs, 0) /
          results.filter((r) => r.firstTokenMs > 0).length,
      )
    : 0;

  lines.push(`  Results: ${passed} passed, ${failed} failed (${results.length} total)`);
  lines.push(`  Avg time: ${avgTime}ms | Avg first token: ${avgFirstToken}ms`);
  lines.push("");
  lines.push("  " + "-".repeat(50));

  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    const icon = r.passed ? "[+]" : "[-]";
    lines.push(
      `  ${icon} ${status} ${r.taskId} -- ${r.timeMs}ms, ${r.tokensUsed} tokens, TTFT ${r.firstTokenMs}ms`,
    );
    if (r.error) {
      lines.push(`      Error: ${r.error.slice(0, 120)}`);
    }
  }

  lines.push("");
  lines.push("  " + "-".repeat(50));
  lines.push(`  Total tokens: ${results.reduce((s, r) => s + r.tokensUsed, 0)}`);

  return lines.join("\n");
}
