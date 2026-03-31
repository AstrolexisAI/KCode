// KCode - Model Evaluator for Model Distillation
// Evaluates distilled (fine-tuned) models against base models using benchmark tasks.

import { log } from "../logger";
import type {
  EvalConfig,
  EvalTask,
  EvalTaskResult,
  EvalReport,
} from "./types";

// ─── Defaults ──────────────────────────────────────────────────

const DEFAULT_NUM_PROMPTS = 50;
const DEFAULT_API_BASE = "http://localhost:10091";
const REQUEST_TIMEOUT_MS = 60_000;

// ─── Built-in Benchmark Tasks ──────────────────────────────────

const CODING_TASKS: EvalTask[] = [
  {
    id: "code-1",
    prompt: "Write a TypeScript function that reverses a string without using .reverse().",
    expectedPattern: "function|const|=>",
    category: "code-generation",
  },
  {
    id: "code-2",
    prompt: "Fix this code: `const x = [1,2,3]; x.forEach(i => { if (i > 1) x.splice(i, 1); });`",
    expectedPattern: "filter|splice|mutation|bug|modif",
    category: "bug-fix",
  },
  {
    id: "code-3",
    prompt: "Explain what a closure is in JavaScript with an example.",
    expectedPattern: "scope|function|variable|outer|inner",
    category: "explanation",
  },
  {
    id: "code-4",
    prompt: "Write a bash one-liner to find all .ts files modified in the last 24 hours.",
    expectedPattern: "find|mtime|\\-name",
    category: "shell",
  },
  {
    id: "code-5",
    prompt: "Refactor this function to use early returns:\n```\nfunction process(x) { if (x) { if (x.valid) { return x.value; } else { return null; } } else { return null; } }```",
    expectedPattern: "return|if|guard",
    category: "refactor",
  },
  {
    id: "code-6",
    prompt: "Write a SQL query to find the top 5 users by total order amount.",
    expectedPattern: "SELECT|JOIN|ORDER BY|LIMIT|GROUP BY|SUM",
    category: "sql",
  },
  {
    id: "code-7",
    prompt: "What does this regex match? `/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$/`",
    expectedPattern: "email|address|valid",
    category: "explanation",
  },
  {
    id: "code-8",
    prompt: "Write a TypeScript generic function that takes an array and returns the last element with proper typing.",
    expectedPattern: "function|<T>|T\\[\\]|generic|last",
    category: "code-generation",
  },
  {
    id: "code-9",
    prompt: "Convert this callback-based function to use async/await:\n```\nfunction readFile(path, cb) { fs.readFile(path, 'utf8', (err, data) => { if (err) cb(err); else cb(null, data); }); }```",
    expectedPattern: "async|await|promise|readFile",
    category: "refactor",
  },
  {
    id: "code-10",
    prompt: "Write a git command to squash the last 3 commits into one.",
    expectedPattern: "rebase|squash|reset|HEAD~3",
    category: "git",
  },
];

const GENERAL_TASKS: EvalTask[] = [
  {
    id: "gen-1",
    prompt: "What is the difference between a process and a thread?",
    expectedPattern: "memory|shared|concurrent|execution",
    category: "systems",
  },
  {
    id: "gen-2",
    prompt: "Explain the CAP theorem in distributed systems.",
    expectedPattern: "consistency|availability|partition|tolerance",
    category: "distributed",
  },
  {
    id: "gen-3",
    prompt: "What is the time complexity of binary search and why?",
    expectedPattern: "O\\(log|logarithmic|divide|half",
    category: "algorithms",
  },
  {
    id: "gen-4",
    prompt: "Explain the difference between REST and GraphQL.",
    expectedPattern: "endpoint|query|schema|over-fetch|under-fetch",
    category: "api-design",
  },
  {
    id: "gen-5",
    prompt: "What is dependency injection and why is it useful?",
    expectedPattern: "inject|decouple|test|interface|loose|coupling",
    category: "design-patterns",
  },
];

const TOOL_USE_TASKS: EvalTask[] = [
  {
    id: "tool-1",
    prompt: "Read the file at src/index.ts and tell me what framework it uses.",
    expectedPattern: "read|file|import|framework",
    category: "tool-read",
  },
  {
    id: "tool-2",
    prompt: "Search the codebase for all uses of 'async function'.",
    expectedPattern: "grep|search|find|async",
    category: "tool-search",
  },
  {
    id: "tool-3",
    prompt: "Create a new file called hello.ts that exports a greeting function.",
    expectedPattern: "write|create|export|function|hello",
    category: "tool-write",
  },
  {
    id: "tool-4",
    prompt: "Run the test suite and report the results.",
    expectedPattern: "bash|test|run|bun",
    category: "tool-bash",
  },
  {
    id: "tool-5",
    prompt: "Find all TypeScript files in the src directory.",
    expectedPattern: "glob|find|\\*\\.ts|src",
    category: "tool-glob",
  },
];

// ─── ModelEvaluator ────────────────────────────────────────────

export class ModelEvaluator {
  /**
   * Build a complete EvalConfig with defaults applied.
   */
  static defaults(partial?: Partial<EvalConfig>): EvalConfig {
    return {
      modelPath: partial?.modelPath ?? "",
      baseModelPath: partial?.baseModelPath,
      benchmark: partial?.benchmark ?? "coding-tasks",
      numPrompts: partial?.numPrompts ?? DEFAULT_NUM_PROMPTS,
      apiBase: partial?.apiBase ?? DEFAULT_API_BASE,
    };
  }

  /**
   * Get benchmark tasks for a given category.
   */
  getTasks(benchmark: string, limit: number): EvalTask[] {
    let tasks: EvalTask[];
    switch (benchmark) {
      case "coding-tasks":
        tasks = CODING_TASKS;
        break;
      case "general":
        tasks = GENERAL_TASKS;
        break;
      case "tool-use":
        tasks = TOOL_USE_TASKS;
        break;
      default:
        tasks = CODING_TASKS;
    }
    return tasks.slice(0, limit);
  }

  /**
   * Run a full evaluation: send each task prompt to the model and check the response.
   */
  async evaluate(config: EvalConfig): Promise<EvalReport> {
    const tasks = this.getTasks(config.benchmark, config.numPrompts);
    const results: EvalTaskResult[] = [];

    log.info(
      "distill",
      `Evaluating model ${config.modelPath} on ${tasks.length} ${config.benchmark} tasks`,
    );

    for (const task of tasks) {
      const result = await this.evaluateTask(task, config);
      results.push(result);
    }

    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    const avgLatencyMs =
      results.length > 0
        ? Math.round(
            results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length,
          )
        : 0;
    const avgTokens =
      results.length > 0
        ? Math.round(
            results.reduce((sum, r) => sum + r.tokensUsed, 0) / results.length,
          )
        : 0;
    const passRate =
      results.length > 0
        ? Math.round((passed / results.length) * 100) / 100
        : 0;

    const report: EvalReport = {
      modelPath: config.modelPath,
      benchmark: config.benchmark,
      totalTasks: tasks.length,
      passed,
      failed,
      avgLatencyMs,
      avgTokens,
      passRate,
      taskResults: results,
    };

    log.info(
      "distill",
      `Evaluation complete: ${passed}/${tasks.length} passed (${Math.round(passRate * 100)}%)`,
    );

    return report;
  }

  /**
   * Evaluate a single task by sending it to the model API.
   */
  async evaluateTask(
    task: EvalTask,
    config: EvalConfig,
  ): Promise<EvalTaskResult> {
    const start = Date.now();

    try {
      const response = await this.queryModel(task.prompt, config);
      const latencyMs = Date.now() - start;

      // Check if the response matches the expected pattern
      const passed = task.expectedPattern
        ? new RegExp(task.expectedPattern, "i").test(response.text)
        : response.text.length > 10;

      return {
        taskId: task.id,
        passed,
        responseLength: response.text.length,
        latencyMs,
        tokensUsed: response.tokensUsed,
      };
    } catch (err) {
      log.error("distill", `Eval task ${task.id} failed: ${err}`);
      return {
        taskId: task.id,
        passed: false,
        responseLength: 0,
        latencyMs: Date.now() - start,
        tokensUsed: 0,
      };
    }
  }

  /**
   * Send a prompt to the model API and return the response.
   */
  async queryModel(
    prompt: string,
    config: EvalConfig,
  ): Promise<{ text: string; tokensUsed: number }> {
    const apiBase = config.apiBase ?? DEFAULT_API_BASE;

    const resp = await fetch(`${apiBase}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.modelPath,
        messages: [
          {
            role: "system",
            content: "You are KCode, an AI coding assistant.",
          },
          { role: "user", content: prompt },
        ],
        max_tokens: 1024,
        temperature: 0.0,
        stream: false,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!resp.ok) {
      throw new Error(`API returned ${resp.status}: ${await resp.text()}`);
    }

    const data = (await resp.json()) as Record<string, unknown>;
    const choices = data.choices as Record<string, unknown>[] | undefined;
    const usage = data.usage as Record<string, unknown> | undefined;
    const text = String(
      (choices?.[0]?.message as Record<string, unknown> | undefined)
        ?.content ?? "",
    );
    const tokensUsed = Number(usage?.total_tokens ?? 0);

    return { text, tokensUsed };
  }

  /**
   * Compare two evaluation reports and return a summary.
   */
  compareReports(
    distilled: EvalReport,
    base: EvalReport,
  ): {
    passRateDelta: number;
    latencyDelta: number;
    tokensDelta: number;
    improved: boolean;
    summary: string;
  } {
    const passRateDelta = distilled.passRate - base.passRate;
    const latencyDelta = distilled.avgLatencyMs - base.avgLatencyMs;
    const tokensDelta = distilled.avgTokens - base.avgTokens;
    const improved = passRateDelta >= 0 && latencyDelta <= 0;

    const summary = [
      `Pass rate: ${Math.round(base.passRate * 100)}% -> ${Math.round(distilled.passRate * 100)}% (${passRateDelta >= 0 ? "+" : ""}${Math.round(passRateDelta * 100)}%)`,
      `Avg latency: ${base.avgLatencyMs}ms -> ${distilled.avgLatencyMs}ms (${latencyDelta >= 0 ? "+" : ""}${latencyDelta}ms)`,
      `Avg tokens: ${base.avgTokens} -> ${distilled.avgTokens} (${tokensDelta >= 0 ? "+" : ""}${tokensDelta})`,
      improved
        ? "Result: Distilled model is an improvement."
        : "Result: Distilled model did not clearly improve over base.",
    ].join("\n");

    return { passRateDelta, latencyDelta, tokensDelta, improved, summary };
  }
}
