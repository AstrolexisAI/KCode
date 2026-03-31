// KCode - Conversation Manager Tests
// Tests for the core conversation loop, state management, checkpoints, and error handling

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ConversationManager } from "./conversation";
import type { StreamEvent } from "./types";
import { createTestEnv, type TestEnv } from "../test-harness/test-env";

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

// ─── State Management ───────────────────────────────────────────

describe("ConversationManager: state management", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({ inProcess: true });
  });
  afterEach(async () => { await env.cleanup(); });

  test("constructor initializes empty state", () => {
    const cm = new ConversationManager(env.config, env.registry);
    const state = cm.getState();
    expect(state.messages).toHaveLength(0);
    expect(state.tokenCount).toBe(0);
    expect(state.toolUseCount).toBe(0);
  });

  test("constructor does not mutate original config", () => {
    const original = { ...env.config, maxTokens: 1000 };
    const cm = new ConversationManager(original, env.registry);
    // Model profile adjustments may change maxTokens on the internal copy
    // but should not affect the original
    expect(original.maxTokens).toBe(1000);
  });

  test("getUsage starts at zero", () => {
    const cm = new ConversationManager(env.config, env.registry);
    const usage = cm.getUsage();
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
  });

  test("getSessionId returns a non-empty string", () => {
    const cm = new ConversationManager(env.config, env.registry);
    expect(cm.getSessionId()).toBeTruthy();
    expect(typeof cm.getSessionId()).toBe("string");
  });

  test("setSessionId overrides session ID", () => {
    const cm = new ConversationManager(env.config, env.registry);
    cm.setSessionId("custom-id");
    expect(cm.getSessionId()).toBe("custom-id");
  });

  test("reset clears messages, usage, and tool count", async () => {
    env.provider.addResponse("Hello!");
    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "Hi");

    expect(cm.getState().messages.length).toBeGreaterThan(0);

    cm.reset();

    expect(cm.getState().messages).toHaveLength(0);
    expect(cm.getState().tokenCount).toBe(0);
    expect(cm.getState().toolUseCount).toBe(0);
    expect(cm.getUsage().inputTokens).toBe(0);
    expect(cm.getUsage().outputTokens).toBe(0);
  });

  test("isRunning is false when idle", () => {
    const cm = new ConversationManager(env.config, env.registry);
    expect(cm.isRunning).toBe(false);
  });
});

// ─── Basic Conversation Flow ────────────────────────────────────

describe("ConversationManager: basic flow", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({ inProcess: true });
  });
  afterEach(async () => { await env.cleanup(); });

  test("text-only response produces turn_start and turn_end", async () => {
    env.provider.addResponse("Hello, I can help!");
    const cm = new ConversationManager(env.config, env.registry);
    const { events, text } = await sendAndCollect(cm, "Hi");

    expect(eventsOfType(events, "turn_start").length).toBeGreaterThanOrEqual(1);
    expect(eventsOfType(events, "turn_end").length).toBeGreaterThanOrEqual(1);
    expect(text).toContain("Hello");
  });

  test("messages are added to state after conversation", async () => {
    env.provider.addResponse("Response text.");
    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "User message");

    const state = cm.getState();
    // Should have user message + assistant message
    expect(state.messages.length).toBeGreaterThanOrEqual(2);
    expect(state.messages[0]!.role).toBe("user");
  });

  test("usage is updated after conversation", async () => {
    env.provider.addResponse("Some output text.");
    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "Hello");

    const usage = cm.getUsage();
    // FakeProvider reports usage, so at least some tokens should be counted
    expect(usage.inputTokens + usage.outputTokens).toBeGreaterThan(0);
  });

  test("multi-turn conversation preserves history", async () => {
    env.provider.addResponse("First response.");
    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "First message");

    env.provider.addResponse("Second response.");
    await sendAndCollect(cm, "Second message");

    const state = cm.getState();
    // user1, assistant1, user2, assistant2
    expect(state.messages.length).toBeGreaterThanOrEqual(4);
  });
});

// ─── Tool Execution ─────────────────────────────────────────────

describe("ConversationManager: tool execution", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({ inProcess: true });
  });
  afterEach(async () => { await env.cleanup(); });

  test("tool call followed by text response", async () => {
    env.provider.addToolCallResponse([
      { name: "Read", arguments: { file_path: "/tmp/test.txt" } },
    ]);
    env.provider.addResponse("File read successfully.");
    const cm = new ConversationManager(env.config, env.registry);
    const { events } = await sendAndCollect(cm, "Read the file");

    const toolExecs = eventsOfType(events, "tool_executing");
    expect(toolExecs.length).toBe(1);
    expect(toolExecs[0]!.name).toBe("Read");

    const toolResults = eventsOfType(events, "tool_result");
    expect(toolResults.length).toBe(1);
  });

  test("parallel read-only tool calls", async () => {
    env.provider.addToolCallResponse([
      { name: "Read", arguments: { file_path: "/tmp/a.txt" } },
      { name: "Read", arguments: { file_path: "/tmp/b.txt" } },
    ]);
    env.provider.addResponse("Read both files.");
    const cm = new ConversationManager(env.config, env.registry);
    const { events } = await sendAndCollect(cm, "Read both files");

    const toolExecs = eventsOfType(events, "tool_executing");
    expect(toolExecs.length).toBe(2);
  });

  test("tool use count increments", async () => {
    env.provider.addToolCallResponse([
      { name: "Read", arguments: { file_path: "/tmp/test.txt" } },
    ]);
    env.provider.addResponse("Done.");
    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "Read it");

    expect(cm.getState().toolUseCount).toBeGreaterThanOrEqual(1);
  });

  test("disallowed tools are blocked", async () => {
    env.provider.addToolCallResponse([
      { name: "Bash", arguments: { command: "ls", description: "list" } },
    ]);
    env.provider.addResponse("Bash is blocked.");
    const cm = new ConversationManager({
      ...env.config,
      disallowedTools: ["Bash"],
    }, env.registry);
    const { events } = await sendAndCollect(cm, "List files");

    const toolExecs = eventsOfType(events, "tool_executing");
    expect(toolExecs.length).toBe(0);
  });

  test("write tool records to env.writes", async () => {
    env.provider.addToolCallResponse([
      { name: "Write", arguments: { file_path: "/tmp/output.txt", content: "hello" } },
    ]);
    env.provider.addResponse("Written.");
    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "Write a file");

    expect(env.writes.length).toBe(1);
    expect(env.writes[0]!.filePath).toBe("/tmp/output.txt");
    expect(env.writes[0]!.content).toBe("hello");
  });
});

// ─── Abort Handling ─────────────────────────────────────────────

describe("ConversationManager: abort", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({ inProcess: true });
  });
  afterEach(async () => { await env.cleanup(); });

  test("abort sets isRunning to false", async () => {
    env.provider.addResponse("This is a response.");
    const cm = new ConversationManager(env.config, env.registry);

    const gen = cm.sendMessage("Hello");
    const first = await gen.next();
    expect(first.done).toBe(false);

    cm.abort();

    // Drain remaining events
    const events: StreamEvent[] = [];
    let result = await gen.next();
    while (!result.done) {
      events.push(result.value);
      result = await gen.next();
    }

    expect(cm.isRunning).toBe(false);
  });
});

// ─── Checkpoints ────────────────────────────────────────────────

describe("ConversationManager: checkpoints", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({ inProcess: true });
  });
  afterEach(async () => { await env.cleanup(); });

  test("saveCheckpoint stores checkpoint", () => {
    const cm = new ConversationManager(env.config, env.registry);
    cm.saveCheckpoint("test-cp");
    expect(cm.getCheckpointCount()).toBe(1);
  });

  test("listCheckpoints returns checkpoint info", () => {
    const cm = new ConversationManager(env.config, env.registry);
    cm.saveCheckpoint("cp1");
    cm.saveCheckpoint("cp2");

    const cps = cm.listCheckpoints();
    expect(cps).toHaveLength(2);
    expect(cps[0]!.label).toBe("cp1");
    expect(cps[1]!.label).toBe("cp2");
    expect(cps[0]!.index).toBe(0);
    expect(cps[1]!.index).toBe(1);
  });

  test("checkpoint caps at MAX_CHECKPOINTS", () => {
    const cm = new ConversationManager(env.config, env.registry);
    for (let i = 0; i < 15; i++) {
      cm.saveCheckpoint(`cp${i}`);
    }
    expect(cm.getCheckpointCount()).toBeLessThanOrEqual(10);
  });

  test("rewindToCheckpoint returns null when no checkpoints", () => {
    const cm = new ConversationManager(env.config, env.registry);
    expect(cm.rewindToCheckpoint()).toBeNull();
  });

  test("rewindToCheckpoint truncates messages", async () => {
    env.provider.addResponse("First.");
    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "msg1");
    const cpCountAfterFirst = cm.getCheckpointCount();
    cm.saveCheckpoint("after-first");

    env.provider.addResponse("Second.");
    await sendAndCollect(cm, "msg2");

    const msgCountBefore = cm.getState().messages.length;
    // Rewind to our "after-first" checkpoint (agent loop may auto-save checkpoints too)
    const result = cm.rewindToCheckpoint(cpCountAfterFirst);

    expect(result).not.toBeNull();
    expect(result).toContain("after-first");
    expect(cm.getState().messages.length).toBeLessThan(msgCountBefore);
  });

  test("rewindToCheckpoint with invalid index returns error string", () => {
    const cm = new ConversationManager(env.config, env.registry);
    cm.saveCheckpoint("cp1");
    const result = cm.rewindToCheckpoint(99);
    expect(result).toContain("Invalid checkpoint index");
  });
});

// ─── collectSessionData ─────────────────────────────────────────

describe("ConversationManager: collectSessionData", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({ inProcess: true });
  });
  afterEach(async () => { await env.cleanup(); });

  test("collects tools used and files modified", async () => {
    env.provider.addToolCallResponse([
      { name: "Write", arguments: { file_path: "/tmp/a.txt", content: "test" } },
    ]);
    env.provider.addToolCallResponse([
      { name: "Read", arguments: { file_path: "/tmp/a.txt" } },
    ]);
    env.provider.addResponse("Done.");
    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "Create and read");

    const data = cm.collectSessionData();
    expect(data.toolsUsed).toContain("Write");
    expect(data.toolsUsed).toContain("Read");
    expect(data.filesModified).toContain("/tmp/a.txt");
  });

  test("deduplicates files modified", async () => {
    env.provider.addToolCallResponse([
      { name: "Write", arguments: { file_path: "/tmp/same.txt", content: "v1" } },
    ]);
    env.provider.addToolCallResponse([
      { name: "Write", arguments: { file_path: "/tmp/same.txt", content: "v2" } },
    ]);
    env.provider.addResponse("Done.");
    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "Write twice");

    const data = cm.collectSessionData();
    const count = data.filesModified.filter(f => f === "/tmp/same.txt").length;
    expect(count).toBe(1);
  });

  test("counts errors", async () => {
    // Register a tool that always fails
    env.registry.register("FailTool", {
      name: "FailTool",
      description: "Always fails",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    }, async () => ({
      tool_use_id: "",
      content: "Error: something went wrong",
      is_error: true,
    }));

    env.provider.addToolCallResponse([
      { name: "FailTool", arguments: {} },
    ]);
    env.provider.addResponse("Failed.");
    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "Try the tool");

    const data = cm.collectSessionData();
    expect(data.errorsEncountered).toBeGreaterThan(0);
  });

  test("returns correct project directory", () => {
    const cm = new ConversationManager(env.config, env.registry);
    const data = cm.collectSessionData();
    expect(data.project).toBe(env.config.workingDirectory);
  });
});

// ─── getModifiedFiles ───────────────────────────────────────────

describe("ConversationManager: getModifiedFiles", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({ inProcess: true });
  });
  afterEach(async () => { await env.cleanup(); });

  test("extracts file paths from Write tool calls", async () => {
    env.provider.addToolCallResponse([
      { name: "Write", arguments: { file_path: "/tmp/file1.txt", content: "a" } },
    ]);
    env.provider.addToolCallResponse([
      { name: "Write", arguments: { file_path: "/tmp/file2.txt", content: "b" } },
    ]);
    env.provider.addResponse("Done.");
    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "Write files");

    const files = cm.getModifiedFiles();
    expect(files).toContain("/tmp/file1.txt");
    expect(files).toContain("/tmp/file2.txt");
  });

  test("returns empty array when no writes", async () => {
    env.provider.addResponse("Just text.");
    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "Hello");

    const files = cm.getModifiedFiles();
    expect(files).toHaveLength(0);
  });
});

// ─── Error Handling ─────────────────────────────────────────────

describe("ConversationManager: error handling", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({ inProcess: true, configOverrides: { maxRetries: 0 } });
  });
  afterEach(async () => { await env.cleanup(); });

  test("API error produces error event", async () => {
    env.provider.addErrorResponse("Server error");
    const cm = new ConversationManager(env.config, env.registry);
    const { events } = await sendAndCollect(cm, "Hello");

    const errors = eventsOfType(events, "error");
    expect(errors.length).toBeGreaterThan(0);
  });

  test("error event includes retryable flag", async () => {
    env.provider.addErrorResponse("Bad request");
    const cm = new ConversationManager(env.config, env.registry);
    const { events } = await sendAndCollect(cm, "Hello");

    const errors = eventsOfType(events, "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(typeof errors[0]!.retryable).toBe("boolean");
  });
});

// ─── Max Tokens Continue ────────────────────────────────────────

describe("ConversationManager: truncation handling", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({ inProcess: true });
  });
  afterEach(async () => { await env.cleanup(); });

  test("max_tokens response triggers continuation", async () => {
    env.provider.addMaxTokensResponse("This was truncated due to");
    env.provider.addResponse("the token limit. Here is the rest.");
    const cm = new ConversationManager(env.config, env.registry);
    const { events, text } = await sendAndCollect(cm, "Long response please");

    // Should have at least 2 turns
    const turnStarts = eventsOfType(events, "turn_start");
    expect(turnStarts.length).toBeGreaterThanOrEqual(2);
    expect(text).toContain("truncated");
  });
});

// ─── Session Restore ────────────────────────────────────────────

describe("ConversationManager: session restore", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({ inProcess: true });
  });
  afterEach(async () => { await env.cleanup(); });

  test("restoreMessages loads previous history", () => {
    const cm = new ConversationManager(env.config, env.registry);
    cm.restoreMessages([
      { role: "user", content: "Previous message" },
      { role: "assistant", content: [{ type: "text", text: "Previous response" }] },
    ]);

    expect(cm.getState().messages).toHaveLength(2);
    expect(cm.getState().messages[0]!.role).toBe("user");
  });

  test("conversation continues after restore", async () => {
    const cm = new ConversationManager(env.config, env.registry);
    cm.restoreMessages([
      { role: "user", content: "Previous message" },
      { role: "assistant", content: [{ type: "text", text: "Previous response" }] },
    ]);

    env.provider.addResponse("Continuing from where we left off.");
    const { text } = await sendAndCollect(cm, "Continue");

    expect(text).toContain("Continuing");
    expect(cm.getState().messages.length).toBeGreaterThan(2);
  });
});

// ─── Fork Conversation ──────────────────────────────────────────

describe("ConversationManager: fork", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({ inProcess: true });
  });
  afterEach(async () => { await env.cleanup(); });

  test("forkConversation creates new session ID", async () => {
    env.provider.addResponse("Message 1.");
    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "Hello");

    const originalId = cm.getSessionId();
    const fork = cm.forkConversation();

    expect(fork.sessionId).not.toBe(originalId);
    expect(cm.getSessionId()).not.toBe(originalId);
  });

  test("forkConversation with keepMessages limits history", async () => {
    env.provider.addResponse("Msg 1.");
    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "Hello 1");

    env.provider.addResponse("Msg 2.");
    await sendAndCollect(cm, "Hello 2");

    const totalBefore = cm.getState().messages.length;
    const fork = cm.forkConversation(2);

    expect(cm.getState().messages.length).toBeLessThanOrEqual(2);
    expect(fork.messageCount).toBeLessThanOrEqual(2);
  });
});

// ─── Abort During Tool Execution (H4 fix) ──────────────────────

describe("ConversationManager: abort during tool execution", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({ inProcess: true });
  });
  afterEach(async () => { await env.cleanup(); });

  test("abort mid-tool-execution terminates generator cleanly", async () => {
    // Register a tool that we can abort during
    let handlerCalled = false;
    env.registry.register("SlowTool", {
      name: "SlowTool",
      description: "A tool that takes a while",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    }, async () => {
      handlerCalled = true;
      await new Promise((r) => setTimeout(r, 50));
      return { tool_use_id: "", content: "done", is_error: false };
    });

    env.provider.addToolCallResponse([
      { name: "SlowTool", arguments: {} },
    ]);
    env.provider.addResponse("Finished.");

    const cm = new ConversationManager(env.config, env.registry);
    const gen = cm.sendMessage("Run slow tool");

    // Drain a few events to let the loop start, then abort
    const events: StreamEvent[] = [];
    let aborted = false;
    let eventCount = 0;
    for await (const event of gen) {
      events.push(event);
      eventCount++;
      // Abort after the first couple of events (turn_start, text_delta, etc.)
      if (eventCount >= 2 && !aborted) {
        cm.abort();
        aborted = true;
      }
    }

    // Generator should have terminated without throwing
    expect(aborted).toBe(true);
    expect(cm.isRunning).toBe(false);
    // Should not crash — just verify we got here
  });
});

// ─── Burned Fingerprints ────────────────────────────────────────

describe("ConversationManager: burnedFingerprints", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({ inProcess: true });
  });
  afterEach(async () => { await env.cleanup(); });

  test("tool that fails with same error is blocked on subsequent call", async () => {
    // Override Glob (read-only, auto-approved by permission system) to always fail.
    // Due to dual recording of error fingerprints (at yield site + agent loop),
    // a single failure immediately burns the fingerprint. The second call is blocked.
    let callCount = 0;
    env.registry.register("Glob", {
      name: "Glob",
      description: "Find files (fake, always fails)",
      input_schema: { type: "object" as const, properties: { pattern: { type: "string" } }, required: ["pattern"] },
    }, async () => {
      callCount++;
      return {
        tool_use_id: "",
        content: "Error: connection refused to host xyz",
        is_error: true,
      };
    });

    // Turn 1: Glob fails -> fingerprint gets burned
    env.provider.addToolCallResponse([{ name: "Glob", arguments: { pattern: "*.ts" } }]);
    // Turn 2: Glob again -> should be BLOCKED before execution
    env.provider.addToolCallResponse([{ name: "Glob", arguments: { pattern: "*.ts" } }]);
    // Final text response
    env.provider.addResponse("OK, I will try something else.");

    const cm = new ConversationManager(env.config, env.registry);
    const { events } = await sendAndCollect(cm, "Use the tool");

    // Handler called exactly once (second call blocked)
    expect(callCount).toBe(1);

    // Verify the BLOCKED message is in the conversation state (it's not yielded as an event)
    const state = cm.getState();
    const userMessages = state.messages.filter((m) => m.role === "user");
    const hasBlocked = userMessages.some((m) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return content.includes("BLOCKED");
    });
    expect(hasBlocked).toBe(true);
  });
});

// ─── Error Fingerprint Dedup (different errors NOT blocked) ─────

describe("ConversationManager: error fingerprint dedup", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({ inProcess: true });
  });
  afterEach(async () => { await env.cleanup(); });

  test("different tools failing with different errors are not cross-blocked", async () => {
    // Override Glob and Grep (both read-only, auto-approved) to each fail once
    // with different errors. Since burned fingerprints are tracked per tool name,
    // Glob's failure should not block Grep and vice versa.
    let globCalls = 0;
    let grepCalls = 0;
    env.registry.register("Glob", {
      name: "Glob",
      description: "Fails with connection error",
      input_schema: { type: "object" as const, properties: { pattern: { type: "string" } }, required: ["pattern"] },
    }, async () => {
      globCalls++;
      return { tool_use_id: "", content: "Error: connection refused to remote server", is_error: true };
    });
    env.registry.register("Grep", {
      name: "Grep",
      description: "Fails with permission error",
      input_schema: { type: "object" as const, properties: { pattern: { type: "string" } }, required: ["pattern"] },
    }, async () => {
      grepCalls++;
      return { tool_use_id: "", content: "Error: permission denied for target directory", is_error: true };
    });

    // Glob fails, then Grep fails — each tool fails once with its own error
    env.provider.addToolCallResponse([{ name: "Glob", arguments: { pattern: "*.ts" } }]);
    env.provider.addToolCallResponse([{ name: "Grep", arguments: { pattern: "TODO" } }]);
    env.provider.addResponse("Both tools failed with different errors.");

    const cm = new ConversationManager(env.config, env.registry);
    const { events } = await sendAndCollect(cm, "Try both tools");

    // Both tools should have been called (Glob's burn doesn't affect Grep)
    expect(globCalls).toBe(1);
    expect(grepCalls).toBe(1);

    // No BLOCKED messages in conversation state
    const state = cm.getState();
    const userMessages = state.messages.filter((m) => m.role === "user");
    const hasBlocked = userMessages.some((m) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return content.includes("BLOCKED");
    });
    expect(hasBlocked).toBe(false);
  });
});

// ─── Fallback Chain ─────────────────────────────────────────────

describe("ConversationManager: fallback chain", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({
      inProcess: true,
      configOverrides: {
        maxRetries: 1, // Allow one retry so it tries fallback
        fallbackModel: "fake-model", // Same fake-model will serve the fallback
      },
    });
  });
  afterEach(async () => { await env.cleanup(); });

  test("falls back to secondary model when primary fails", async () => {
    // First request fails, second (fallback) succeeds
    env.provider.addErrorResponse("Primary model overloaded");
    env.provider.addResponse("Response from fallback model.");

    const cm = new ConversationManager(env.config, env.registry);
    const { events, text } = await sendAndCollect(cm, "Hello");

    // Should have completed with text from fallback
    expect(text).toContain("fallback");
    const turnEnds = eventsOfType(events, "turn_end");
    expect(turnEnds.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Max Turns Enforcement ──────────────────────────────────────

describe("ConversationManager: max turns enforcement", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({
      inProcess: true,
      configOverrides: {
        effortLevel: "low", // low effort = 5 max turns
      },
    });
  });
  afterEach(async () => { await env.cleanup(); });

  test("loop stops after exceeding max agent turns", async () => {
    // Queue many tool call + text responses to keep the loop going
    for (let i = 0; i < 10; i++) {
      env.provider.addToolCallResponse([
        { name: "Read", arguments: { file_path: `/tmp/file${i}.txt` } },
      ]);
    }
    // Final response after force-stop injection
    env.provider.addResponse("OK, I will stop now.");

    const cm = new ConversationManager(env.config, env.registry);
    const { events } = await sendAndCollect(cm, "Read all the files");

    // Count how many tool_executing events occurred
    const toolExecs = eventsOfType(events, "tool_executing");
    // With effortLevel "low" the limit is 5 turns. The loop allows effectiveMaxTurns + 1
    // for the force-stop turn, then hard-kills. So tool executions should be <= 7.
    expect(toolExecs.length).toBeLessThanOrEqual(7);

    // Should have a force_stop turn_end
    const turnEnds = eventsOfType(events, "turn_end");
    const forceStops = turnEnds.filter((e) => e.stopReason === "force_stop");
    expect(forceStops.length).toBeGreaterThanOrEqual(1);
  });
});
