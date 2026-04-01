import { beforeEach, describe, expect, test } from "bun:test";
import {
  type ForkedAgentConfig,
  type ForkedAgentResult,
  runForkedAgent,
  simplifyMessage,
} from "./forked-agent";

// ─── simplifyMessage ────────────────────────────────────────────

describe("simplifyMessage", () => {
  test("passes through simple string content", () => {
    const result = simplifyMessage({ role: "user", content: "Hello world" });
    expect(result).toEqual({ role: "user", content: "Hello world" });
  });

  test("handles null/undefined content", () => {
    const result = simplifyMessage({ role: "assistant", content: undefined as any });
    expect(result).toEqual({ role: "assistant", content: "" });
  });

  test("extracts text from content blocks", () => {
    const result = simplifyMessage({
      role: "assistant",
      content: [{ type: "text", text: "Here is the answer" }] as any,
    });
    expect(result.content).toBe("Here is the answer");
  });

  test("truncates long tool results to 500 chars", () => {
    const longContent = "x".repeat(1000);
    const result = simplifyMessage({
      role: "user",
      content: [{ type: "tool_result", content: longContent }] as any,
    });
    expect(result.content).toContain("... (truncated)");
    expect(result.content.length).toBeLessThan(600);
  });

  test("does not truncate short tool results", () => {
    const result = simplifyMessage({
      role: "user",
      content: [{ type: "tool_result", content: "short result" }] as any,
    });
    expect(result.content).toBe("[Tool result: short result]");
  });

  test("converts tool_use blocks to labels", () => {
    const result = simplifyMessage({
      role: "assistant",
      content: [{ type: "tool_use", name: "Read", id: "123", input: {} }] as any,
    });
    expect(result.content).toBe("[Tool call: Read]");
  });

  test("handles mixed content blocks", () => {
    const result = simplifyMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Let me check..." },
        { type: "tool_use", name: "Bash", id: "456", input: {} },
      ] as any,
    });
    expect(result.content).toContain("Let me check...");
    expect(result.content).toContain("[Tool call: Bash]");
  });
});

// ─── runForkedAgent ─────────────────────────────────────────────

describe("runForkedAgent", () => {
  test("executes with mock fetch and calls onComplete", async () => {
    let completedResult: ForkedAgentResult | null = null;

    const mockFetch = async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"memories": [], "reasoning": "nothing"}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    await runForkedAgent({
      name: "test-agent",
      systemPrompt: "You are a test agent.",
      contextMessages: [{ role: "user", content: "Hello" }],
      userPrompt: "Analyze this.",
      model: "test-model",
      customFetch: mockFetch as any,
      apiBase: "http://localhost:9999",
      onComplete: async (result) => {
        completedResult = result;
      },
    });

    expect(completedResult).not.toBeNull();
    expect(completedResult!.content).toBe('{"memories": [], "reasoning": "nothing"}');
    expect(completedResult!.inputTokens).toBe(100);
    expect(completedResult!.outputTokens).toBe(50);
    expect(completedResult!.model).toBe("test-model");
    expect(completedResult!.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("timeout aborts the request", async () => {
    let errorCaught: Error | null = null;

    const slowFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      // Wait until aborted
      return new Promise<Response>((_, reject) => {
        const signal = (init as any)?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        }
      });
    };

    await runForkedAgent({
      name: "timeout-test",
      systemPrompt: "Test",
      contextMessages: [],
      userPrompt: "Test",
      model: "test-model",
      timeoutMs: 50, // very short timeout
      customFetch: slowFetch as any,
      apiBase: "http://localhost:9999",
      onComplete: async () => {
        throw new Error("Should not complete");
      },
      onError: (err) => {
        errorCaught = err;
      },
    });

    expect(errorCaught).not.toBeNull();
    expect(errorCaught!.message).toContain("abort");
  });

  test("API error triggers onError callback", async () => {
    let errorCaught: Error | null = null;

    const errorFetch = async () => {
      return new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      });
    };

    await runForkedAgent({
      name: "error-test",
      systemPrompt: "Test",
      contextMessages: [],
      userPrompt: "Test",
      model: "test-model",
      customFetch: errorFetch as any,
      apiBase: "http://localhost:9999",
      onComplete: async () => {
        throw new Error("Should not complete");
      },
      onError: (err) => {
        errorCaught = err;
      },
    });

    expect(errorCaught).not.toBeNull();
    expect(errorCaught!.message).toContain("500");
  });

  test("error in onComplete does not propagate", async () => {
    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "test" } }],
          usage: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    let errorCaught: Error | null = null;

    // Should not throw despite onComplete throwing
    await runForkedAgent({
      name: "error-in-complete",
      systemPrompt: "Test",
      contextMessages: [],
      userPrompt: "Test",
      model: "test-model",
      customFetch: mockFetch as any,
      apiBase: "http://localhost:9999",
      onComplete: async () => {
        throw new Error("onComplete exploded");
      },
      onError: (err) => {
        errorCaught = err;
      },
    });

    // Should have caught the error from onComplete
    expect(errorCaught).not.toBeNull();
    expect(errorCaught!.message).toContain("onComplete exploded");
  });

  test("sends correct request structure", async () => {
    let capturedBody: any = null;
    let capturedHeaders: any = null;

    const captureFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      capturedHeaders = init?.headers;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: {},
        }),
        { status: 200 },
      );
    };

    await runForkedAgent({
      name: "capture-test",
      systemPrompt: "System prompt here",
      contextMessages: [
        { role: "user", content: "User message" },
        { role: "assistant", content: "Assistant reply" },
      ],
      userPrompt: "Analyze this conversation",
      model: "my-model",
      maxTokens: 2000,
      customFetch: captureFetch as any,
      apiBase: "http://test-server:8080",
      apiKey: "test-key",
      onComplete: async () => {},
    });

    expect(capturedBody.model).toBe("my-model");
    expect(capturedBody.max_tokens).toBe(2000);
    expect(capturedBody.stream).toBe(false);
    expect(capturedBody.messages).toHaveLength(4); // system + 2 context + user prompt
    expect(capturedBody.messages[0].role).toBe("system");
    expect(capturedBody.messages[0].content).toBe("System prompt here");
    expect(capturedBody.messages[3].content).toBe("Analyze this conversation");
    expect((capturedHeaders as Record<string, string>)["Authorization"]).toBe("Bearer test-key");
  });

  test("handles empty response gracefully", async () => {
    let completedResult: ForkedAgentResult | null = null;

    const mockFetch = async () => {
      return new Response(JSON.stringify({ choices: [{ message: {} }], usage: {} }), {
        status: 200,
      });
    };

    await runForkedAgent({
      name: "empty-response",
      systemPrompt: "Test",
      contextMessages: [],
      userPrompt: "Test",
      customFetch: mockFetch as any,
      apiBase: "http://localhost:9999",
      onComplete: async (result) => {
        completedResult = result;
      },
    });

    expect(completedResult).not.toBeNull();
    expect(completedResult!.content).toBe("");
  });
});
