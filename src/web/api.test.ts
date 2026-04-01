// KCode - Web UI REST API Tests

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { handleApiRequest } from "./api";
import * as bridge from "./session-bridge";
import { clearActivePlan } from "../tools/plan";

// ─── Mock Setup ─────────────────────────────────────────────────

// Create a mock conversation manager
function createMockManager(overrides?: Record<string, unknown>) {
  return {
    getConfig: () => ({
      model: "test-model",
      maxTokens: 4096,
      permissionMode: "ask",
      workingDirectory: "/tmp/test",
      effortLevel: "medium",
      compactThreshold: 0.8,
      contextWindowSize: 32000,
      theme: "dark",
      fallbackModel: null,
      pro: false,
      apiKey: "sk-secret-key-do-not-expose",
      anthropicApiKey: "secret-anthropic-key",
    }),
    getUsage: () => ({
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    }),
    getState: () => ({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ],
      tokenCount: 100,
      toolUseCount: 0,
    }),
    getSessionId: () => "test-session-123",
    getTurnCosts: () => [],
    abort: () => {},
    sendMessage: async function* () {
      yield { type: "text_delta", text: "test" };
      yield { type: "turn_end", stopReason: "end_turn" };
    },
    ...overrides,
  };
}

describe("API Endpoints", () => {
  let originalManager: ReturnType<typeof bridge.getConversationManager>;
  let originalModel: string;

  beforeEach(() => {
    originalManager = bridge.getConversationManager();
    originalModel = bridge.getActiveModel();
    bridge.setActiveModel("test-model");
    bridge.setWorkingDirectory("/tmp/test");
    clearActivePlan();
  });

  afterEach(() => {
    // Restore originals — use clearConversationManager to reset to null
    bridge.clearConversationManager();
    if (originalManager) {
      bridge.setConversationManager(originalManager as any);
    }
    bridge.setActiveModel(originalModel);
  });

  // ─── Health ───────────────────────────────────────────────────

  test("GET /api/v1/health returns ok", async () => {
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/health"),
      "/api/v1/health",
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(data.timestamp).toBeGreaterThan(0);
  });

  // ─── Session ──────────────────────────────────────────────────

  test("GET /api/v1/session without manager returns defaults", async () => {
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/session"),
      "/api/v1/session",
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.model).toBe("test-model");
    expect(data.messageCount).toBe(0);
  });

  test("GET /api/v1/session with manager returns session info", async () => {
    bridge.setConversationManager(createMockManager() as any);
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/session"),
      "/api/v1/session",
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.model).toBe("test-model");
    expect(data.inputTokens).toBe(1000);
    expect(data.outputTokens).toBe(500);
    expect(data.messageCount).toBe(3);
    expect(data.sessionId).toBe("test-session-123");
  });

  // ─── Messages ─────────────────────────────────────────────────

  test("GET /api/v1/messages without manager returns empty", async () => {
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/messages"),
      "/api/v1/messages",
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.messages).toEqual([]);
    expect(data.total).toBe(0);
  });

  test("GET /api/v1/messages with manager returns messages", async () => {
    bridge.setConversationManager(createMockManager() as any);
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/messages"),
      "/api/v1/messages",
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(3);
    expect(data.messages.length).toBe(3);
    expect(data.messages[0].role).toBe("user");
  });

  test("GET /api/v1/messages supports pagination", async () => {
    bridge.setConversationManager(createMockManager() as any);
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/messages?limit=1&offset=1"),
      "/api/v1/messages",
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.messages.length).toBe(1);
    expect(data.messages[0].role).toBe("assistant");
    expect(data.offset).toBe(1);
    expect(data.limit).toBe(1);
  });

  test("POST /api/v1/messages without manager returns 503", async () => {
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Hello" }),
      }),
      "/api/v1/messages",
    );
    expect(res.status).toBe(503);
  });

  test("POST /api/v1/messages with invalid body returns 400", async () => {
    bridge.setConversationManager(createMockManager() as any);
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
      "/api/v1/messages",
    );
    expect(res.status).toBe(400);
  });

  test("POST /api/v1/messages with missing content returns 400", async () => {
    bridge.setConversationManager(createMockManager() as any);
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "wrong field" }),
      }),
      "/api/v1/messages",
    );
    expect(res.status).toBe(400);
  });

  // ─── Cancel ───────────────────────────────────────────────────

  test("POST /api/v1/cancel without manager returns 503", async () => {
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/cancel", { method: "POST" }),
      "/api/v1/cancel",
    );
    expect(res.status).toBe(503);
  });

  test("POST /api/v1/cancel with manager calls abort", async () => {
    let aborted = false;
    bridge.setConversationManager(
      createMockManager({
        abort: () => {
          aborted = true;
        },
      }) as any,
    );
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/cancel", { method: "POST" }),
      "/api/v1/cancel",
    );
    expect(res.status).toBe(200);
    expect(aborted).toBe(true);
  });

  // ─── Files ────────────────────────────────────────────────────

  test("GET /api/v1/files/:path prevents path traversal", async () => {
    bridge.setWorkingDirectory("/tmp/test");
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/files/../../etc/passwd"),
      "/api/v1/files/../../etc/passwd",
    );
    expect(res.status).toBe(403);
  });

  test("GET /api/v1/files/:path returns 404 for nonexistent file", async () => {
    bridge.setWorkingDirectory("/tmp/test");
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/files/nonexistent.txt"),
      "/api/v1/files/nonexistent.txt",
    );
    expect(res.status).toBe(404);
  });

  // ─── Stats ────────────────────────────────────────────────────

  test("GET /api/v1/stats without manager returns zeros", async () => {
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/stats"),
      "/api/v1/stats",
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.inputTokens).toBe(0);
    expect(data.outputTokens).toBe(0);
  });

  test("GET /api/v1/stats with manager returns usage data", async () => {
    bridge.setConversationManager(createMockManager() as any);
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/stats"),
      "/api/v1/stats",
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.inputTokens).toBe(1000);
    expect(data.outputTokens).toBe(500);
    expect(data.totalTokens).toBe(1500);
    expect(data.model).toBe("test-model");
  });

  // ─── Config ───────────────────────────────────────────────────

  test("GET /api/v1/config redacts secrets", async () => {
    bridge.setConversationManager(createMockManager() as any);
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/config"),
      "/api/v1/config",
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    // Should NOT contain secrets
    expect(data.apiKey).toBeUndefined();
    expect(data.anthropicApiKey).toBeUndefined();
    expect(data.proKey).toBeUndefined();
    // Should contain safe fields
    expect(data.model).toBe("test-model");
    expect(data.maxTokens).toBe(4096);
  });

  // ─── Models ───────────────────────────────────────────────────

  test("GET /api/v1/models returns model list", async () => {
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/models"),
      "/api/v1/models",
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.active).toBe("test-model");
    expect(Array.isArray(data.models)).toBe(true);
  });

  // ─── Model Switch ────────────────────────────────────────────

  test("POST /api/v1/model with invalid body returns 400", async () => {
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      "/api/v1/model",
    );
    expect(res.status).toBe(400);
  });

  // ─── Plan ─────────────────────────────────────────────────────

  test("GET /api/v1/plan returns null when no plan", async () => {
    const res = await handleApiRequest(new Request("http://localhost/api/v1/plan"), "/api/v1/plan");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.plan).toBeNull();
  });

  // ─── Permission ───────────────────────────────────────────────

  test("POST /api/v1/permission/:id with invalid action returns 400", async () => {
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/permission/test-perm-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "invalid" }),
      }),
      "/api/v1/permission/test-perm-1",
    );
    expect(res.status).toBe(400);
  });

  test("POST /api/v1/permission/:id with unknown ID returns 404", async () => {
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/permission/nonexistent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "allow" }),
      }),
      "/api/v1/permission/nonexistent",
    );
    expect(res.status).toBe(404);
  });

  // ─── 404 ──────────────────────────────────────────────────────

  test("unknown route returns 404", async () => {
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/nonexistent"),
      "/api/v1/nonexistent",
    );
    expect(res.status).toBe(404);
  });

  test("wrong HTTP method returns 404", async () => {
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/session", { method: "DELETE" }),
      "/api/v1/session",
    );
    expect(res.status).toBe(404);
  });

  // ─── Tools ────────────────────────────────────────────────────

  test("GET /api/v1/tools returns tool list", async () => {
    const res = await handleApiRequest(
      new Request("http://localhost/api/v1/tools"),
      "/api/v1/tools",
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.tools)).toBe(true);
    expect(typeof data.count).toBe("number");
  });
});
