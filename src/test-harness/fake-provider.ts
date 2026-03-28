// KCode - Fake LLM Provider for E2E Testing
// Returns pre-scripted responses as SSE streams matching OpenAI chat completions API format

import type { Server } from "bun";

// ─── Types ───────────────────────────────────────────────────────

interface FakeToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

interface FakeResponse {
  type: "text" | "tool_call" | "thinking" | "error" | "max_tokens";
  text?: string;
  thinking?: string;
  toolCalls?: FakeToolCall[];
  errorMessage?: string;
  usage?: { promptTokens: number; completionTokens: number };
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timestamp: number;
}

// ─── SSE Helpers ─────────────────────────────────────────────────

function sseDataLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function makeContentChunk(content: string, finishReason: string | null = null) {
  return {
    id: `chatcmpl-fake-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fake-model",
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: finishReason,
      },
    ],
  };
}

function makeToolCallChunk(
  toolCallId: string,
  name: string,
  args: string,
  index: number,
  finishReason: string | null = null,
) {
  return {
    id: `chatcmpl-fake-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fake-model",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              id: toolCallId,
              type: "function" as const,
              function: { name, arguments: args },
            },
          ],
        },
        finish_reason: finishReason,
      },
    ],
  };
}

function makeFinishChunk(finishReason: string) {
  return {
    id: `chatcmpl-fake-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fake-model",
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
  };
}

function makeUsageChunk(promptTokens: number, completionTokens: number) {
  return {
    id: `chatcmpl-fake-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fake-model",
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// ─── FakeProvider Class ──────────────────────────────────────────

export class FakeProvider {
  private responses: FakeResponse[] = [];
  private responseIndex = 0;
  private server: Server | null = null;
  private _requests: RecordedRequest[] = [];

  /** The base URL of the fake server (e.g., "http://localhost:12345"). */
  get baseUrl(): string {
    if (!this.server) throw new Error("FakeProvider not started — call start() first");
    return `http://localhost:${this.server.port}`;
  }

  /** All requests received by the fake server. */
  get requests(): RecordedRequest[] {
    return this._requests;
  }

  /** The last request received. */
  get lastRequest(): RecordedRequest | undefined {
    return this._requests[this._requests.length - 1];
  }

  /** Reset recorded requests. */
  clearRequests(): void {
    this._requests = [];
  }

  /** Reset response queue and index. */
  reset(): void {
    this.responses = [];
    this.responseIndex = 0;
    this._requests = [];
  }

  // ─── Response Configuration ────────────────────────────────────

  /** Queue a text response. */
  addResponse(text: string, usage?: { promptTokens: number; completionTokens: number }): this {
    this.responses.push({ type: "text", text, usage });
    return this;
  }

  /** Queue a tool call response. */
  addToolCallResponse(
    toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>,
    usage?: { promptTokens: number; completionTokens: number },
  ): this {
    this.responses.push({
      type: "tool_call",
      toolCalls: toolCalls.map((tc) => ({ name: tc.name, arguments: tc.arguments })),
      usage,
    });
    return this;
  }

  /** Queue a thinking + text response (reasoning_content field). */
  addThinkingResponse(
    thinking: string,
    text: string,
    usage?: { promptTokens: number; completionTokens: number },
  ): this {
    this.responses.push({ type: "thinking", thinking, text, usage });
    return this;
  }

  /** Queue an error response (HTTP 500). */
  addErrorResponse(message: string): this {
    this.responses.push({ type: "error", errorMessage: message });
    return this;
  }

  /** Queue a max_tokens (length) response — model output was truncated. */
  addMaxTokensResponse(
    partialText: string,
    usage?: { promptTokens: number; completionTokens: number },
  ): this {
    this.responses.push({ type: "max_tokens", text: partialText, usage });
    return this;
  }

  // ─── Server Lifecycle ──────────────────────────────────────────

  /** Start the fake HTTP server on a random available port. */
  async start(): Promise<void> {
    this.server = Bun.serve({
      port: 0, // random available port
      fetch: async (req) => {
        return this.handleRequest(req);
      },
    });
  }

  /** Stop the fake HTTP server. */
  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
  }

  // ─── Request Handling ──────────────────────────────────────────

  private async handleRequest(req: Request): Promise<Response> {
    // Record the request
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {
      // Not JSON
    }

    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });

    this._requests.push({
      method: req.method,
      url: new URL(req.url).pathname,
      headers,
      body,
      timestamp: Date.now(),
    });

    // Only handle POST /v1/chat/completions
    const url = new URL(req.url);
    if (url.pathname !== "/v1/chat/completions") {
      return new Response("Not Found", { status: 404 });
    }

    // Get next response
    const response = this.responses[this.responseIndex];
    if (!response) {
      return new Response(
        JSON.stringify({ error: { message: "No more scripted responses" } }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
    this.responseIndex++;

    // Error responses
    if (response.type === "error") {
      return new Response(
        JSON.stringify({ error: { message: response.errorMessage ?? "Internal server error" } }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    // Build SSE stream
    const sseBody = this.buildSSEBody(response);

    return new Response(sseBody, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  private buildSSEBody(response: FakeResponse): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const chunks: string[] = [];
    const usage = response.usage ?? { promptTokens: 100, completionTokens: 50 };

    switch (response.type) {
      case "text": {
        // Stream text in word-sized chunks for realism
        const words = (response.text ?? "").split(" ");
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
        const toolCalls = response.toolCalls ?? [];
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i]!;
          const callId = `call_fake_${Date.now()}_${i}`;
          const argsStr = JSON.stringify(tc.arguments);
          // Send tool call in one chunk (name + full args)
          chunks.push(sseDataLine(makeToolCallChunk(callId, tc.name, argsStr, i)));
        }
        chunks.push(sseDataLine(makeFinishChunk("tool_calls")));
        chunks.push(sseDataLine(makeUsageChunk(usage.promptTokens, usage.completionTokens)));
        chunks.push("data: [DONE]\n\n");
        break;
      }

      case "thinking": {
        // Thinking content via reasoning_content field
        const thinkingChunk = {
          id: `chatcmpl-fake-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "fake-model",
          choices: [
            {
              index: 0,
              delta: { reasoning_content: response.thinking },
              finish_reason: null,
            },
          ],
        };
        chunks.push(sseDataLine(thinkingChunk));

        // Then stream text content
        const words = (response.text ?? "").split(" ");
        for (let i = 0; i < words.length; i++) {
          const word = (i > 0 ? " " : "") + words[i];
          chunks.push(sseDataLine(makeContentChunk(word)));
        }
        chunks.push(sseDataLine(makeFinishChunk("stop")));
        chunks.push(sseDataLine(makeUsageChunk(usage.promptTokens, usage.completionTokens)));
        chunks.push("data: [DONE]\n\n");
        break;
      }

      case "max_tokens": {
        // Stream partial text then finish with "length" reason
        const words = (response.text ?? "").split(" ");
        for (let i = 0; i < words.length; i++) {
          const word = (i > 0 ? " " : "") + words[i];
          chunks.push(sseDataLine(makeContentChunk(word)));
        }
        chunks.push(sseDataLine(makeFinishChunk("length")));
        chunks.push(sseDataLine(makeUsageChunk(usage.promptTokens, usage.completionTokens)));
        chunks.push("data: [DONE]\n\n");
        break;
      }
    }

    const allData = chunks.join("");
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(allData));
        controller.close();
      },
    });
  }
}
