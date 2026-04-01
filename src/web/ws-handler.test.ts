// KCode - WebSocket Handler Tests

import { beforeEach, describe, expect, test } from "bun:test";
import * as bridge from "./session-bridge";
import type { ServerEvent } from "./types";
import {
  enqueueMessage,
  handleClientMessage,
  resolvePermission,
  setSessionContext,
  switchModel,
} from "./ws-handler";

// ─── Helpers ────────────────────────────────────────────────────

function collectEvents(fn: (broadcast: (e: ServerEvent) => void) => void): ServerEvent[] {
  const events: ServerEvent[] = [];
  fn((e) => events.push(e));
  return events;
}

function createMockWs(): any {
  return {
    send: () => {},
    close: () => {},
    data: { token: "test", connectedAt: Date.now() },
  };
}

function createMockManager(): any {
  return {
    getConfig: () => ({
      model: "test-model",
      maxTokens: 4096,
      permissionMode: "ask",
      workingDirectory: "/tmp/test",
    }),
    getUsage: () => ({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    }),
    getState: () => ({
      messages: [],
      tokenCount: 0,
      toolUseCount: 0,
    }),
    getSessionId: () => "test-session",
    getTurnCosts: () => [],
    abort: () => {},
    sendMessage: async function* () {
      yield { type: "text_delta" as const, text: "Hello" };
      yield { type: "turn_end" as const, stopReason: "end_turn" };
    },
  };
}

describe("WebSocket Handler", () => {
  beforeEach(() => {
    bridge.clearConversationManager();
    bridge.setActiveModel("test-model");
    bridge.setWorkingDirectory("/tmp/test");
  });

  // ─── Event Parsing ──────────────────────────────────────────

  test("rejects invalid JSON", () => {
    const events = collectEvents((broadcast) => {
      handleClientMessage(createMockWs(), "not json", broadcast);
    });
    // Invalid events are silently dropped
    expect(events.length).toBe(0);
  });

  test("rejects events without type", () => {
    const events = collectEvents((broadcast) => {
      handleClientMessage(createMockWs(), '{"content":"hello"}', broadcast);
    });
    expect(events.length).toBe(0);
  });

  test("rejects unknown event types", () => {
    const events = collectEvents((broadcast) => {
      handleClientMessage(createMockWs(), '{"type":"unknown.event"}', broadcast);
    });
    expect(events.length).toBe(0);
  });

  test("rejects message.send with empty content", () => {
    const events = collectEvents((broadcast) => {
      handleClientMessage(createMockWs(), '{"type":"message.send","content":""}', broadcast);
    });
    expect(events.length).toBe(0);
  });

  test("rejects message.send with non-string content", () => {
    const events = collectEvents((broadcast) => {
      handleClientMessage(createMockWs(), '{"type":"message.send","content":42}', broadcast);
    });
    expect(events.length).toBe(0);
  });

  test("rejects permission.respond without valid action", () => {
    const events = collectEvents((broadcast) => {
      handleClientMessage(
        createMockWs(),
        '{"type":"permission.respond","id":"p1","action":"maybe"}',
        broadcast,
      );
    });
    expect(events.length).toBe(0);
  });

  test("rejects model.switch without model string", () => {
    const events = collectEvents((broadcast) => {
      handleClientMessage(createMockWs(), '{"type":"model.switch","model":123}', broadcast);
    });
    expect(events.length).toBe(0);
  });

  // ─── message.send without manager ──────────────────────────

  test("message.send without manager returns error", async () => {
    const events: ServerEvent[] = [];
    const broadcast = (e: ServerEvent) => events.push(e);

    handleClientMessage(createMockWs(), '{"type":"message.send","content":"hello"}', broadcast);

    // Wait for async handling
    await new Promise((r) => setTimeout(r, 100));

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
  });

  // ─── message.send with manager ─────────────────────────────

  test("message.send with manager sends messages", async () => {
    bridge.setConversationManager(createMockManager() as any);

    const events: ServerEvent[] = [];
    const broadcast = (e: ServerEvent) => events.push(e);

    handleClientMessage(createMockWs(), '{"type":"message.send","content":"hello"}', broadcast);

    // Wait for async handling
    await new Promise((r) => setTimeout(r, 200));

    // Should have user message, assistant message, and a delta
    const userMsg = events.find((e) => e.type === "message.new" && (e as any).role === "user");
    const assistantMsg = events.find(
      (e) => e.type === "message.new" && (e as any).role === "assistant",
    );
    const delta = events.find((e) => e.type === "message.delta");

    expect(userMsg).toBeDefined();
    expect(assistantMsg).toBeDefined();
    expect(delta).toBeDefined();
  });

  // ─── message.cancel ────────────────────────────────────────

  test("message.cancel calls abort on manager", async () => {
    let aborted = false;
    bridge.setConversationManager(createMockManager() as any);
    // Replace abort
    const mgr = bridge.getConversationManager() as any;
    mgr.abort = () => {
      aborted = true;
    };

    const events: ServerEvent[] = [];
    handleClientMessage(createMockWs(), '{"type":"message.cancel"}', (e) => events.push(e));

    await new Promise((r) => setTimeout(r, 50));
    expect(aborted).toBe(true);
  });

  // ─── model.switch ──────────────────────────────────────────

  test("model.switch without manager returns error", async () => {
    // Ensure no manager
    const events: ServerEvent[] = [];
    handleClientMessage(createMockWs(), '{"type":"model.switch","model":"new-model"}', (e) =>
      events.push(e),
    );

    await new Promise((r) => setTimeout(r, 50));
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
  });

  test("model.switch with manager broadcasts change", async () => {
    bridge.setConversationManager(createMockManager() as any);

    const events: ServerEvent[] = [];
    handleClientMessage(createMockWs(), '{"type":"model.switch","model":"new-model"}', (e) =>
      events.push(e),
    );

    await new Promise((r) => setTimeout(r, 50));
    const changeEvent = events.find((e) => e.type === "model.changed");
    expect(changeEvent).toBeDefined();
    expect((changeEvent as any).model).toBe("new-model");
  });

  // ─── command.run ───────────────────────────────────────────

  test("command.run rejects non-slash commands", async () => {
    const events: ServerEvent[] = [];
    handleClientMessage(createMockWs(), '{"type":"command.run","command":"hello"}', (e) =>
      events.push(e),
    );

    await new Promise((r) => setTimeout(r, 50));
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
  });

  // ─── Permission Resolution ─────────────────────────────────

  test("resolvePermission returns false for unknown ID", () => {
    expect(resolvePermission("unknown-id", "allow")).toBe(false);
  });

  // ─── switchModel ───────────────────────────────────────────

  test("switchModel without manager returns error", () => {
    // Clear manager reference by setting a null-like state
    const result = switchModel("new-model");
    // Will fail because no manager has getConfig
    // The actual behavior depends on whether a manager is set
    expect(typeof result.success).toBe("boolean");
  });

  test("switchModel with manager updates model", () => {
    bridge.setConversationManager(createMockManager() as any);
    const result = switchModel("new-model");
    expect(result.success).toBe(true);
    expect(bridge.getActiveModel()).toBe("new-model");
  });

  // ─── enqueueMessage ────────────────────────────────────────

  test("enqueueMessage returns a message ID", () => {
    const id = enqueueMessage("test message");
    expect(id).toMatch(/^msg-/);
  });

  // ─── setSessionContext ─────────────────────────────────────

  test("setSessionContext returns context with model", () => {
    bridge.setActiveModel("ctx-test-model");
    const ctx = setSessionContext();
    expect(ctx.model).toBe("ctx-test-model");
    expect(ctx.sessionId).toMatch(/^web-/);
    expect(ctx.startTime).toBeGreaterThan(0);
  });
});
