// KCode - Remote Trigger API Client Tests

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { TriggerApiClient } from "./trigger-api";
import type { RemoteTrigger, TriggerRunResult } from "./types";
import { TriggerApiError } from "./types";

const BASE_URL = "https://cloud.kulvex.ai/api/v1";
const AUTH_TOKEN = "test-token-abc123";

const sampleTrigger: RemoteTrigger = {
  id: "trg_001",
  name: "Daily lint",
  schedule: "0 9 * * 1-5",
  prompt: "Run lint and fix issues",
  status: "active",
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

const sampleRunResult: TriggerRunResult = {
  triggerId: "trg_001",
  status: "success",
  summary: "Lint completed with 0 errors",
  messagesCount: 5,
  tokensUsed: 2400,
  costUsd: 0.012,
  durationMs: 15000,
};

let originalFetch: typeof globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockFetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockResponse(body: unknown, status = 200): void {
  mockFetch.mockImplementation(() =>
    Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

describe("TriggerApiClient", () => {
  test("createTrigger sends correct POST body", async () => {
    const client = new TriggerApiClient(BASE_URL, AUTH_TOKEN);
    mockResponse(sampleTrigger);

    const result = await client.createTrigger({
      name: "Daily lint",
      schedule: "0 9 * * 1-5",
      prompt: "Run lint and fix issues",
    });

    expect(result).toEqual(sampleTrigger);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/triggers`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe("Daily lint");
    expect(body.schedule).toBe("0 9 * * 1-5");
    expect(body.prompt).toBe("Run lint and fix issues");
  });

  test("listTriggers returns array", async () => {
    const client = new TriggerApiClient(BASE_URL, AUTH_TOKEN);
    mockResponse([sampleTrigger]);

    const result = await client.listTriggers();

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("trg_001");
  });

  test("getTrigger returns null on 404", async () => {
    const client = new TriggerApiClient(BASE_URL, AUTH_TOKEN);
    mockResponse({ error: "Not found" }, 404);

    const result = await client.getTrigger("trg_nonexistent");
    expect(result).toBeNull();
  });

  test("getTrigger returns trigger on success", async () => {
    const client = new TriggerApiClient(BASE_URL, AUTH_TOKEN);
    mockResponse(sampleTrigger);

    const result = await client.getTrigger("trg_001");
    expect(result).toEqual(sampleTrigger);
  });

  test("deleteTrigger sends DELETE", async () => {
    const client = new TriggerApiClient(BASE_URL, AUTH_TOKEN);
    mockResponse(null, 204);

    await client.deleteTrigger("trg_001");

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/triggers/trg_001`);
    expect(init.method).toBe("DELETE");
  });

  test("runTrigger returns result", async () => {
    const client = new TriggerApiClient(BASE_URL, AUTH_TOKEN);
    mockResponse(sampleRunResult);

    const result = await client.runTrigger("trg_001");
    expect(result.triggerId).toBe("trg_001");
    expect(result.status).toBe("success");
    expect(result.durationMs).toBe(15000);
  });

  test("getTriggerHistory returns results with limit", async () => {
    const client = new TriggerApiClient(BASE_URL, AUTH_TOKEN);
    mockResponse([sampleRunResult]);

    const result = await client.getTriggerHistory("trg_001", 10);

    expect(result).toHaveLength(1);
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("?limit=10");
  });

  test("request adds auth header", async () => {
    const client = new TriggerApiClient(BASE_URL, AUTH_TOKEN);
    mockResponse([]);

    await client.listTriggers();

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${AUTH_TOKEN}`);
  });

  test("request omits auth header when no token provided", async () => {
    const client = new TriggerApiClient(BASE_URL);
    mockResponse([]);

    await client.listTriggers();

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  test("error handling for 401 Unauthorized", async () => {
    const client = new TriggerApiClient(BASE_URL, AUTH_TOKEN);
    mockResponse({ error: "Unauthorized" }, 401);

    try {
      await client.listTriggers();
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(TriggerApiError);
      expect((err as TriggerApiError).statusCode).toBe(401);
      expect((err as TriggerApiError).message).toBe("Unauthorized");
    }
  });

  test("error handling for 500 Internal Server Error", async () => {
    const client = new TriggerApiClient(BASE_URL, AUTH_TOKEN);
    mockResponse({ error: "Internal server error" }, 500);

    try {
      await client.createTrigger({
        name: "test",
        schedule: "* * * * *",
        prompt: "test",
      });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TriggerApiError);
      expect((err as TriggerApiError).statusCode).toBe(500);
    }
  });

  test("network error is wrapped in TriggerApiError", async () => {
    const client = new TriggerApiClient(BASE_URL, AUTH_TOKEN);
    mockFetch.mockImplementation(() => Promise.reject(new Error("DNS resolution failed")));

    try {
      await client.listTriggers();
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TriggerApiError);
      expect((err as TriggerApiError).statusCode).toBe(0);
      expect((err as TriggerApiError).message).toContain("DNS resolution failed");
    }
  });
});
