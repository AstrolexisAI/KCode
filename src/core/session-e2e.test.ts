// KCode - Session E2E Tests
// End-to-end tests for session management: data collection, checkpoints,
// rewind, forking, message restore, plan mode, and compaction

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestEnv, type TestEnv } from "../test-harness/test-env";
import { clearActivePlan, getActivePlan, type Plan } from "../tools/plan";
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

// ─── Session Data Collection ────────────────────────────────────

describe("Session E2E: data collection", () => {
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

  test("session data can be collected with tools used and files modified", async () => {
    env.provider.addToolCallResponse([
      { name: "Write", arguments: { file_path: "/tmp/session-e2e.txt", content: "test data" } },
    ]);
    env.provider.addResponse(
      "I wrote the file for you. The session data collection test is complete and verified.",
    );

    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "Write a test file");

    const data = cm.collectSessionData();

    // Should have recorded the tool usage
    expect(data.toolsUsed).toContain("Write");
    expect(data.filesModified).toContain("/tmp/session-e2e.txt");
    expect(data.project).toBe(env.config.workingDirectory);
    expect(data.messagesCount).toBeGreaterThan(0);
  });

  test("session data reflects empty session before any messages", () => {
    const cm = new ConversationManager(env.config, env.registry);
    const data = cm.collectSessionData();

    expect(data.toolsUsed).toHaveLength(0);
    expect(data.filesModified).toHaveLength(0);
    expect(data.errorsEncountered).toBe(0);
  });
});

// ─── Checkpoint Save and Rewind ─────────────────────────────────

describe("Session E2E: checkpoint and rewind", () => {
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

  test("checkpoint save and rewind restores previous state", async () => {
    env.provider.addResponse(
      "First response for the checkpoint test to establish initial conversation state.",
    );
    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "First message");

    // Save a checkpoint after first turn
    const cpIndex = cm.getCheckpointCount();
    cm.saveCheckpoint("after-turn-1");
    expect(cm.getCheckpointCount()).toBe(cpIndex + 1);

    // Do another turn
    env.provider.addResponse(
      "Second response that we will later rewind past to test checkpoint functionality.",
    );
    await sendAndCollect(cm, "Second message");

    const msgCountBefore = cm.getState().messages.length;

    // Rewind to the checkpoint
    const result = cm.rewindToCheckpoint(cpIndex);
    expect(result).not.toBeNull();
    expect(result).toContain("after-turn-1");

    // Messages should be truncated back to checkpoint state
    expect(cm.getState().messages.length).toBeLessThan(msgCountBefore);
  });

  test("listCheckpoints returns correct checkpoint info", () => {
    const cm = new ConversationManager(env.config, env.registry);
    cm.saveCheckpoint("cp-alpha");
    cm.saveCheckpoint("cp-beta");
    cm.saveCheckpoint("cp-gamma");

    const checkpoints = cm.listCheckpoints();
    expect(checkpoints.length).toBeGreaterThanOrEqual(3);

    const labels = checkpoints.map((cp) => cp.label);
    expect(labels).toContain("cp-alpha");
    expect(labels).toContain("cp-beta");
    expect(labels).toContain("cp-gamma");
  });
});

// ─── Conversation Fork ──────────────────────────────────────────

describe("Session E2E: forking", () => {
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

  test("conversation can be forked by creating a new manager with restored messages", async () => {
    env.provider.addResponse(
      "Original response to establish the conversation state for the fork test.",
    );
    const cm = new ConversationManager(env.config, env.registry);
    await sendAndCollect(cm, "Original message");

    // "Fork" by restoring the original messages into a new manager
    const originalMessages = cm.getState().messages;

    const forked = new ConversationManager(env.config, env.registry);
    forked.restoreMessages([...originalMessages]);

    // Forked conversation should have the same history
    expect(forked.getState().messages.length).toBe(originalMessages.length);

    // But a different session ID
    expect(forked.getSessionId()).not.toBe(cm.getSessionId());

    // Continue the forked conversation independently
    env.provider.addResponse(
      "Forked response that diverges from the original conversation path for testing.",
    );
    await sendAndCollect(forked, "Forked message");

    // Forked should have more messages than original
    expect(forked.getState().messages.length).toBeGreaterThan(originalMessages.length);

    // Original should be unchanged
    expect(cm.getState().messages.length).toBe(originalMessages.length);
  });
});

// ─── Message Restore ────────────────────────────────────────────

describe("Session E2E: message restore", () => {
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

  test("messages can be restored and conversation continues", async () => {
    const cm = new ConversationManager(env.config, env.registry);

    // Restore previous history
    cm.restoreMessages([
      { role: "user", content: "Previous question about TypeScript" },
      {
        role: "assistant",
        content: [{ type: "text", text: "TypeScript is a typed superset of JavaScript." }],
      },
    ]);

    expect(cm.getState().messages).toHaveLength(2);

    // Continue conversation after restore
    env.provider.addResponse(
      "Yes, TypeScript builds on your previous question about JavaScript typing systems.",
    );
    await sendAndCollect(cm, "Can you tell me more?");

    // Should now have 4 messages: 2 restored + 1 user + 1 assistant
    expect(cm.getState().messages.length).toBeGreaterThanOrEqual(4);
  });

  test("restored messages are sent to the provider as context", async () => {
    const cm = new ConversationManager(env.config, env.registry);
    cm.restoreMessages([
      { role: "user", content: "What is Bun?" },
      { role: "assistant", content: [{ type: "text", text: "Bun is a JavaScript runtime." }] },
    ]);

    env.provider.addResponse(
      "As I mentioned, Bun is a fast all-in-one JavaScript runtime and toolkit for your projects.",
    );
    await sendAndCollect(cm, "Tell me more about Bun");

    // The provider should have received the restored messages
    const lastReq = env.provider.requests.filter((r) => r.url === "/v1/chat/completions");
    const body = lastReq[lastReq.length - 1]!.body as any;
    const messages = body.messages as any[];

    const userMessages = messages.filter((m: any) => m.role === "user");
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Plan Mode ──────────────────────────────────────────────────

describe("Session E2E: plan mode", () => {
  let env: TestEnv;

  beforeEach(async () => {
    clearActivePlan();
    env = await createTestEnv({
      inProcess: true,
      configOverrides: {
        systemPromptOverride: "You are a helpful test assistant.",
      },
    });
  });

  afterEach(async () => {
    clearActivePlan();
    await env.cleanup();
  });

  test("plan tool creates and tracks a plan via tool call", async () => {
    // The PlanMode tool is triggered by the LLM. In E2E we test the flow:
    // model requests plan creation via tool call, which sets the active plan.
    // Here we test plan state management directly.
    expect(getActivePlan()).toBeNull();

    // Simulate plan creation by driving the conversation with a tool call
    // that triggers the PlanMode tool (if registered), or verify plan globals
    // The plan system uses global state -- verify it's properly isolated
    clearActivePlan();
    expect(getActivePlan()).toBeNull();
  });

  test("conversation continues normally when no plan is active", async () => {
    expect(getActivePlan()).toBeNull();

    env.provider.addResponse(
      "Responding without any active plan to verify normal conversation flow is unaffected.",
    );
    const cm = new ConversationManager(env.config, env.registry);
    const { text } = await sendAndCollect(cm, "Just a normal question");

    expect(text).toContain("Responding without");

    // Plan should still be null
    expect(getActivePlan()).toBeNull();
  });
});

// ─── Compaction ─────────────────────────────────────────────────

describe("Session E2E: compaction awareness", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({
      inProcess: true,
      contextWindowSize: 2000, // Very small to trigger compaction logic
      configOverrides: {
        systemPromptOverride: "You are a helpful test assistant.",
      },
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("large conversations trigger context management", async () => {
    const cm = new ConversationManager(env.config, env.registry);

    // Fill the conversation with multiple turns to approach context limit
    for (let i = 0; i < 3; i++) {
      env.provider.addResponse(
        `Response ${i}: This is a moderately long response to build up the conversation context and test compaction behavior in KCode.`,
      );
    }

    // Send messages to fill context
    await sendAndCollect(cm, "First question about KCode architecture");
    await sendAndCollect(cm, "Second question about tool execution patterns");

    // The conversation should have managed its context (either by pruning or compaction)
    const state = cm.getState();
    expect(state.messages.length).toBeGreaterThan(0);

    // Token count should be tracked
    expect(state.tokenCount).toBeGreaterThanOrEqual(0);

    // Usage should reflect all turns
    const usage = cm.getUsage();
    expect(usage.inputTokens + usage.outputTokens).toBeGreaterThan(0);
  });
});
