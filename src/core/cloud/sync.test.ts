import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { CloudClient } from "./client";
import { SessionSync } from "./sync";
import type { KCodeCloudConfig, SyncResult } from "./types";

// ─── Test fixtures ─────────────────────────────────────────────

const TEST_CONFIG: KCodeCloudConfig = {
  url: "https://cloud.kulvex.ai",
  token: "test-token",
  teamId: "team-001",
  features: {
    sessionSync: true,
    sharedMemory: true,
    analytics: true,
    policies: true,
    audit: true,
  },
};

const SYNC_RESULT: SyncResult = {
  sessionId: "sess-001",
  messagesSynced: 5,
  timestamp: "2026-03-31T12:00:00Z",
};

const originalFetch = globalThis.fetch;

function mockFetchResponse(data: any, status = 200) {
  return mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

// ─── Tests ─────────────────────────────────────────────────────

describe("SessionSync", () => {
  let client: CloudClient;
  let sync: SessionSync;

  beforeEach(() => {
    globalThis.fetch = mockFetchResponse(SYNC_RESULT) as any;
    client = new CloudClient(TEST_CONFIG);
    sync = new SessionSync(client);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("sanitizeMessage", () => {
    test("truncates long string content to 2048 chars", () => {
      const longContent = "x".repeat(5000);
      const msg = { role: "assistant", content: longContent };
      const result = sync.sanitizeMessage(msg);

      expect(result.content.length).toBeLessThanOrEqual(2048 + " [truncated]".length);
      expect(result.content).toEndWith("[truncated]");
    });

    test("preserves short content unchanged", () => {
      const msg = { role: "user", content: "Hello, world!" };
      const result = sync.sanitizeMessage(msg);
      expect(result.content).toBe("Hello, world!");
    });

    test("truncates array content parts", () => {
      const msg = {
        role: "assistant",
        content: [
          { type: "text", text: "a".repeat(3000) },
          { type: "text", text: "short" },
        ],
      };
      const result = sync.sanitizeMessage(msg);

      expect(result.content[0].text).toEndWith("[truncated]");
      expect(result.content[0].text.length).toBeLessThanOrEqual(2048 + " [truncated]".length);
      expect(result.content[1].text).toBe("short");
    });

    test("strips tool call input/output fields", () => {
      const msg = {
        role: "assistant",
        tool_calls: [
          {
            id: "call-001",
            type: "function",
            function: { name: "Read", arguments: '{"path": "/foo"}' },
            input: { path: "/foo" },
          },
        ],
      };
      const result = sync.sanitizeMessage(msg);

      expect(result.tool_calls).toHaveLength(1);
      expect(result.tool_calls[0].id).toBe("call-001");
      expect(result.tool_calls[0].name).toBe("Read");
      // Stripped fields
      expect(result.tool_calls[0].input).toBeUndefined();
      expect(result.tool_calls[0].function).toBeUndefined();
      expect(result.tool_calls[0].arguments).toBeUndefined();
    });

    test("strips tool result fields except truncated content", () => {
      const msg = {
        role: "tool",
        content: "b".repeat(3000),
        output: "should be stripped",
        result: { data: "should be stripped" },
      };
      const result = sync.sanitizeMessage(msg);

      expect(result.content).toEndWith("[truncated]");
      expect(result.output).toBeUndefined();
      expect(result.result).toBeUndefined();
    });

    test("handles null/undefined input gracefully", () => {
      expect(sync.sanitizeMessage(null)).toBeNull();
      expect(sync.sanitizeMessage(undefined)).toBeUndefined();
    });

    test("preserves role and metadata fields", () => {
      const msg = {
        role: "user",
        content: "test",
        id: "msg-001",
        timestamp: "2026-03-31T00:00:00Z",
      };
      const result = sync.sanitizeMessage(msg);
      expect(result.role).toBe("user");
      expect(result.id).toBe("msg-001");
      expect(result.timestamp).toBe("2026-03-31T00:00:00Z");
    });
  });

  describe("syncSession (full sync)", () => {
    test("sends all messages to the server", async () => {
      const fetchFn = mockFetchResponse(SYNC_RESULT);
      globalThis.fetch = fetchFn as any;
      client = new CloudClient(TEST_CONFIG);
      sync = new SessionSync(client);

      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "Fix the bug" },
      ];

      const result = await sync.syncSession("sess-001", messages, {
        totalTokens: 1000,
      });

      expect(result.sessionId).toBe("sess-001");
      expect(fetchFn).toHaveBeenCalled();

      const [, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body.fullSync).toBe(true);
      expect(body.messages).toHaveLength(3);
      expect(body.stats.totalTokens).toBe(1000);
    });

    test("updates lastSyncIndex after full sync", async () => {
      const messages = [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ];

      await sync.syncSession("sess-002", messages, null);
      expect(sync.getLastSyncIndex("sess-002")).toBe(2);
    });

    test("sanitizes messages before sending", async () => {
      const fetchFn = mockFetchResponse(SYNC_RESULT);
      globalThis.fetch = fetchFn as any;
      client = new CloudClient(TEST_CONFIG);
      sync = new SessionSync(client);

      const messages = [{ role: "user", content: "c".repeat(5000) }];

      await sync.syncSession("sess-003", messages, null);

      const [, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body.messages[0].content).toEndWith("[truncated]");
    });
  });

  describe("syncDelta (incremental sync)", () => {
    test("only sends new messages since lastSyncIndex", async () => {
      const fetchFn = mockFetchResponse(SYNC_RESULT);
      globalThis.fetch = fetchFn as any;
      client = new CloudClient(TEST_CONFIG);
      sync = new SessionSync(client);

      const messages = [
        { role: "user", content: "msg 1" },
        { role: "assistant", content: "msg 2" },
        { role: "user", content: "msg 3" },
        { role: "assistant", content: "msg 4" },
      ];

      const result = await sync.syncDelta("sess-004", messages, 2);

      const [, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body.fullSync).toBe(false);
      expect(body.startIndex).toBe(2);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].content).toBe("msg 3");
      expect(body.messages[1].content).toBe("msg 4");
    });

    test("falls back to full sync when lastSyncIndex is 0", async () => {
      const fetchFn = mockFetchResponse(SYNC_RESULT);
      globalThis.fetch = fetchFn as any;
      client = new CloudClient(TEST_CONFIG);
      sync = new SessionSync(client);

      const messages = [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
      ];

      await sync.syncDelta("sess-005", messages, 0);

      const [, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body.fullSync).toBe(true);
      expect(body.messages).toHaveLength(2);
    });

    test("updates lastSyncIndex after delta sync", async () => {
      const messages = [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ];

      await sync.syncDelta("sess-006", messages, 1);
      expect(sync.getLastSyncIndex("sess-006")).toBe(3);
    });
  });

  describe("lastSyncIndex tracking", () => {
    test("returns 0 for unknown sessions", () => {
      expect(sync.getLastSyncIndex("unknown-session")).toBe(0);
    });

    test("stores and retrieves sync index", () => {
      sync.setLastSyncIndex("sess-abc", 42);
      expect(sync.getLastSyncIndex("sess-abc")).toBe(42);
    });

    test("updates existing index", () => {
      sync.setLastSyncIndex("sess-xyz", 10);
      sync.setLastSyncIndex("sess-xyz", 20);
      expect(sync.getLastSyncIndex("sess-xyz")).toBe(20);
    });

    test("tracks multiple sessions independently", () => {
      sync.setLastSyncIndex("sess-a", 5);
      sync.setLastSyncIndex("sess-b", 15);
      expect(sync.getLastSyncIndex("sess-a")).toBe(5);
      expect(sync.getLastSyncIndex("sess-b")).toBe(15);
    });
  });
});
