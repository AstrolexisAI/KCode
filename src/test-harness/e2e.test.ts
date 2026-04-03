// KCode - E2E Integration Tests
// Tests full conversation flows using the fake provider and fake tools

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConversationManager } from "../core/conversation";
import type { StreamEvent } from "../core/types";
import { FakeProvider } from "./fake-provider";
import { collectEvents, createTestEnv, type TestEnv } from "./test-env";

// ─── Helpers ─────────────────────────────────────────────────────

/** Collect all events from a ConversationManager.sendMessage() call. */
async function sendAndCollect(
  cm: ConversationManager,
  message: string,
): Promise<{ events: StreamEvent[]; text: string; thinking: string }> {
  const events: StreamEvent[] = [];
  const textParts: string[] = [];
  const thinkingParts: string[] = [];

  for await (const event of cm.sendMessage(message)) {
    events.push(event);
    if (event.type === "text_delta") textParts.push(event.text);
    if (event.type === "thinking_delta") thinkingParts.push(event.thinking);
  }

  return { events, text: textParts.join(""), thinking: thinkingParts.join("") };
}

/** Find events of a specific type. */
function eventsOfType<T extends StreamEvent["type"]>(
  events: StreamEvent[],
  type: T,
): Extract<StreamEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as any;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("E2E: FakeProvider standalone", () => {
  let provider: FakeProvider;
  let fetchFn: ReturnType<FakeProvider["createFetch"]>;

  beforeEach(() => {
    provider = new FakeProvider();
    provider.startInProcess();
    fetchFn = provider.createFetch();
  });

  afterEach(async () => {
    try {
      await provider?.stop();
    } catch {
      /* setup may have failed */
    }
  });

  test("serves text response as valid SSE stream", async () => {
    provider.addResponse(
      "Hello from the fake provider, this is a longer test response for the SSE stream parser",
    );

    const res = await fetchFn(`${provider.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "fake-model",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const body = await res.text();
    expect(body).toContain("data: ");
    expect(body).toContain("data: [DONE]");
    expect(body).toContain('"finish_reason":"stop"');
  });

  test("serves tool call response as valid SSE stream", async () => {
    provider.addToolCallResponse([{ name: "Read", arguments: { file_path: "/tmp/test.txt" } }]);

    const res = await fetchFn(`${provider.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [], stream: true }),
    });

    const body = await res.text();
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toContain('"name":"Read"');
    expect(body).toContain("file_path");
  });

  test("records requests for assertion", async () => {
    provider.addResponse("recorded response with enough text to avoid buffer issues");

    await fetchFn(`${provider.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "test" }] }),
    });

    expect(provider.requests.length).toBe(1);
    expect(provider.lastRequest!.method).toBe("POST");
    expect(provider.lastRequest!.url).toBe("/v1/chat/completions");
    expect(provider.lastRequest!.headers["authorization"]).toBe("Bearer test-key");
    expect((provider.lastRequest!.body as any).model).toBe("test-model");
  });

  test("serves error response", async () => {
    provider.addErrorResponse("Rate limit exceeded");

    const res = await fetchFn(`${provider.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [] }),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.message).toBe("Rate limit exceeded");
  });

  test("serves multiple responses in sequence", async () => {
    provider.addResponse("first response is long enough to pass the buffer threshold");
    provider.addResponse("second response is also long enough to parse correctly");

    // First request
    const res1 = await fetchFn(`${provider.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [] }),
    });
    const body1 = await res1.text();
    expect(body1).toContain("first");

    // Second request
    const res2 = await fetchFn(`${provider.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [] }),
    });
    const body2 = await res2.text();
    expect(body2).toContain("second");
  });

  test("returns 500 when no more scripted responses", async () => {
    // No responses queued
    const res = await fetchFn(`${provider.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [] }),
    });

    expect(res.status).toBe(500);
  });

  test("serves max_tokens response with length finish reason", async () => {
    provider.addMaxTokensResponse("This response was truncated because the model ran out of");

    const res = await fetchFn(`${provider.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [] }),
    });

    const body = await res.text();
    expect(body).toContain('"finish_reason":"length"');
    expect(body).toContain("truncated");
  });

  test("serves thinking response with reasoning_content", async () => {
    provider.addThinkingResponse(
      "Let me think about this step by step...",
      "Here is my answer after careful consideration and analysis",
    );

    const res = await fetchFn(`${provider.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [] }),
    });

    const body = await res.text();
    expect(body).toContain("reasoning_content");
    expect(body).toContain("think about this");
    expect(body).toContain("answer");
  });
});

describe("E2E: ConversationManager with FakeProvider", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({
      inProcess: true,
      configOverrides: {
        systemPromptOverride: "You are a helpful test assistant.",
      },
    });
  });

  afterEach(async () => {
    try {
      await env.cleanup();
    } catch {
      /* setup may have failed */
    }
  });

  test("basic text response flow", async () => {
    env.provider.addResponse(
      "Hello! I am the fake assistant and I am here to help you with your coding tasks today.",
    );

    const cm = new ConversationManager(env.config, env.registry);
    const { events, text } = await sendAndCollect(cm, "Hi there");

    // Should have turn_start, text_delta(s), turn_end
    const turnStarts = eventsOfType(events, "turn_start");
    expect(turnStarts.length).toBeGreaterThanOrEqual(1);

    const turnEnds = eventsOfType(events, "turn_end");
    expect(turnEnds.length).toBeGreaterThanOrEqual(1);

    const textDeltas = eventsOfType(events, "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);

    // Full text should contain the response
    expect(text).toContain("fake assistant");

    // Provider should have received exactly 1 request
    // (filter to /v1/chat/completions since there may be other calls)
    const completionReqs = env.provider.requests.filter((r) => r.url === "/v1/chat/completions");
    expect(completionReqs.length).toBe(1);
  });

  test("tool use flow — model calls Read, gets result", async () => {
    // Step 1: Model requests a tool call
    env.provider.addToolCallResponse([{ name: "Read", arguments: { file_path: "/tmp/test.txt" } }]);
    // Step 2: After seeing the tool result, model responds with text
    env.provider.addResponse(
      "I read the file and it contains the test data. The file has useful information for our analysis.",
    );

    // Register a file for the fake Read tool
    const { registry } = env;
    // We need to recreate with the file — use the test env's tool registry
    // The default registry has an empty files map, so Read will return "File not found"
    // That's fine — it still exercises the flow

    const cm = new ConversationManager(env.config, registry);
    const { events, text } = await sendAndCollect(cm, "Read the file /tmp/test.txt");

    // Should have tool-related events
    const toolExecs = eventsOfType(events, "tool_executing");
    expect(toolExecs.length).toBe(1);
    expect(toolExecs[0]!.name).toBe("Read");

    const toolResults = eventsOfType(events, "tool_result");
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]!.name).toBe("Read");

    // The final text response from the model
    expect(text).toContain("read the file");

    // Provider should have received at least 2 requests (tool call + follow-up)
    const completionReqs = env.provider.requests.filter((r) => r.url === "/v1/chat/completions");
    expect(completionReqs.length).toBeGreaterThanOrEqual(2);
  });

  test("tool use flow — model calls Bash, result is returned", async () => {
    const envWithBash = await createTestEnv({
      inProcess: true,
      tools: {
        bashCommands: { ls: "file1.ts\nfile2.ts\nfile3.ts" },
      },
      configOverrides: {
        systemPromptOverride: "You are a helpful test assistant.",
      },
    });

    try {
      // Model requests bash execution
      envWithBash.provider.addToolCallResponse([
        { name: "Bash", arguments: { command: "ls", description: "List files" } },
      ]);
      // After seeing result, model responds
      envWithBash.provider.addResponse(
        "The directory contains three TypeScript files: file1.ts, file2.ts, and file3.ts as expected.",
      );

      const cm = new ConversationManager(envWithBash.config, envWithBash.registry);
      const { events } = await sendAndCollect(cm, "List the files");

      const toolResults = eventsOfType(events, "tool_result");
      expect(toolResults.length).toBe(1);
      expect(toolResults[0]!.result).toContain("file1.ts");

      expect(envWithBash.bashCommands.length).toBe(1);
      expect(envWithBash.bashCommands[0]!.command).toBe("ls");
    } finally {
      await envWithBash.cleanup();
    }
  });

  test("thinking flow — reasoning_content emits thinking_delta events", async () => {
    env.provider.addThinkingResponse(
      "Let me analyze this carefully step by step before responding...",
      "Based on my analysis, the answer is 42. This is the ultimate answer to everything.",
    );

    const cm = new ConversationManager(env.config, env.registry);
    const { events, text, thinking } = await sendAndCollect(cm, "What is the meaning of life?");

    // Should have thinking_delta events
    const thinkingDeltas = eventsOfType(events, "thinking_delta");
    expect(thinkingDeltas.length).toBeGreaterThan(0);
    expect(thinking).toContain("analyze this carefully");

    // Should also have text content
    expect(text).toContain("42");
  });

  test("multi-turn — tool use followed by text response", async () => {
    // Turn 1: Model calls Write tool
    env.provider.addToolCallResponse([
      {
        name: "Write",
        arguments: {
          file_path: "/tmp/output.txt",
          content: "Hello, World!",
        },
      },
    ]);
    // Turn 2: Model calls Read to verify
    env.provider.addToolCallResponse([
      { name: "Read", arguments: { file_path: "/tmp/output.txt" } },
    ]);
    // Turn 3: Model responds with summary
    env.provider.addResponse(
      "I wrote 'Hello, World!' to /tmp/output.txt and verified the file was created successfully for you.",
    );

    const cm = new ConversationManager(env.config, env.registry);
    const { events } = await sendAndCollect(cm, "Write hello world to a file and verify it");

    const toolExecs = eventsOfType(events, "tool_executing");
    expect(toolExecs.length).toBe(2);
    expect(toolExecs[0]!.name).toBe("Write");
    expect(toolExecs[1]!.name).toBe("Read");

    // Verify the Write tool recorded the write
    expect(env.writes.length).toBe(1);
    expect(env.writes[0]!.filePath).toBe("/tmp/output.txt");
    expect(env.writes[0]!.content).toBe("Hello, World!");

    // Provider should have received 3 requests
    const completionReqs = env.provider.requests.filter((r) => r.url === "/v1/chat/completions");
    expect(completionReqs.length).toBe(3);
  });

  test("max_tokens continuation — model is auto-continued when truncated", async () => {
    // First response: truncated (max_tokens)
    env.provider.addMaxTokensResponse(
      "This is the beginning of a very long explanation that gets cut off because of the token limit and will need",
    );
    // Continuation response after the system injects a continue prompt
    env.provider.addResponse(
      "to be continued here with the rest of the explanation that the user was waiting for successfully.",
    );

    const cm = new ConversationManager(env.config, env.registry);
    const { events, text } = await sendAndCollect(cm, "Give me a long explanation");

    // Should have at least 2 turn_starts (original + continuation)
    const turnStarts = eventsOfType(events, "turn_start");
    expect(turnStarts.length).toBeGreaterThanOrEqual(2);

    // Should see the max_tokens_continue stop reason
    const turnEnds = eventsOfType(events, "turn_end");
    const continueEnd = turnEnds.find((e) => e.stopReason === "max_tokens_continue");
    expect(continueEnd).toBeDefined();

    // Final text should combine both parts
    expect(text).toContain("beginning");
    expect(text).toContain("continued");
  });

  test("error handling — provider returns error", async () => {
    env.provider.addErrorResponse("Model overloaded");

    const cm = new ConversationManager(env.config, env.registry);
    const { events } = await sendAndCollect(cm, "This should fail");

    // Should have an error event
    const errors = eventsOfType(events, "error");
    expect(errors.length).toBeGreaterThan(0);

    // Should have a turn_end with error stop reason
    const turnEnds = eventsOfType(events, "turn_end");
    const errorEnd = turnEnds.find((e) => e.stopReason === "error");
    expect(errorEnd).toBeDefined();
  });

  test("usage tracking — token counts are reported", async () => {
    env.provider.addResponse(
      "Here is a response with specific usage tracking to verify token counting works correctly in the test.",
      { promptTokens: 200, completionTokens: 75 },
    );

    const cm = new ConversationManager(env.config, env.registry);
    const { events } = await sendAndCollect(cm, "Track my tokens");

    const usageUpdates = eventsOfType(events, "usage_update");
    expect(usageUpdates.length).toBeGreaterThan(0);

    const lastUsage = usageUpdates[usageUpdates.length - 1]!;
    expect(lastUsage.usage.inputTokens).toBe(200);
    expect(lastUsage.usage.outputTokens).toBe(75);
  });

  test("request format — sends correct OpenAI-compatible request body", async () => {
    env.provider.addResponse(
      "Checking the request format to ensure it matches the expected OpenAI API structure correctly.",
    );

    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "Hello from the test");

    const req = env.provider.requests.find((r) => r.url === "/v1/chat/completions");
    expect(req).toBeDefined();

    const body = req!.body as any;
    expect(body.model).toBe("fake-model");
    expect(body.stream).toBe(true);
    expect(body.messages).toBeDefined();
    expect(Array.isArray(body.messages)).toBe(true);

    // Should have at least a system message and the user message
    const systemMsg = body.messages.find((m: any) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg.content).toContain("helpful test assistant");

    const userMsg = body.messages.find(
      (m: any) => m.role === "user" && m.content?.includes?.("Hello from the test"),
    );
    expect(userMsg).toBeDefined();
  });

  test("multiple tool calls in single response", async () => {
    // Model requests two tool calls at once
    env.provider.addToolCallResponse([
      { name: "Read", arguments: { file_path: "/tmp/a.txt" } },
      { name: "Read", arguments: { file_path: "/tmp/b.txt" } },
    ]);
    // After seeing both results, model responds
    env.provider.addResponse(
      "I read both files. Neither file was found but that is expected in this test environment setup.",
    );

    const cm = new ConversationManager(env.config, env.registry);
    const { events } = await sendAndCollect(cm, "Read both files");

    const toolExecs = eventsOfType(events, "tool_executing");
    // Both Read tools should have been executed (may be parallel)
    expect(toolExecs.length).toBe(2);
    const toolNames = toolExecs.map((e) => e.name);
    expect(toolNames).toContain("Read");
  });

  test("provider reset clears state", async () => {
    env.provider.addResponse(
      "first response that is long enough to be parsed by the SSE stream parser correctly",
    );

    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "First message");

    expect(env.provider.requests.length).toBeGreaterThan(0);

    env.provider.reset();
    expect(env.provider.requests.length).toBe(0);

    // After reset, a new request should get 500 (no responses queued)
    env.provider.addResponse(
      "new response after reset that is also long enough to parse through the SSE buffer correctly",
    );
    const cm2 = new ConversationManager(env.config, env.registry);
    const { text } = await sendAndCollect(cm2, "After reset");
    expect(text).toContain("new response after reset");
  });
});

// ─── Theoretical Mode E2E ──────────────────────────────────────

describe("E2E: Theoretical mode — tool blocking", () => {
  test("detects theoretical prompt and blocks tool calls, preserving text", async () => {
    const env = await createTestEnv({
      inProcess: true,
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
      },
    });

    try {
      // Model tries to use a tool despite the theoretical prompt
      env.provider.addToolCallResponse([
        { name: "Bash", arguments: { command: "echo test", description: "test" } },
      ]);
      // After tool is blocked and model retries, it responds with text
      env.provider.addResponse(
        "Here is my text-only analysis of the theoretical problem with detailed reasoning and step by step explanation.",
      );

      const cm = new ConversationManager(env.config, env.registry);

      // Structured reasoning prompt that triggers looksTheoretical()
      const theoreticalPrompt = `### CONTEXTO
Una empresa opera con las siguientes condiciones.
| Producto | A | B | C |
| P1 | 10 | 0 | 5 |
#### PARTE 1 — Diagnóstico
Explicá el razonamiento paso a paso para maximizar ganancia.
#### PARTE 2 — Trade-offs
Analizá los trade-off entre opciones.`;

      const { events, text } = await sendAndCollect(cm, theoreticalPrompt);

      // Tool should NOT have been executed
      const toolExecs = eventsOfType(events, "tool_executing");
      expect(toolExecs.length).toBe(0);

      // Should have theoretical_no_tools stop reason (tool was blocked)
      const turnEnds = eventsOfType(events, "turn_end");
      const blocked = turnEnds.find((e) => e.stopReason === "theoretical_no_tools");
      expect(blocked).toBeDefined();

      // Should have the text-only response from the retry
      expect(text).toContain("text-only analysis");

      // Bash command should NOT have been recorded
      expect(env.bashCommands.length).toBe(0);
    } finally {
      await env.cleanup();
    }
  });

  test("after 2 retries with only tool calls, yields error and stops", async () => {
    const env = await createTestEnv({
      inProcess: true,
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
      },
    });

    try {
      // Model stubbornly returns only tool calls, 3 times
      env.provider.addToolCallResponse([
        { name: "Read", arguments: { file_path: "/tmp/test.txt" } },
      ]);
      env.provider.addToolCallResponse([
        { name: "Bash", arguments: { command: "ls", description: "list" } },
      ]);
      env.provider.addToolCallResponse([{ name: "Glob", arguments: { pattern: "*.ts" } }]);

      const cm = new ConversationManager(env.config, env.registry);

      const theoreticalPrompt = `### TAREAS
#### PARTE 1 — Diagnóstico
Explicá el razonamiento paso a paso para maximizar ganancia.
| Stock | A | B |
| P1 | 10 | 0 |
#### PARTE 2 — Optimización
Analizá el trade-off entre las opciones disponibles.`;

      const { events } = await sendAndCollect(cm, theoreticalPrompt);

      // No tools should have been executed
      const toolExecs = eventsOfType(events, "tool_executing");
      expect(toolExecs.length).toBe(0);

      // Should have an error event about model not complying
      const errors = eventsOfType(events, "error");
      expect(errors.length).toBeGreaterThan(0);

      // Bash/Read should NOT have been recorded
      expect(env.bashCommands.length).toBe(0);
    } finally {
      await env.cleanup();
    }
  });

  test("non-theoretical prompt allows tool execution normally", async () => {
    const env = await createTestEnv({
      inProcess: true,
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
      },
    });

    try {
      env.provider.addToolCallResponse([
        { name: "Bash", arguments: { command: "ls", description: "List files" } },
      ]);
      env.provider.addResponse(
        "I listed the files and found the project structure for you as requested in this test.",
      );

      const cm = new ConversationManager(env.config, env.registry);
      const { events } = await sendAndCollect(cm, "List all TypeScript files in this directory");

      // Tool SHOULD have been executed
      const toolExecs = eventsOfType(events, "tool_executing");
      expect(toolExecs.length).toBe(1);
      expect(toolExecs[0]!.name).toBe("Bash");
    } finally {
      await env.cleanup();
    }
  });
});

// ─── Recovery Summary E2E ──────────────────────────────────────

describe("E2E: Recovery summary on empty response after tools", () => {
  test("emits recovery note when tools ran but no text response", async () => {
    const env = await createTestEnv({
      inProcess: true,
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
      },
    });

    try {
      // Model calls a tool
      env.provider.addToolCallResponse([
        { name: "Bash", arguments: { command: "ls", description: "list" } },
      ]);
      // Then returns empty text (simulates model failing to produce summary)
      // Need 3 empty responses: original + 2 empty retries
      env.provider.addResponse("");
      env.provider.addResponse("");
      env.provider.addResponse("");

      const cm = new ConversationManager(env.config, env.registry);
      const { events } = await sendAndCollect(cm, "Create the project structure");

      // Tool should have executed
      const toolExecs = eventsOfType(events, "tool_executing");
      expect(toolExecs.length).toBe(1);

      // Should have a partial_progress event since tools ran but no text
      const progress = eventsOfType(events, "partial_progress");
      expect(progress.length).toBeGreaterThanOrEqual(1);
      expect(progress[0]!.toolsUsed).toBeGreaterThan(0);
    } finally {
      await env.cleanup();
    }
  });

  test("emits partial_progress when tools ran but only minimal text", async () => {
    const env = await createTestEnv({
      inProcess: true,
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
      },
    });

    try {
      // Model calls a tool, then returns only whitespace/minimal text
      env.provider.addToolCallResponse([
        { name: "Bash", arguments: { command: "ls", description: "list" } },
      ]);
      // Returns just a few chars — below the 20-char threshold
      env.provider.addResponse("OK");
      env.provider.addResponse("OK");
      env.provider.addResponse("OK");

      const cm = new ConversationManager(env.config, env.registry);
      const { events } = await sendAndCollect(cm, "Inspect the project structure");

      // Should have partial_progress because text was minimal
      const progress = eventsOfType(events, "partial_progress");
      expect(progress.length).toBeGreaterThanOrEqual(1);
    } finally {
      await env.cleanup();
    }
  });
});

// ─── P2.1: Long Scaffold E2E ──────────────────────────────────

describe("E2E: Long scaffold flows", () => {
  test("checkpoint stops execution after initial setup stage", async () => {
    const env = await createTestEnv({
      inProcess: true,
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
      },
    });

    try {
      // Model keeps making tool calls (simulating scaffold + extra work)
      // 10 tool calls — should be stopped at 4 by checkpoint
      for (let i = 0; i < 10; i++) {
        env.provider.addToolCallResponse([
          { name: "Bash", arguments: { command: `echo step${i}`, description: `Step ${i}` } },
        ]);
      }
      // Final text response after checkpoint forces stop
      env.provider.addResponse(
        "Here is a summary of what was created in the initial structure for the project as requested.",
      );

      const cm = new ConversationManager(env.config, env.registry);

      // Prompt with checkpoint language
      const { events } = await sendAndCollect(
        cm,
        "Crea un sitio web completo sobre Bitcoin. Empieza con la estructura inicial y muéstrame el primer paso cuando termines.",
      );

      // Should have a checkpoint_reached stop reason
      const turnEnds = eventsOfType(events, "turn_end");
      const checkpoint = turnEnds.find((e) => e.stopReason === "checkpoint_reached");
      expect(checkpoint).toBeDefined();

      // Tool executions should be capped (not all 10)
      const toolExecs = eventsOfType(events, "tool_executing");
      expect(toolExecs.length).toBeLessThanOrEqual(4);
    } finally {
      await env.cleanup();
    }
  });

  test("error fingerprinting tracks repeated failures", async () => {
    const env = await createTestEnv({
      inProcess: true,
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
      },
    });

    // Register a Write tool that always fails with the same error
    const failDef = {
      name: "Write",
      description: "Write file",
      input_schema: {
        type: "object" as const,
        properties: { file_path: { type: "string" }, content: { type: "string" } },
        required: ["file_path", "content"],
      },
    };
    let writeCallCount = 0;
    const failHandler = async () => {
      writeCallCount++;
      return {
        tool_use_id: "",
        content: "Error: embedding HTML inside TypeScript is not allowed",
        is_error: true,
      };
    };
    env.registry.register("Write", failDef, failHandler);

    try {
      // Model tries Write, fails, tries again, fails, then gives text
      env.provider.addToolCallResponse([
        { name: "Write", arguments: { file_path: "/tmp/test.tsx", content: "<div>test</div>" } },
      ]);
      // After first failure, model tries Write again
      env.provider.addToolCallResponse([
        { name: "Write", arguments: { file_path: "/tmp/test2.tsx", content: "<div>test2</div>" } },
      ]);
      // After second failure (now burned), model tries a third time
      env.provider.addToolCallResponse([
        { name: "Write", arguments: { file_path: "/tmp/test3.tsx", content: "<div>test3</div>" } },
      ]);
      // Finally responds with text
      env.provider.addResponse(
        "I could not write the files due to repeated errors with HTML in TypeScript. Trying different approach.",
      );

      const cm = new ConversationManager(env.config, env.registry);
      const { events } = await sendAndCollect(cm, "Create the component files");

      // The tool should have been called at most 2 times (handler executes)
      // Third call should be blocked before execution
      const toolResults = eventsOfType(events, "tool_result");
      const errorResults = toolResults.filter((r) => r.isError);

      // At least one error result should exist
      expect(errorResults.length).toBeGreaterThanOrEqual(1);

      // The Write handler should be called at most 2 times
      // (third is blocked by burned fingerprint before execution)
      expect(writeCallCount).toBeLessThanOrEqual(2);
    } finally {
      await env.cleanup();
    }
  });
});
