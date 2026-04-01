// KCode - Mock Server Tests
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const PORT = 19556; // Use a different port to avoid conflicts with a running mock server

let server: ReturnType<typeof Bun.serve>;

// ─── Inline minimal server for testing ────────────────────────
// We import the handler logic but run on a test-specific port.

import { handleRequest } from "./mock-server";

beforeAll(() => {
  server = Bun.serve({
    port: PORT,
    fetch: handleRequest,
  });
});

afterAll(() => {
  server.stop(true);
});

const base = `http://localhost:${PORT}`;

// ─── Health Endpoint ──────────────────────────────────────────

describe("Health endpoint", () => {
  test("GET /health returns ok status", async () => {
    const resp = await fetch(`${base}/health`);
    expect(resp.ok).toBe(true);
    const body = await resp.json();
    expect(body.status).toBe("ok");
    expect(body.server).toBe("kcode-mock");
  });

  test("GET /v1/health returns ok status", async () => {
    const resp = await fetch(`${base}/v1/health`);
    expect(resp.ok).toBe(true);
    const body = await resp.json();
    expect(body.status).toBe("ok");
  });
});

// ─── Chat Completions ─────────────────────────────────────────

describe("POST /v1/chat/completions", () => {
  test("returns a non-streaming response", async () => {
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      }),
    });

    expect(resp.ok).toBe(true);
    const body = await resp.json();
    expect(body.choices).toBeDefined();
    expect(body.choices.length).toBeGreaterThan(0);
    expect(body.choices[0].message.content).toBeTruthy();
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.model).toBe("test-model");
    expect(body.usage).toBeDefined();
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });

  test("returns SSE streaming response", async () => {
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });

    expect(resp.ok).toBe(true);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");

    const reader = resp.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let fullText = "";
    let chunkCount = 0;
    let gotDone = false;

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        fullText += text;

        const lines = text.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ") && line.trim() !== "data: [DONE]") {
            chunkCount++;
            const data = JSON.parse(line.slice(6));
            expect(data.choices).toBeDefined();
            expect(data.choices[0].delta).toBeDefined();
          }
          if (line.trim() === "data: [DONE]") {
            gotDone = true;
          }
        }
      }
    }

    expect(chunkCount).toBeGreaterThan(0);
    expect(gotDone).toBe(true);
  });

  test("returns 400 for invalid JSON body", async () => {
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.message).toContain("Invalid JSON");
  });
});

// ─── Models Endpoint ──────────────────────────────────────────

describe("GET /v1/models", () => {
  test("returns model list", async () => {
    const resp = await fetch(`${base}/v1/models`);
    expect(resp.ok).toBe(true);
    const body = await resp.json();
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].id).toBe("mock-model");
  });
});

// ─── 404 Handling ─────────────────────────────────────────────

describe("Unknown routes", () => {
  test("returns 404 for unknown path", async () => {
    const resp = await fetch(`${base}/v1/unknown`);
    expect(resp.status).toBe(404);
    const body = await resp.json();
    expect(body.error.message).toContain("Not found");
  });
});
