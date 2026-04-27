// KCode - Mock LLM Server for E2E Testing
// Lightweight HTTP server simulating OpenAI-compatible /v1/chat/completions with SSE streaming
// Supports configurable responses: text, tool_calls, errors, latency simulation

import type { Server } from "bun";

// ─── Types ───────────────────────────────────────────────────────

export interface MockToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface MockResponseConfig {
  type: "text" | "tool_call" | "error";
  /** Text content for "text" responses. */
  text?: string;
  /** Tool calls for "tool_call" responses. */
  toolCalls?: MockToolCall[];
  /** Error message for "error" responses. */
  errorMessage?: string;
  /** HTTP status code for errors (default: 500). */
  errorStatus?: number;
  /** Simulated latency in milliseconds before responding. */
  latencyMs?: number;
  /** Usage statistics. */
  usage?: { promptTokens: number; completionTokens: number };
}

export interface MockLLMServer {
  /** Full URL of the server (e.g., "http://localhost:12345"). */
  url: string;
  /** Port the server is listening on. */
  port: number;
  /** Stop the server and release resources. */
  close: () => void;
  /** Set the next response(s) the server will return. */
  setResponse: (config: MockResponseConfig | MockResponseConfig[]) => void;
  /** All recorded requests. */
  requests: Array<{ body: unknown; timestamp: number }>;
}

// ─── SSE Helpers ─────────────────────────────────────────────────

function sseDataLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function makeContentChunk(content: string, finishReason: string | null = null) {
  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: finishReason,
      },
    ],
  };
}

function makeToolCallChunk(callId: string, name: string, args: string, index: number) {
  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              id: callId,
              type: "function" as const,
              function: { name, arguments: args },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

function makeFinishChunk(finishReason: string) {
  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
}

function makeUsageChunk(promptTokens: number, completionTokens: number) {
  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// ─── Build SSE body ──────────────────────────────────────────────

function buildSSEBody(config: MockResponseConfig): string {
  const chunks: string[] = [];
  const usage = config.usage ?? { promptTokens: 100, completionTokens: 50 };

  switch (config.type) {
    case "text": {
      const words = (config.text ?? "").split(" ");
      for (let i = 0; i < words.length; i++) {
        const word = (i > 0 ? " " : "") + words[i];
        chunks.push(sseDataLine(makeContentChunk(word)));
      }
      chunks.push(sseDataLine(makeFinishChunk("stop")));
      chunks.push(sseDataLine(makeUsageChunk(usage.promptTokens, usage.completionTokens)));
      chunks.push("data: [DONE]\n\n");
      break;
    }

    case "tool_call": {
      const toolCalls = config.toolCalls ?? [];
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]!;
        const callId = `call_mock_${Date.now()}_${i}`;
        chunks.push(
          sseDataLine(makeToolCallChunk(callId, tc.name, JSON.stringify(tc.arguments), i)),
        );
      }
      chunks.push(sseDataLine(makeFinishChunk("tool_calls")));
      chunks.push(sseDataLine(makeUsageChunk(usage.promptTokens, usage.completionTokens)));
      chunks.push("data: [DONE]\n\n");
      break;
    }

    case "error":
      // Handled at the HTTP level, not SSE
      break;
  }

  return chunks.join("");
}

// ─── Factory ─────────────────────────────────────────────────────

/**
 * Create a mock LLM server that simulates an OpenAI-compatible
 * /v1/chat/completions endpoint with SSE streaming.
 *
 * Starts on a random high port (10000+).
 */
export async function createMockLLMServer(): Promise<MockLLMServer> {
  let responses: MockResponseConfig[] = [];
  let responseIndex = 0;
  const requests: Array<{ body: unknown; timestamp: number }> = [];

  const server: Server<unknown> = Bun.serve({
    port: 0, // Random available port
    fetch: async (req) => {
      const url = new URL(req.url);

      // Only handle POST /v1/chat/completions
      if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return new Response("Not Found", { status: 404 });
      }

      // Record request
      let body: unknown = null;
      try {
        body = await req.json();
      } catch {
        /* not JSON */
      }
      requests.push({ body, timestamp: Date.now() });

      // Get next response config
      const config = responses[responseIndex];
      if (!config) {
        return new Response(JSON.stringify({ error: { message: "No more scripted responses" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      responseIndex++;

      // Simulate latency
      if (config.latencyMs && config.latencyMs > 0) {
        await new Promise((r) => setTimeout(r, config.latencyMs));
      }

      // Error responses
      if (config.type === "error") {
        return new Response(
          JSON.stringify({ error: { message: config.errorMessage ?? "Internal server error" } }),
          {
            status: config.errorStatus ?? 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // SSE streaming response
      const sseBody = buildSSEBody(config);
      const encoder = new TextEncoder();

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(sseBody));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        },
      );
    },
  });

  const port = server.port!;

  return {
    url: `http://localhost:${port}`,
    port,
    requests,
    close: () => {
      server.stop(true);
    },
    setResponse: (config: MockResponseConfig | MockResponseConfig[]) => {
      responses = Array.isArray(config) ? config : [config];
      responseIndex = 0;
    },
  };
}
