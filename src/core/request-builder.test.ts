import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  classifyApiErrorHint,
  estimateToolDefinitionTokens,
  formatApiErrorMessage,
  resolveApiKey,
} from "./request-builder.ts";
import { convertToOpenAIMessages } from "./message-converters.ts";
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

// ─── API error formatting ───────────────────────────────────────

describe("classifyApiErrorHint", () => {
  test("returns billing hint on 402", () => {
    expect(classifyApiErrorHint(402, "")).toMatch(/billing\/credits/);
  });

  test("returns billing hint when body mentions credits", () => {
    expect(classifyApiErrorHint(400, "insufficient credit balance")).toMatch(
      /billing/,
    );
  });

  test("returns auth hint on 401/403", () => {
    expect(classifyApiErrorHint(401, "")).toMatch(/API key permissions/);
    expect(classifyApiErrorHint(403, "")).toMatch(/API key permissions/);
  });

  test("returns context hint on 400 with 'too many tokens'", () => {
    expect(classifyApiErrorHint(400, "too many tokens in prompt")).toMatch(
      /context window/,
    );
  });

  test("returns 5xx hint on 500/502/503 (Orbital session fix)", () => {
    expect(classifyApiErrorHint(500, "")).toMatch(/transient/);
    expect(classifyApiErrorHint(502, "")).toMatch(/transient/);
    expect(classifyApiErrorHint(503, "")).toMatch(/transient/);
    expect(classifyApiErrorHint(500, "")).toMatch(/\/toggle to another model/);
  });

  test("returns overload-specific hint when body mentions 'overloaded'", () => {
    // xAI grok capacity errors:
    //   {"error":{"message":"Primary model overloaded"}}
    //   {"error":{"message":"Model overloaded"}}
    //   {"error":{"message":"Internal server error: model overloaded"}}
    const h1 = classifyApiErrorHint(
      500,
      '{"error":{"message":"Primary model overloaded"}}',
    );
    expect(h1).toMatch(/overloaded right now/);
    expect(h1).toMatch(/\/toggle to another provider/);
    expect(h1).not.toMatch(/transient/);

    expect(classifyApiErrorHint(500, "Model overloaded")).toMatch(
      /overloaded right now/,
    );
    expect(
      classifyApiErrorHint(503, "Internal server error: model overloaded"),
    ).toMatch(/overloaded right now/);
  });

  test("returns empty string for unclassified errors", () => {
    expect(classifyApiErrorHint(418, "")).toBe("");
  });
});

describe("formatApiErrorMessage", () => {
  test("includes endpoint origin so dual local+cloud setups are disambiguated", () => {
    const msg = formatApiErrorMessage({
      status: 500,
      statusText: "Internal Server Error",
      errorText: "upstream down",
      url: "https://api.x.ai/v1/chat/completions",
      hint: " (hint: retry)",
    });
    expect(msg).toContain("500 Internal Server Error");
    expect(msg).toContain("from https://api.x.ai/v1/chat/completions");
    expect(msg).toContain("upstream down");
    expect(msg).toContain("(hint: retry)");
  });

  test("works with localhost endpoints", () => {
    const msg = formatApiErrorMessage({
      status: 500,
      statusText: "Internal Server Error",
      errorText: "",
      url: "http://localhost:8090/v1/chat/completions",
      hint: "",
    });
    expect(msg).toContain("from http://localhost:8090/v1/chat/completions");
  });

  test("gracefully handles invalid URLs (no origin label)", () => {
    const msg = formatApiErrorMessage({
      status: 500,
      statusText: "Server Error",
      errorText: "",
      url: "not-a-url",
      hint: "",
    });
    expect(msg).toContain("500 Server Error");
    expect(msg).not.toContain("from ");
  });

  test("omits empty errorText and empty hint cleanly", () => {
    const msg = formatApiErrorMessage({
      status: 502,
      statusText: "Bad Gateway",
      errorText: "",
      url: "https://api.example.com/v1/foo",
      hint: "",
    });
    expect(msg).toBe(
      "API request failed: 502 Bad Gateway from https://api.example.com/v1/foo",
    );
  });
});

// ─── convertToOpenAIMessages — system role by model type ───────

describe("convertToOpenAIMessages system role", () => {
  const msgs = [{ role: "user" as const, content: "hello" }];
  const systemPrompt = "You are a helpful assistant.";

  test("default role is 'system' for standard models", () => {
    const result = convertToOpenAIMessages(systemPrompt, msgs);
    expect(result[0]!.role).toBe("system");
  });

  test("role 'developer' is used when explicitly requested (o1/o3/o4)", () => {
    const result = convertToOpenAIMessages(systemPrompt, msgs, "developer");
    expect(result[0]!.role).toBe("developer");
    expect(result[0]!.content).toBe(systemPrompt);
  });

  test("gpt-4o keeps 'system' role (not a reasoning model)", () => {
    const result = convertToOpenAIMessages(systemPrompt, msgs, "system");
    expect(result[0]!.role).toBe("system");
  });

  test("developer role still passes system prompt content unchanged", () => {
    const result = convertToOpenAIMessages(systemPrompt, msgs, "developer");
    expect(result[0]!.content).toBe(systemPrompt);
    expect(result[1]!.role).toBe("user");
    expect(result[1]!.content).toBe("hello");
  });

  test("empty system prompt produces no system/developer message", () => {
    const result = convertToOpenAIMessages("", msgs, "developer");
    expect(result[0]!.role).toBe("user");
  });
});

// ─── ModelProvider enum completeness ───────────────────────────

describe("ModelProvider coverage", () => {
  test("all expected providers are valid ModelProvider values", async () => {
    const { getModelProvider } = await import("./models.ts");
    // These should not throw — they return recognized provider strings
    const providers = await Promise.all([
      getModelProvider("claude-3-5-sonnet-20241022"),
      getModelProvider("grok-4"),
      getModelProvider("gemini-1.5-pro"),
      getModelProvider("deepseek-coder"),
      getModelProvider("gpt-4o"),
    ]);
    expect(providers[0]).toBe("anthropic");
    expect(providers[1]).toBe("xai");
    expect(providers[2]).toBe("google");
    expect(providers[3]).toBe("deepseek");
    expect(providers[4]).toBe("openai");
  });
});
