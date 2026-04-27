// KCode - Conversation E2E Tests
// End-to-end tests for the conversation loop: prompt-to-response, streaming,
// tool calls, max turns, abort, and multi-turn history

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestEnv, type TestEnv } from "../test-harness/test-env";
import { ConversationManager } from "./conversation";
import type { StreamEvent } from "./types";

// ─── Helpers ─────────────────────────────────────────────────────

async function sendAndCollect(
  cm: ConversationManager,
  message: string,
): Promise<{ events: StreamEvent[]; text: string }> {
  const events: StreamEvent[] = [];
  const textParts: string[] = [];

  for await (const event of cm.sendMessage(message)) {
    events.push(event);
    if (event.type === "text_delta") textParts.push(event.text);
  }

  return { events, text: textParts.join("") };
}

function eventsOfType<T extends StreamEvent["type"]>(
  events: StreamEvent[],
  type: T,
): Extract<StreamEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<StreamEvent, { type: T }>[];
}

// ─── Conversation Loop Completes ────────────────────────────────

describe("Conversation E2E: loop completion", () => {
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
    await env.cleanup();
  });

  test("conversation loop completes: prompt -> response -> done", async () => {
    env.provider.addResponse(
      "This is a complete response from the assistant to verify the conversation loop works end to end.",
    );

    const cm = new ConversationManager(env.config, env.registry);
    const { events, text } = await sendAndCollect(cm, "Hello, how are you?");

    // Must have turn_start and turn_end events
    const turnStarts = eventsOfType(events, "turn_start");
    const turnEnds = eventsOfType(events, "turn_end");
    expect(turnStarts.length).toBeGreaterThanOrEqual(1);
    expect(turnEnds.length).toBeGreaterThanOrEqual(1);

    // Must have text content
    expect(text).toContain("complete response");

    // Final turn_end should have "stop" or "end_turn" stop reason
    const lastTurnEnd = turnEnds[turnEnds.length - 1]!;
    expect(["stop", "end_turn"]).toContain(lastTurnEnd.stopReason);

    // State should reflect the conversation
    const state = cm.getState();
    expect(state.messages.length).toBeGreaterThanOrEqual(2);
    expect(state.messages[0]!.role).toBe("user");

    // isRunning should be false after completion
    expect(cm.isRunning).toBe(false);
  });
});

// ─── Streaming Produces text_delta Events ─────────────────────

describe("Conversation E2E: streaming", () => {
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
    await env.cleanup();
  });

  test("streaming produces text_delta events with content", async () => {
    env.provider.addResponse(
      "The quick brown fox jumps over the lazy dog in this streaming test response for KCode verification.",
    );

    const cm = new ConversationManager(env.config, env.registry);
    const { events, text } = await sendAndCollect(cm, "Tell me a story");

    const textDeltas = eventsOfType(events, "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);

    // Each text_delta should have non-empty text
    for (const delta of textDeltas) {
      expect(typeof delta.text).toBe("string");
      expect(delta.text.length).toBeGreaterThan(0);
    }

    // Combined text should match the full response
    expect(text).toContain("quick brown fox");
    expect(text).toContain("lazy dog");
  });

  test("usage_update events are emitted during streaming", async () => {
    env.provider.addResponse(
      "A response with specific token usage to verify usage tracking works correctly in streaming mode.",
      { promptTokens: 150, completionTokens: 60 },
    );

    const cm = new ConversationManager(env.config, env.registry);
    const { events } = await sendAndCollect(cm, "Track usage");

    const usageEvents = eventsOfType(events, "usage_update");
    expect(usageEvents.length).toBeGreaterThan(0);

    const lastUsage = usageEvents[usageEvents.length - 1]!;
    expect(lastUsage.usage.inputTokens).toBe(150);
    expect(lastUsage.usage.outputTokens).toBe(60);
  });
});

// ─── Tool Call Triggers Execution ───────────────────────────────

describe("Conversation E2E: tool execution", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({
      inProcess: true,
      tools: {
        files: { "/tmp/e2e-test.txt": "content from the E2E test file" },
        bashCommands: { "echo hello": "hello" },
      },
      configOverrides: {
        systemPromptOverride: "You are a helpful test assistant.",
      },
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("tool call triggers tool execution and returns result", async () => {
    env.provider.addToolCallResponse([
      { name: "Read", arguments: { file_path: "/tmp/e2e-test.txt" } },
    ]);
    env.provider.addResponse(
      "I read the file and found the content from the E2E test file successfully for you.",
    );

    const cm = new ConversationManager(env.config, env.registry);
    const { events } = await sendAndCollect(cm, "Read the test file");

    // Should have tool_executing event
    const toolExecs = eventsOfType(events, "tool_executing");
    expect(toolExecs.length).toBe(1);
    expect(toolExecs[0]!.name).toBe("Read");

    // Should have tool_result event
    const toolResults = eventsOfType(events, "tool_result");
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]!.name).toBe("Read");
    expect(toolResults[0]!.result).toContain("content from the E2E test file");

    // Provider should have received 2 requests (tool call + follow-up)
    const completionReqs = env.provider.requests.filter((r) => r.url === "/v1/chat/completions");
    expect(completionReqs.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Max Turns Limit ────────────────────────────────────────────

describe("Conversation E2E: max turns", () => {
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
    await env.cleanup();
  });

  test("max turns limit stops the conversation loop", async () => {
    // Queue many tool call responses to exceed the limit
    for (let i = 0; i < 5; i++) {
      env.provider.addToolCallResponse([
        { name: "Bash", arguments: { command: `echo step${i}`, description: `Step ${i}` } },
      ]);
    }
    env.provider.addResponse(
      "Final response after max turns was respected correctly by the conversation manager.",
    );

    const cm = new ConversationManager(env.config, env.registry);
    const { events } = await sendAndCollect(cm, "Run many steps");

    // Tool executions should be capped (not all 5)
    const toolExecs = eventsOfType(events, "tool_executing");
    expect(toolExecs.length).toBeLessThan(5);

    // Should have a turn_end event
    const turnEnds = eventsOfType(events, "turn_end");
    expect(turnEnds.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Abort Stops Conversation ───────────────────────────────────

describe("Conversation E2E: abort", () => {
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
    await env.cleanup();
  });

  test("abort stops the conversation and sets isRunning to false", async () => {
    env.provider.addResponse(
      "This is a response that will be interrupted by abort during streaming in the test.",
    );

    const cm = new ConversationManager(env.config, env.registry);
    const gen = cm.sendMessage("Hello");

    // Consume at least one event
    const first = await gen.next();
    expect(first.done).toBe(false);

    // Abort
    cm.abort();

    // Drain remaining events
    const events: StreamEvent[] = [];
    let result = await gen.next();
    while (!result.done) {
      events.push(result.value);
      result = await gen.next();
    }

    // isRunning should be false after abort
    expect(cm.isRunning).toBe(false);
  });
});

// ─── Multi-turn History ─────────────────────────────────────────

describe("Conversation E2E: multi-turn history", () => {
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
    await env.cleanup();
  });

  test("multi-turn conversation preserves history across turns", async () => {
    // Turn 1
    env.provider.addResponse(
      "First response from the assistant acknowledging the user greeting in this test scenario.",
    );
    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "First message from user");

    const stateAfterFirst = cm.getState();
    const msgCountAfterFirst = stateAfterFirst.messages.length;
    expect(msgCountAfterFirst).toBeGreaterThanOrEqual(2); // user + assistant

    // Turn 2
    env.provider.addResponse(
      "Second response from the assistant continuing the conversation in this multi-turn test.",
    );
    await sendAndCollect(cm, "Second message from user");

    const stateAfterSecond = cm.getState();
    expect(stateAfterSecond.messages.length).toBeGreaterThan(msgCountAfterFirst);

    // Turn 3
    env.provider.addResponse(
      "Third response confirming the history is preserved across all conversation turns.",
    );
    await sendAndCollect(cm, "Third message from user");

    const finalState = cm.getState();
    expect(finalState.messages.length).toBeGreaterThanOrEqual(6); // 3 user + 3 assistant

    // Verify the provider received all messages in context
    const lastReq = env.provider.requests.filter((r) => r.url === "/v1/chat/completions");
    const lastBody = lastReq[lastReq.length - 1]!.body as any;
    const messages = lastBody.messages as any[];

    // The last request should include history from previous turns
    const userMessages = messages.filter((m: any) => m.role === "user");
    expect(userMessages.length).toBeGreaterThanOrEqual(3);
  });

  test("session ID remains stable across turns", async () => {
    env.provider.addResponse("First turn response for session ID stability test.");
    const cm = new ConversationManager(env.config, env.registry);
    const sessionId = cm.getSessionId();
    await sendAndCollect(cm, "First");

    env.provider.addResponse("Second turn response verifying session ID stability.");
    await sendAndCollect(cm, "Second");

    expect(cm.getSessionId()).toBe(sessionId);
  });
});
