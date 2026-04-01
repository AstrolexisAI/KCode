// KCode - Additional E2E Flow Tests
// Tests multi-tool flows, error recovery, multi-turn, compaction, and edge cases

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConversationManager } from "../core/conversation";
import type { StreamEvent } from "../core/types";
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

// ─── Test 1: Multi-tool flow — Read then Write ──────────────────

describe("E2E Flows: Multi-tool Read then Write", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({
      inProcess: true,
      tools: {
        files: { "/tmp/source.txt": "important data from the source file" },
      },
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

  test("executes Read then Write, model receives both results", async () => {
    // Step 1: Model calls Read
    env.provider.addToolCallResponse([
      { name: "Read", arguments: { file_path: "/tmp/source.txt" } },
    ]);
    // Step 2: After seeing Read result, model calls Write
    env.provider.addToolCallResponse([
      {
        name: "Write",
        arguments: { file_path: "/tmp/output.txt", content: "processed data from source" },
      },
    ]);
    // Step 3: After Write result, model responds with summary
    env.provider.addResponse(
      "I read the source file and wrote the processed output to /tmp/output.txt successfully for you.",
    );

    const cm = new ConversationManager(env.config, env.registry);
    const { events, text } = await sendAndCollect(
      cm,
      "Read /tmp/source.txt and write processed data to /tmp/output.txt",
    );

    // Both tools should have executed
    const toolExecs = eventsOfType(events, "tool_executing");
    expect(toolExecs.length).toBe(2);
    expect(toolExecs[0]!.name).toBe("Read");
    expect(toolExecs[1]!.name).toBe("Write");

    // Read result should contain the file content
    const toolResults = eventsOfType(events, "tool_result");
    expect(toolResults.length).toBe(2);
    const readResult = toolResults.find((r) => r.name === "Read");
    expect(readResult).toBeDefined();
    expect(readResult!.result).toContain("important data");

    // Write should have been recorded
    expect(env.writes.length).toBe(1);
    expect(env.writes[0]!.filePath).toBe("/tmp/output.txt");
    expect(env.writes[0]!.content).toBe("processed data from source");

    // Final text response received
    expect(text).toContain("read the source file");

    // Provider should have received 3 requests (Read call, Write call, final text)
    const completionReqs = env.provider.requests.filter((r) => r.url === "/v1/chat/completions");
    expect(completionReqs.length).toBe(3);
  });
});

// ─── Test 2: Tool error recovery ────────────────────────────────

describe("E2E Flows: Tool error recovery", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({
      inProcess: true,
      tools: {
        // Map "git status" to an error-like output so the model sees the failure
        bashCommands: {
          "git status": "fatal: not a git repository (or any of the parent directories): .git",
        },
      },
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

  test("model sees error output from tool and recovers with text", async () => {
    // Step 1: Model calls Bash with "git status"
    env.provider.addToolCallResponse([
      { name: "Bash", arguments: { command: "git status", description: "Check git status" } },
    ]);
    // Step 2: After seeing the error output, model responds with text
    env.provider.addResponse(
      "The git status command reported this is not a git repository. You may need to initialize one first with git init.",
    );

    const cm = new ConversationManager(env.config, env.registry);
    const { events, text } = await sendAndCollect(cm, "Run git status");

    // Tool should have executed
    const toolExecs = eventsOfType(events, "tool_executing");
    expect(toolExecs.length).toBe(1);
    expect(toolExecs[0]!.name).toBe("Bash");

    // Tool result should contain the error-like output
    const toolResults = eventsOfType(events, "tool_result");
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]!.result).toContain("not a git repository");

    // The bash command was recorded
    expect(env.bashCommands.length).toBe(1);
    expect(env.bashCommands[0]!.command).toBe("git status");

    // Model recovered with a text response based on the error output
    expect(text).toContain("not a git repository");
  });
});

// ─── Test 3: Multi-turn conversation ────────────────────────────

describe("E2E Flows: Multi-turn conversation", () => {
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

  test("message history grows across turns", async () => {
    // Queue enough responses for both turns plus buffer for retry/recovery logic
    env.provider.addResponse(
      "Hello! I am ready to help you with your coding project today. What would you like to work on first?",
    );
    env.provider.addResponse(
      "Sure, I can help with TypeScript refactoring. Let me know which files you would like me to look at now.",
    );
    env.provider.addResponse(
      "Continuing to help with the TypeScript refactoring task you requested from me earlier in our session.",
    );
    env.provider.addResponse(
      "Still available and ready to assist with whatever coding task you need me to help you with next time.",
    );

    const cm = new ConversationManager(env.config, env.registry);

    // Turn 1
    const turn1 = await sendAndCollect(cm, "Hello, I need help with my project");
    expect(turn1.text).toContain("ready to help");

    const turn1Ends = eventsOfType(turn1.events, "turn_end");
    expect(turn1Ends.length).toBeGreaterThanOrEqual(1);

    // Turn 2
    const turn2 = await sendAndCollect(cm, "Can you help me refactor some TypeScript?");

    // Verify we got text in turn 2
    const turn2TextDeltas = eventsOfType(turn2.events, "text_delta");
    expect(turn2TextDeltas.length).toBeGreaterThan(0);
    expect(turn2.text.length).toBeGreaterThan(0);

    const turn2Ends = eventsOfType(turn2.events, "turn_end");
    expect(turn2Ends.length).toBeGreaterThanOrEqual(1);

    // Provider should have received at least 2 completion requests
    const completionReqs = env.provider.requests.filter((r) => r.url === "/v1/chat/completions");
    expect(completionReqs.length).toBeGreaterThanOrEqual(2);

    // The last request should contain conversation history from first turn
    const laterReq = completionReqs[completionReqs.length - 1]!;
    const body = laterReq.body as any;
    expect(body.messages).toBeDefined();

    // The message array should contain messages from both turns
    // (system + user1 + assistant1 + user2 = at least 4 messages)
    expect(body.messages.length).toBeGreaterThanOrEqual(4);

    // Should have multiple user messages in history
    const userMsgs = body.messages.filter((m: any) => m.role === "user");
    expect(userMsgs.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Test 4: Large context compaction ───────────────────────────

describe("E2E Flows: Large context compaction", () => {
  let env: TestEnv;

  beforeEach(async () => {
    // Use an extremely small context window (500 tokens ~ 1750 chars) and large
    // tool results to force the emergency prune path (synchronous, no LLM call).
    // Emergency prune fires at 95% of context with > 6 messages.
    env = await createTestEnv({
      inProcess: true,
      contextWindowSize: 500,
      tools: {
        // Each tool result will be ~600 chars to fill the tiny window fast
        bashCommands: {
          cat: "X".repeat(600),
        },
      },
      configOverrides: {
        systemPromptOverride: "T",
        compactThreshold: 0.3,
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

  test("compaction events emitted when context fills up after many tool turns", async () => {
    // Build up messages through multiple tool turns.
    // Each tool turn adds 2 messages (assistant tool_use + tool result).
    // We need > 6 messages (EMERGENCY_MIN_MESSAGES) and > 95% of 500 tokens.
    // 4 tool turns = 8 messages + 1 user msg + 1 text = 10 messages.
    // 4 tool results * 600 chars = 2400 chars alone => ~686 tokens >> 500.

    env.provider.addToolCallResponse([
      { name: "Bash", arguments: { command: "cat f1", description: "f1" } },
    ]);
    env.provider.addToolCallResponse([
      { name: "Bash", arguments: { command: "cat f2", description: "f2" } },
    ]);
    env.provider.addToolCallResponse([
      { name: "Bash", arguments: { command: "cat f3", description: "f3" } },
    ]);
    env.provider.addToolCallResponse([
      { name: "Bash", arguments: { command: "cat f4", description: "f4" } },
    ]);
    // After 4 tool turns, respond with text
    env.provider.addResponse(
      "Done reading all four files and here is the summary of their combined contents for review.",
    );
    // Buffer responses for second turn and any retries
    env.provider.addResponse(
      "Follow-up analysis after compaction occurred and context was pruned to fit the small window.",
    );
    env.provider.addResponse(
      "Extra buffer response in case more model calls happen during the compaction recovery phase.",
    );
    env.provider.addResponse(
      "Another buffer response to ensure the test does not run out of scripted provider responses.",
    );

    const cm = new ConversationManager(env.config, env.registry);

    // First user message: triggers 4 tool calls, building up 10+ messages
    const turn1 = await sendAndCollect(cm, "Read all four files");

    // Second user message: context is way over the 500-token window,
    // should trigger compaction (either regular prune or emergency prune)
    const turn2 = await sendAndCollect(cm, "Analyze them");

    // Combine events from both turns to check for compaction
    const allEvents = [...turn1.events, ...turn2.events];
    const compactionStarts = eventsOfType(allEvents, "compaction_start");
    const compactionEnds = eventsOfType(allEvents, "compaction_end");

    // With 500-token window and ~2400 chars of tool results alone,
    // compaction (regular or emergency) must be triggered
    expect(compactionStarts.length).toBeGreaterThanOrEqual(1);
    expect(compactionEnds.length).toBeGreaterThanOrEqual(1);

    // Compaction end should report the method used
    if (compactionEnds.length > 0) {
      expect(["llm", "pruned", "compressed"]).toContain(compactionEnds[0]!.method);
    }
  });
});

// ─── Test 5: Provider error handling ────────────────────────────

describe("E2E Flows: Provider error handling", () => {
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

  test("HTTP 500 emits error event without crashing", async () => {
    env.provider.addErrorResponse("Internal server error: model overloaded");

    const cm = new ConversationManager(env.config, env.registry);
    const { events } = await sendAndCollect(cm, "This request should trigger a server error");

    // Should have an error event
    const errors = eventsOfType(events, "error");
    expect(errors.length).toBeGreaterThan(0);

    // Should have a turn_end with error stop reason
    const turnEnds = eventsOfType(events, "turn_end");
    const errorEnd = turnEnds.find((e) => e.stopReason === "error");
    expect(errorEnd).toBeDefined();

    // The event stream should complete (no hang/crash)
    expect(events.length).toBeGreaterThan(0);
  });
});

// ─── Test 6: Empty response handling ────────────────────────────

describe("E2E Flows: Empty response handling", () => {
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

  test("empty text response completes turn without crash", async () => {
    // Queue empty responses (original + retries since conversation.ts may retry)
    env.provider.addResponse("");
    env.provider.addResponse("");
    env.provider.addResponse("");

    const cm = new ConversationManager(env.config, env.registry);
    const { events } = await sendAndCollect(cm, "Say nothing");

    // Turn should complete regardless of empty content
    const turnEnds = eventsOfType(events, "turn_end");
    expect(turnEnds.length).toBeGreaterThanOrEqual(1);

    // Should not crash — events array should exist
    expect(events.length).toBeGreaterThan(0);

    // The turn_end stop reason should be defined
    expect(turnEnds[turnEnds.length - 1]!.stopReason).toBeDefined();
  });
});

// ─── Test 7: Tool use with Glob and Grep ────────────────────────

describe("E2E Flows: Glob and Grep tool use", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({
      inProcess: true,
      tools: {
        globResults: ["src/index.ts", "src/core/config.ts", "src/core/types.ts"],
        grepResults:
          "src/core/config.ts:42:  apiBase: string;\nsrc/core/types.ts:10:  apiBase: string;",
      },
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

  test("Glob and Grep both execute and return results to model", async () => {
    // Step 1: Model calls Glob to find files
    env.provider.addToolCallResponse([{ name: "Glob", arguments: { pattern: "**/*.ts" } }]);
    // Step 2: After seeing Glob results, model calls Grep to search contents
    env.provider.addToolCallResponse([
      { name: "Grep", arguments: { pattern: "apiBase", path: "src/core" } },
    ]);
    // Step 3: Model responds with analysis
    env.provider.addResponse(
      "I found 3 TypeScript files and the apiBase field is defined in config.ts and types.ts in the codebase.",
    );
    // Extra buffer responses in case of retries
    env.provider.addResponse(
      "Additional analysis of the apiBase usage across the codebase shows consistent patterns in configuration.",
    );

    const cm = new ConversationManager(env.config, env.registry);
    const { events, text } = await sendAndCollect(
      cm,
      "Find all TypeScript files and search for apiBase",
    );

    // Both tools should have executed
    const toolExecs = eventsOfType(events, "tool_executing");
    expect(toolExecs.length).toBe(2);
    expect(toolExecs[0]!.name).toBe("Glob");
    expect(toolExecs[1]!.name).toBe("Grep");

    // Glob result should contain the file list
    const toolResults = eventsOfType(events, "tool_result");
    expect(toolResults.length).toBe(2);

    const globResult = toolResults.find((r) => r.name === "Glob");
    expect(globResult).toBeDefined();
    expect(globResult!.result).toContain("src/index.ts");
    expect(globResult!.result).toContain("src/core/config.ts");

    // Grep result should contain the matches
    const grepResult = toolResults.find((r) => r.name === "Grep");
    expect(grepResult).toBeDefined();
    expect(grepResult!.result).toContain("apiBase");

    // Final text response
    expect(text).toContain("TypeScript files");

    // Provider should have received at least 3 requests (Glob, Grep, final text)
    const completionReqs = env.provider.requests.filter((r) => r.url === "/v1/chat/completions");
    expect(completionReqs.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── Test 8: Thinking/reasoning mode ────────────────────────────

describe("E2E Flows: Thinking/reasoning mode", () => {
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

  test("thinking_delta events emitted for reasoning content", async () => {
    env.provider.addThinkingResponse(
      "First I need to consider the trade-offs between approach A and approach B. Approach A is faster but less maintainable. Approach B requires more upfront work but scales better in the long run.",
      "After careful analysis, I recommend approach B because it provides better long-term maintainability and scalability for your project.",
    );

    const cm = new ConversationManager(env.config, env.registry);
    const { events, text, thinking } = await sendAndCollect(
      cm,
      "Which approach should I use for this refactoring?",
    );

    // Should have thinking_delta events with the reasoning content
    const thinkingDeltas = eventsOfType(events, "thinking_delta");
    expect(thinkingDeltas.length).toBeGreaterThan(0);
    expect(thinking).toContain("trade-offs");
    expect(thinking).toContain("approach A");

    // Should also have text_delta events with the final answer
    const textDeltas = eventsOfType(events, "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(text).toContain("recommend approach B");

    // Turn should complete normally
    const turnEnds = eventsOfType(events, "turn_end");
    expect(turnEnds.length).toBeGreaterThanOrEqual(1);
  });
});
