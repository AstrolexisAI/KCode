import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { KCodeClient } from "../src/index";

// Mock fetch globally
const originalFetch = globalThis.fetch;

function mockFetch(status: number, body: unknown, headers?: Record<string, string>) {
  return mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      })
    )
  );
}

describe("KCodeClient", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("constructor", () => {
    it("uses default baseUrl", () => {
      const client = new KCodeClient();
      expect(client).toBeDefined();
    });

    it("accepts custom options", () => {
      const client = new KCodeClient({
        baseUrl: "http://localhost:10100",
        apiKey: "test-key",
        timeout: 5000,
      });
      expect(client).toBeDefined();
    });

    it("strips trailing slash from baseUrl", () => {
      const fetcher = mockFetch(200, { ok: true, version: "1.0.0", model: "test" });
      globalThis.fetch = fetcher;

      const client = new KCodeClient({ baseUrl: "http://localhost:10100/" });
      client.health();

      expect(fetcher).toHaveBeenCalledTimes(1);
      const url = (fetcher.mock.calls[0] as unknown[])[0] as string;
      expect(url).toBe("http://localhost:10100/api/health");
    });
  });

  describe("health()", () => {
    it("returns health response", async () => {
      const body = { ok: true, version: "1.7.0", model: "test-model" };
      globalThis.fetch = mockFetch(200, body);

      const client = new KCodeClient();
      const result = await client.health();

      expect(result).toEqual(body);
    });

    it("throws on server error", async () => {
      globalThis.fetch = mockFetch(500, { error: "Internal Server Error", code: 500 });

      const client = new KCodeClient();
      await expect(client.health()).rejects.toThrow("KCode API error 500");
    });
  });

  describe("prompt()", () => {
    it("sends prompt and returns parsed response", async () => {
      const body = {
        id: "abc-123",
        sessionId: "sess-456",
        response: "Hello, world!",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        model: "test-model",
      };
      globalThis.fetch = mockFetch(200, body);

      const client = new KCodeClient();
      const result = await client.prompt("Say hello");

      expect(result.text).toBe("Hello, world!");
      expect(result.sessionId).toBe("sess-456");
      expect(result.usage.inputTokens).toBe(10);
      expect(result.toolCalls).toEqual([]);
    });

    it("includes session ID header when provided", async () => {
      const fetcher = mockFetch(200, {
        id: "abc",
        sessionId: "sess-1",
        response: "ok",
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      globalThis.fetch = fetcher;

      const client = new KCodeClient();
      await client.prompt("test", { sessionId: "my-session" });

      const callArgs = fetcher.mock.calls[0] as unknown[];
      const init = callArgs[1] as RequestInit;
      expect((init.headers as Record<string, string>)["X-Session-Id"]).toBe("my-session");
    });

    it("sends noTools and model options", async () => {
      const fetcher = mockFetch(200, {
        id: "abc",
        sessionId: "sess-1",
        response: "ok",
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      globalThis.fetch = fetcher;

      const client = new KCodeClient();
      await client.prompt("test", { model: "gpt-4", noTools: true });

      const callArgs = fetcher.mock.calls[0] as unknown[];
      const init = callArgs[1] as RequestInit;
      const parsed = JSON.parse(init.body as string);
      expect(parsed.model).toBe("gpt-4");
      expect(parsed.noTools).toBe(true);
    });
  });

  describe("tools()", () => {
    it("returns list of tools", async () => {
      const tools = [
        { name: "Read", description: "Read a file" },
        { name: "Grep", description: "Search files" },
      ];
      globalThis.fetch = mockFetch(200, { tools });

      const client = new KCodeClient();
      const result = await client.tools();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("Read");
    });
  });

  describe("executeTool()", () => {
    it("executes a tool and returns result", async () => {
      const body = { name: "Read", content: "file contents", isError: false };
      globalThis.fetch = mockFetch(200, body);

      const client = new KCodeClient();
      const result = await client.executeTool("Read", { file_path: "/tmp/test" });

      expect(result.name).toBe("Read");
      expect(result.isError).toBe(false);
    });

    it("handles 403 for blocked tools", async () => {
      globalThis.fetch = mockFetch(403, { error: "Tool not allowed", code: 403 });

      const client = new KCodeClient();
      await expect(
        client.executeTool("Bash", { command: "rm -rf /" })
      ).rejects.toThrow("KCode API error 403");
    });
  });

  describe("sessions()", () => {
    it("returns active sessions", async () => {
      const active = [
        {
          sessionId: "s1",
          model: "test",
          active: true,
          createdAt: "2026-01-01",
          lastActivity: "2026-01-01",
          messageCount: 5,
          toolUseCount: 2,
          tokenCount: 1000,
        },
      ];
      globalThis.fetch = mockFetch(200, { active, recent: [] });

      const client = new KCodeClient();
      const result = await client.sessions();

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe("s1");
    });
  });

  describe("auth header", () => {
    it("includes Bearer token when apiKey is set", async () => {
      const fetcher = mockFetch(200, { ok: true, version: "1.0.0", model: "test" });
      globalThis.fetch = fetcher;

      const client = new KCodeClient({ apiKey: "secret-token" });
      await client.health();

      const callArgs = fetcher.mock.calls[0] as unknown[];
      const init = callArgs[1] as RequestInit;
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(
        "Bearer secret-token"
      );
    });

    it("omits Authorization when no apiKey", async () => {
      const fetcher = mockFetch(200, { ok: true, version: "1.0.0", model: "test" });
      globalThis.fetch = fetcher;

      const client = new KCodeClient();
      await client.health();

      const callArgs = fetcher.mock.calls[0] as unknown[];
      const init = callArgs[1] as RequestInit;
      expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
    });
  });
});
