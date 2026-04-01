import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { estimateToolDefinitionTokens, resolveApiKey } from "./request-builder.ts";
import type { KCodeConfig } from "./types.ts";

// ─── resolveApiKey ─────────────────────────────────────────────

describe("resolveApiKey", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.TOGETHER_API_KEY;
  });

  afterEach(() => {
    // Restore env
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
  });

  const baseConfig: KCodeConfig = {
    model: "test",
    apiBase: "http://localhost:10091",
    apiKey: "fallback-key",
    maxTokens: 4096,
  } as KCodeConfig;

  test("GPT model resolves OPENAI_API_KEY", () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    expect(resolveApiKey("gpt-4", "http://example.com", baseConfig)).toBe("sk-openai-test");
  });

  test("o1 model resolves OPENAI_API_KEY", () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    expect(resolveApiKey("o1-preview", "http://example.com", baseConfig)).toBe("sk-openai-test");
  });

  test("o3 model resolves OPENAI_API_KEY", () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    expect(resolveApiKey("o3-mini", "http://example.com", baseConfig)).toBe("sk-openai-test");
  });

  test("Gemini model resolves GEMINI_API_KEY", () => {
    process.env.GEMINI_API_KEY = "gemini-key";
    expect(resolveApiKey("gemini-pro", "http://example.com", baseConfig)).toBe("gemini-key");
  });

  test("URL with groq.com resolves GROQ_API_KEY", () => {
    process.env.GROQ_API_KEY = "groq-key";
    expect(resolveApiKey("llama-3", "https://api.groq.com/v1", baseConfig)).toBe("groq-key");
  });

  test("DeepSeek model resolves DEEPSEEK_API_KEY", () => {
    process.env.DEEPSEEK_API_KEY = "deepseek-key";
    expect(resolveApiKey("deepseek-coder", "http://example.com", baseConfig)).toBe("deepseek-key");
  });

  test("URL with together.xyz resolves TOGETHER_API_KEY", () => {
    process.env.TOGETHER_API_KEY = "together-key";
    expect(resolveApiKey("llama-3", "https://api.together.xyz/v1", baseConfig)).toBe(
      "together-key",
    );
  });

  test("unknown model falls back to config.apiKey", () => {
    expect(resolveApiKey("custom-model", "http://localhost:10091", baseConfig)).toBe(
      "fallback-key",
    );
  });

  test("no env var + no config key returns undefined", () => {
    const noKeyConfig = { ...baseConfig, apiKey: undefined } as KCodeConfig;
    expect(resolveApiKey("custom-model", "http://localhost:10091", noKeyConfig)).toBeUndefined();
  });
});

// ─── estimateToolDefinitionTokens ──────────────────────────────

describe("estimateToolDefinitionTokens", () => {
  // Minimal mock ToolRegistry
  function createMockRegistry(
    defs: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
  ) {
    return {
      getDefinitions: () => defs,
    } as any;
  }

  test("empty registry returns 0", () => {
    const registry = createMockRegistry([]);
    expect(estimateToolDefinitionTokens(registry)).toBe(0);
  });

  test("single simple tool returns reasonable estimate", () => {
    const registry = createMockRegistry([
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
    const tokens = estimateToolDefinitionTokens(registry);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(200); // A simple tool shouldn't be huge
  });

  test("with profile filter, only counts filtered tools", () => {
    const registry = createMockRegistry([
      { name: "Read", description: "Read a file", input_schema: { type: "object" } },
      { name: "Write", description: "Write a file", input_schema: { type: "object" } },
      { name: "Bash", description: "Run bash command", input_schema: { type: "object" } },
    ]);
    const allTokens = estimateToolDefinitionTokens(registry);
    const filteredTokens = estimateToolDefinitionTokens(registry, (name) => name === "Read");
    expect(filteredTokens).toBeLessThan(allTokens);
    expect(filteredTokens).toBeGreaterThan(0);
  });

  test("tools with complex schemas produce larger estimates", () => {
    const simpleRegistry = createMockRegistry([
      { name: "Simple", description: "Simple tool", input_schema: { type: "object" } },
    ]);
    const complexRegistry = createMockRegistry([
      {
        name: "Complex",
        description: "Complex tool with many parameters",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "The file path to read" },
            encoding: { type: "string", enum: ["utf-8", "ascii", "base64"] },
            offset: { type: "number", description: "Line offset to start reading from" },
            limit: { type: "number", description: "Maximum number of lines" },
          },
          required: ["path"],
        },
      },
    ]);
    expect(estimateToolDefinitionTokens(complexRegistry)).toBeGreaterThan(
      estimateToolDefinitionTokens(simpleRegistry),
    );
  });

  test("estimate is roughly proportional to JSON size / 3.5", () => {
    const defs = [
      {
        name: "TestTool",
        description: "A test tool for estimation",
        input_schema: { type: "object", properties: { a: { type: "string" } } },
      },
    ];
    const registry = createMockRegistry(defs);
    const tokens = estimateToolDefinitionTokens(registry);

    // Manual calculation: name(8) + description(29) + JSON(~50) + overhead(50) ≈ 137 chars / 3.5 ≈ 39 tokens
    const expectedChars =
      defs[0]!.name.length +
      defs[0]!.description.length +
      JSON.stringify(defs[0]!.input_schema).length +
      50;
    const expectedTokens = Math.ceil(expectedChars / 3.5);
    expect(tokens).toBe(expectedTokens);
  });
});
