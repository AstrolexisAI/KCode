// KCode - Model benchmark runner
//
// Runs a fixed 4-test suite against a cloud model and scores the response.
// Each test has a deterministic pass/fail check so results are comparable
// across runs and models. Tests are intentionally small (~200 tokens in,
// ~100 tokens out) so a full 60-model run costs ~$0.024 total.
//
// Tests:
//   T1 (response):  "Say: hello" — basic responsiveness
//   T2 (tool_use):  "read /tmp/X" — does it emit tool_use blocks natively?
//   T3 (reasoning): "17 × 23 = ?" — basic arithmetic without hallucination
//   T4 (code):      fix an off-by-one — code understanding
//
// Tags inferred from results:
//   - "fast" if elapsed < 3s total
//   - "reasoning" if T3 passes
//   - "coding" if T4 passes
//   - "tool-use" if T2 passes (NOT a hallucinator)

import { log } from "./logger";
import type { BenchmarkResult } from "./benchmark-store";
import { recordBenchmarkResult, BENCHMARK_SUITE_VERSION } from "./benchmark-store";

interface TestDefinition {
  id: string;
  description: string;
  systemPrompt: string;
  userPrompt: string;
  expectedTag: string; // tag to confirm on pass
  /** Check pass/fail: receives text content and any tool_calls */
  check: (text: string, toolCalls: unknown[]) => boolean;
}

const TESTS: TestDefinition[] = [
  {
    id: "T1_response",
    description: "basic responsiveness",
    systemPrompt: "You are a test subject. Respond concisely.",
    userPrompt: "Reply with exactly one word: hello",
    expectedTag: "responsive",
    check: (text) => /\bhello\b/i.test(text),
  },
  {
    id: "T2_tool_use",
    description: "native tool_use emission (non-hallucination)",
    systemPrompt:
      "You have access to a Read tool. Use it to read the requested file. Return only via the native tool_calls API.",
    userPrompt: "Use the Read tool to read the file /tmp/kcode_benchmark_test.txt",
    expectedTag: "tool-use",
    check: (_text, toolCalls) =>
      toolCalls.length > 0 &&
      (toolCalls as Array<Record<string, unknown>>).some((tc) => {
        const name =
          (tc as { name?: string }).name ??
          ((tc as { function?: { name?: string } }).function?.name);
        return typeof name === "string" && name.toLowerCase() === "read";
      }),
  },
  {
    id: "T3_reasoning",
    description: "basic arithmetic reasoning",
    systemPrompt: "You are a test subject. Answer precisely.",
    userPrompt: "What is 17 times 23? Reply with only the number, no explanation.",
    expectedTag: "reasoning",
    check: (text) => /\b391\b/.test(text),
  },
  {
    id: "T4_code",
    description: "code understanding (off-by-one fix)",
    systemPrompt: "You are a code reviewer. Reply with only the corrected line of code.",
    userPrompt:
      "This function is supposed to add two numbers but has a bug. Reply with only the corrected 'return' line:\n\nfunction add(a, b) {\n  return a + b + 1;\n}",
    expectedTag: "coding",
    check: (text) => /return\s+a\s*\+\s*b\s*;?/.test(text) && !/b\s*\+\s*1/.test(text),
  },
];

const FAST_THRESHOLD_MS = 3_000;

/**
 * Run the full benchmark suite against a single cloud model.
 * Returns the BenchmarkResult and stores it in ~/.kcode/benchmarks.json.
 */
export async function benchmarkModel(
  modelName: string,
  baseUrl: string,
  apiKey: string,
  tools: Array<Record<string, unknown>>,
): Promise<BenchmarkResult> {
  const start = Date.now();
  const results: Record<string, "pass" | "fail" | "error"> = {};
  const confirmedTags = new Set<string>();
  let totalTokens = 0;

  for (const test of TESTS) {
    try {
      const r = await runSingleTest(test, modelName, baseUrl, apiKey, tools);
      results[test.id] = r.passed ? "pass" : "fail";
      if (r.passed) confirmedTags.add(test.expectedTag);
      totalTokens += r.tokens;
    } catch (err) {
      log.debug("benchmark", `${modelName} ${test.id} errored: ${err}`);
      results[test.id] = "error";
    }
  }

  const elapsedMs = Date.now() - start;
  const score = Object.values(results).filter((r) => r === "pass").length;

  // Infer speed tag from average per-test time
  const avgMs = elapsedMs / TESTS.length;
  if (avgMs < FAST_THRESHOLD_MS) confirmedTags.add("fast");

  const result: BenchmarkResult = {
    model: modelName,
    timestamp: new Date().toISOString(),
    tests: results,
    score,
    confirmedTags: [...confirmedTags],
    totalTokens,
    elapsedMs,
  };

  log.info(
    "benchmark",
    `${modelName}: ${score}/${TESTS.length} (${(elapsedMs / 1000).toFixed(1)}s, ${totalTokens} tok, tags: ${confirmedTags.size})`,
  );
  await recordBenchmarkResult(result);
  return result;
}

interface SingleTestResult {
  passed: boolean;
  tokens: number;
}

async function runSingleTest(
  test: TestDefinition,
  modelName: string,
  baseUrl: string,
  apiKey: string,
  tools: Array<Record<string, unknown>>,
): Promise<SingleTestResult> {
  const url = baseUrl.toLowerCase();
  const isAnthropic = url.includes("anthropic.com");
  const endpoint = isAnthropic
    ? `${baseUrl}/v1/messages`
    : `${baseUrl}/v1/chat/completions`;

  const includeTools = test.id === "T2_tool_use" && tools.length > 0;

  const body = isAnthropic
    ? {
        model: modelName,
        max_tokens: 200,
        system: test.systemPrompt,
        messages: [{ role: "user", content: test.userPrompt }],
        ...(includeTools ? { tools } : {}),
      }
    : {
        model: modelName,
        max_tokens: 200,
        temperature: 0,
        messages: [
          { role: "system", content: test.systemPrompt },
          { role: "user", content: test.userPrompt },
        ],
        ...(includeTools ? { tools: tools as unknown } : {}),
      };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (isAnthropic) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const json = (await res.json()) as Record<string, unknown>;

  let text = "";
  let toolCalls: unknown[] = [];
  let tokens = 0;

  if (isAnthropic) {
    const content = json.content as Array<Record<string, unknown>> | undefined;
    text = (content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b as { text?: string }).text ?? "")
      .join("");
    toolCalls = (content ?? []).filter((b) => b.type === "tool_use");
    const usage = json.usage as Record<string, number> | undefined;
    tokens = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
  } else {
    const choices = json.choices as Array<Record<string, unknown>> | undefined;
    const msg = choices?.[0]?.message as Record<string, unknown> | undefined;
    text = (msg?.content as string) ?? "";
    toolCalls = (msg?.tool_calls as unknown[]) ?? [];
    const usage = json.usage as Record<string, number> | undefined;
    tokens = (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
  }

  return {
    passed: test.check(text, toolCalls),
    tokens,
  };
}

/**
 * Minimal Read tool definition used for T2 (tool_use test).
 * Kept minimal so the test measures the model's willingness to use the
 * native tool_calls API, not its understanding of complex tool schemas.
 */
export function minimalReadTool(provider: "openai" | "anthropic"): Record<string, unknown> {
  if (provider === "anthropic") {
    return {
      name: "Read",
      description: "Read a file from the filesystem.",
      input_schema: {
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
      },
    };
  }
  return {
    type: "function",
    function: {
      name: "Read",
      description: "Read a file from the filesystem.",
      parameters: {
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
      },
    },
  };
}

/** Run the suite version that the runner knows about. */
export const SUITE_VERSION = BENCHMARK_SUITE_VERSION;
