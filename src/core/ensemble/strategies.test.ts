// KCode - Ensemble Strategies Tests

import { describe, expect, test } from "bun:test";
import {
  bestOfN,
  executeStrategy,
  majorityVoteStrategy,
  mergeStrategy,
  specializeStrategy,
  verifyStrategy,
} from "./strategies";
import type { EnsembleConfig, ModelExecutor, SpecializeConfig } from "./types";

// ─── Helpers ────────────────────────────────────────────────────

function makeConfig(overrides: Partial<EnsembleConfig> = {}): EnsembleConfig {
  return {
    strategy: "best-of-n",
    models: ["model-a", "model-b", "model-c"],
    maxParallel: 3,
    timeout: 5000,
    minResponses: 2,
    triggerOn: "always",
    ...overrides,
  };
}

function makeMockExecutor(responses: Record<string, string> = {}): ModelExecutor {
  const defaults: Record<string, string> = {
    "model-a": "Response from model A with some details.",
    "model-b":
      "Response from model B is longer and has more comprehensive information and examples.",
    "model-c": "Response from model C.",
    "judge-model": "2", // Selects response 2
    "verifier-model": "APPROVED The response is correct.",
    ...responses,
  };

  return {
    execute: async (model, _messages, _maxTokens) => {
      const content = defaults[model] ?? `Default response from ${model}`;
      return {
        content,
        tokensUsed: content.length,
        durationMs: 100,
      };
    },
  };
}

function makeSlowExecutor(slowModel: string, delayMs: number): ModelExecutor {
  return {
    execute: async (model) => {
      if (model === slowModel) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return {
        content: `Response from ${model}`,
        tokensUsed: 20,
        durationMs: model === slowModel ? delayMs : 50,
      };
    },
  };
}

function makeFailingExecutor(failingModels: string[]): ModelExecutor {
  return {
    execute: async (model) => {
      if (failingModels.includes(model)) {
        throw new Error(`${model} failed`);
      }
      return {
        content: `Response from ${model}`,
        tokensUsed: 20,
        durationMs: 50,
      };
    },
  };
}

const testQuery = [{ role: "user" as const, content: "What is TypeScript?" }];

// ─── bestOfN ────────────────────────────────────────────────────

describe("bestOfN", () => {
  test("selects the best response without a judge", async () => {
    const config = makeConfig();
    const executor = makeMockExecutor();

    const result = await bestOfN(testQuery, config, executor);
    expect(result.strategy).toBe("best-of-n");
    expect(result.candidates.length).toBe(3);
    expect(result.finalResponse.length).toBeGreaterThan(0);
  });

  test("uses judge model when configured", async () => {
    const config = makeConfig({ judgeModel: "judge-model" });
    const executor = makeMockExecutor();

    const result = await bestOfN(testQuery, config, executor);
    expect(result.strategy).toBe("best-of-n");
    // Judge selects response "2" → model-b
    expect(result.finalResponse).toContain("model B");
  });

  test("throws when fewer than minResponses succeed", async () => {
    const config = makeConfig({ minResponses: 3 });
    const executor = makeFailingExecutor(["model-a", "model-b"]);

    await expect(bestOfN(testQuery, config, executor)).rejects.toThrow(
      /Only 1\/3 models responded/,
    );
  });

  test("succeeds when enough models respond despite some failures", async () => {
    const config = makeConfig({ minResponses: 2 });
    const executor = makeFailingExecutor(["model-c"]);

    const result = await bestOfN(testQuery, config, executor);
    expect(result.candidates.length).toBe(2);
  });
});

// ─── majorityVoteStrategy ───────────────────────────────────────

describe("majorityVoteStrategy", () => {
  test("selects the majority response", async () => {
    const config = makeConfig({ models: ["a", "b", "c"] });
    const executor: ModelExecutor = {
      execute: async (model) => ({
        content: model === "c" ? "no" : "yes",
        tokensUsed: 3,
        durationMs: 50,
      }),
    };

    const result = await majorityVoteStrategy(testQuery, config, executor);
    expect(result.strategy).toBe("majority-vote");
    expect(result.finalResponse).toBe("yes");
  });

  test("throws when fewer than minResponses succeed", async () => {
    const config = makeConfig({ models: ["a", "b"], minResponses: 2 });
    const executor = makeFailingExecutor(["a", "b"]);

    await expect(majorityVoteStrategy(testQuery, config, executor)).rejects.toThrow(
      /Only 0\/2 models responded/,
    );
  });
});

// ─── mergeStrategy ──────────────────────────────────────────────

describe("mergeStrategy", () => {
  test("merges responses without judge", async () => {
    const config = makeConfig();
    const executor = makeMockExecutor();

    const result = await mergeStrategy(testQuery, config, executor);
    expect(result.strategy).toBe("merge");
    expect(result.finalResponse.length).toBeGreaterThan(0);
  });

  test("uses LLM merge when judge model is set", async () => {
    const config = makeConfig({ judgeModel: "judge-model" });
    const executor = makeMockExecutor({
      "judge-model": "Here is the merged comprehensive answer.",
    });

    const result = await mergeStrategy(testQuery, config, executor);
    expect(result.strategy).toBe("merge");
    expect(result.finalResponse).toContain("merged comprehensive");
  });
});

// ─── verifyStrategy ─────────────────────────────────────────────

describe("verifyStrategy", () => {
  test("returns original when verifier approves", async () => {
    const config = makeConfig({ models: ["generator", "verifier"] });
    const executor: ModelExecutor = {
      execute: async (model) => {
        if (model === "generator") {
          return { content: "Generated answer.", tokensUsed: 10, durationMs: 100 };
        }
        return { content: "APPROVED Generated answer.", tokensUsed: 10, durationMs: 100 };
      },
    };

    const result = await verifyStrategy(testQuery, config, executor);
    expect(result.strategy).toBe("verify");
    expect(result.finalResponse).toBe("Generated answer.");
    expect(result.reasoning).toContain("approved");
  });

  test("returns corrected version when verifier corrects", async () => {
    const config = makeConfig({ models: ["generator", "verifier"] });
    const executor: ModelExecutor = {
      execute: async (model) => {
        if (model === "generator") {
          return { content: "Wrong answer.", tokensUsed: 10, durationMs: 100 };
        }
        return { content: "CORRECTED Right answer.", tokensUsed: 15, durationMs: 150 };
      },
    };

    const result = await verifyStrategy(testQuery, config, executor);
    expect(result.strategy).toBe("verify");
    expect(result.finalResponse).toBe("Right answer.");
    expect(result.reasoning).toContain("corrected");
  });

  test("throws when fewer than 2 models configured", async () => {
    const config = makeConfig({ models: ["only-one"] });
    const executor = makeMockExecutor();

    await expect(verifyStrategy(testQuery, config, executor)).rejects.toThrow(/at least 2 models/);
  });

  test("includes both candidates in result", async () => {
    const config = makeConfig({ models: ["gen", "ver"] });
    const executor: ModelExecutor = {
      execute: async (model) => ({
        content: model === "gen" ? "Answer" : "APPROVED Answer",
        tokensUsed: 5,
        durationMs: 50,
      }),
    };

    const result = await verifyStrategy(testQuery, config, executor);
    expect(result.candidates.length).toBe(2);
    expect(result.candidates[0]!.model).toBe("gen");
    expect(result.candidates[1]!.model).toBe("ver");
  });
});

// ─── specializeStrategy ─────────────────────────────────────────

describe("specializeStrategy", () => {
  test("routes to specialized model for code tasks", async () => {
    const config: SpecializeConfig = {
      ...makeConfig(),
      strategy: "specialize",
      specializations: {
        coder: { model: "code-model", tasks: ["code"] },
        thinker: { model: "reason-model", tasks: ["reasoning"] },
      },
    };

    const executor: ModelExecutor = {
      execute: async (model) => ({
        content: `Specialized response from ${model}`,
        tokensUsed: 20,
        durationMs: 100,
      }),
    };

    // "implement a function" is classified as "code"
    const query = [{ role: "user" as const, content: "implement a function to sort an array" }];
    const result = await specializeStrategy(query, config, executor);

    expect(result.strategy).toBe("specialize");
    expect(result.finalResponse).toContain("code-model");
    expect(result.reasoning).toContain("code");
  });

  test("falls back to best-of-n when no specialization matches", async () => {
    const config: SpecializeConfig = {
      ...makeConfig(),
      strategy: "specialize",
      specializations: {
        coder: { model: "code-model", tasks: ["code"] },
      },
    };

    const executor = makeMockExecutor();

    // "hello" is classified as "general" which has no specialization
    const query = [{ role: "user" as const, content: "hello how are you" }];
    const result = await specializeStrategy(query, config, executor);

    // Falls back to best-of-n
    expect(result.strategy).toBe("best-of-n");
  });
});

// ─── executeStrategy ────────────────────────────────────────────

describe("executeStrategy", () => {
  test("dispatches to best-of-n strategy", async () => {
    const config = makeConfig({ strategy: "best-of-n" });
    const executor = makeMockExecutor();
    const result = await executeStrategy(testQuery, config, executor);
    expect(result.strategy).toBe("best-of-n");
  });

  test("dispatches to majority-vote strategy", async () => {
    const config = makeConfig({ strategy: "majority-vote" });
    const executor = makeMockExecutor();
    const result = await executeStrategy(testQuery, config, executor);
    expect(result.strategy).toBe("majority-vote");
  });

  test("dispatches to merge strategy", async () => {
    const config = makeConfig({ strategy: "merge" });
    const executor = makeMockExecutor();
    const result = await executeStrategy(testQuery, config, executor);
    expect(result.strategy).toBe("merge");
  });

  test("dispatches to verify strategy", async () => {
    const config = makeConfig({ strategy: "verify", models: ["gen", "ver"] });
    const executor: ModelExecutor = {
      execute: async (model) => ({
        content: model === "gen" ? "Answer" : "APPROVED Answer",
        tokensUsed: 5,
        durationMs: 50,
      }),
    };
    const result = await executeStrategy(testQuery, config, executor);
    expect(result.strategy).toBe("verify");
  });

  test("throws for unknown strategy", async () => {
    const config = makeConfig({ strategy: "unknown" as any });
    const executor = makeMockExecutor();
    await expect(executeStrategy(testQuery, config, executor)).rejects.toThrow(
      /Unknown ensemble strategy/,
    );
  });
});

// ─── Timeout handling ───────────────────────────────────────────

describe("timeout handling", () => {
  test("handles slow models without blocking fast ones", async () => {
    const config = makeConfig({
      models: ["fast-a", "fast-b", "slow-c"],
      timeout: 200,
      minResponses: 2,
    });

    const executor: ModelExecutor = {
      execute: async (model) => {
        if (model === "slow-c") {
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        return {
          content: `Response from ${model}`,
          tokensUsed: 10,
          durationMs: model === "slow-c" ? 5000 : 50,
        };
      },
    };

    const result = await bestOfN(testQuery, config, executor);
    // Should succeed with 2 fast models, slow one times out
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    expect(result.candidates.every((c) => c.model !== "slow-c")).toBe(true);
  }, 10_000);
});
