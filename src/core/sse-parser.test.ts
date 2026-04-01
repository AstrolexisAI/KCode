// KCode - SSE Stream Parser Tests
// Tests for OpenAI-compatible and Anthropic SSE stream parsing

import { describe, expect, test } from "bun:test";
import { parseAnthropicSSEStream, parseSSEStream, type SSEChunk } from "./sse-parser";

// ─── Helpers ────────────────────────────────────────────────────

/** Build a mock Response with a ReadableStream body from an array of string chunks. */
function mockResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream);
}

/** Collect all chunks from an async generator. */
async function collect(gen: AsyncGenerator<SSEChunk>): Promise<SSEChunk[]> {
  const result: SSEChunk[] = [];
  for await (const chunk of gen) {
    result.push(chunk);
  }
  return result;
}

/** Build SSE data line from a JSON object. */
function dataLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** Build Anthropic SSE event with event type + data. */
function anthropicEvent(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ─── parseSSEStream (OpenAI-compatible) ─────────────────────────

describe("parseSSEStream", () => {
  test("parses content deltas", async () => {
    // Content must be >12 chars each to exceed the think-tag parser buffer threshold
    const resp = mockResponse([
      dataLine({
        choices: [{ delta: { content: "Hello, this is a longer message" }, finish_reason: null }],
      }),
      dataLine({
        choices: [
          { delta: { content: " and here is more content to parse" }, finish_reason: null },
        ],
      }),
    ]);
    const chunks = await collect(parseSSEStream(resp));
    const contentChunks = chunks.filter((c) => c.type === "content_delta");
    expect(contentChunks.length).toBeGreaterThanOrEqual(1);
    const text = contentChunks.map((c) => c.content).join("");
    expect(text).toContain("Hello");
    expect(text).toContain("more content");
  });

  test("parses tool call deltas", async () => {
    const resp = mockResponse([
      dataLine({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  function: { name: "Read", arguments: '{"file' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      dataLine({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '_path":"/x"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      "data: [DONE]\n\n",
    ]);
    const chunks = await collect(parseSSEStream(resp));
    const toolChunks = chunks.filter((c) => c.type === "tool_call_delta");
    expect(toolChunks.length).toBe(2);
    expect(toolChunks[0]!.toolCallId).toBe("call_abc");
    expect(toolChunks[0]!.functionName).toBe("Read");
    expect(toolChunks[0]!.functionArgDelta).toBe('{"file');
    expect(toolChunks[1]!.functionArgDelta).toBe('_path":"/x"}');
  });

  test("parses reasoning_content as thinking_delta", async () => {
    const resp = mockResponse([
      dataLine({
        choices: [{ delta: { reasoning_content: "Let me think..." }, finish_reason: null }],
      }),
      "data: [DONE]\n\n",
    ]);
    const chunks = await collect(parseSSEStream(resp));
    const thinking = chunks.filter((c) => c.type === "thinking_delta");
    expect(thinking.length).toBe(1);
    expect(thinking[0]!.thinking).toBe("Let me think...");
  });

  test("parses finish reason", async () => {
    const resp = mockResponse([
      dataLine({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);
    const chunks = await collect(parseSSEStream(resp));
    const finish = chunks.filter((c) => c.type === "finish");
    expect(finish.length).toBe(1);
    expect(finish[0]!.finishReason).toBe("stop");
  });

  test("parses usage information", async () => {
    const resp = mockResponse([
      dataLine({
        choices: [{ delta: { content: "hi" }, finish_reason: null }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
      "data: [DONE]\n\n",
    ]);
    const chunks = await collect(parseSSEStream(resp));
    const usage = chunks.filter((c) => c.type === "usage");
    expect(usage.length).toBe(1);
    expect(usage[0]!.promptTokens).toBe(100);
    expect(usage[0]!.completionTokens).toBe(50);
  });

  test("parses usage-only messages (no choices)", async () => {
    const resp = mockResponse([
      dataLine({ usage: { prompt_tokens: 200, completion_tokens: 80 } }),
      "data: [DONE]\n\n",
    ]);
    const chunks = await collect(parseSSEStream(resp));
    const usage = chunks.filter((c) => c.type === "usage");
    expect(usage.length).toBe(1);
    expect(usage[0]!.promptTokens).toBe(200);
  });

  test("skips malformed JSON lines gracefully", async () => {
    const resp = mockResponse([
      "data: {not valid json\n\n",
      dataLine({
        choices: [
          { delta: { content: "This is valid content after malformed JSON" }, finish_reason: null },
        ],
      }),
    ]);
    const chunks = await collect(parseSSEStream(resp));
    const content = chunks.filter((c) => c.type === "content_delta");
    expect(content.length).toBeGreaterThanOrEqual(1);
  });

  test("skips SSE comment lines", async () => {
    const resp = mockResponse([
      ": this is a comment\n",
      dataLine({
        choices: [
          { delta: { content: "Content after a comment line in SSE" }, finish_reason: null },
        ],
      }),
    ]);
    const chunks = await collect(parseSSEStream(resp));
    const content = chunks.filter((c) => c.type === "content_delta");
    expect(content.length).toBeGreaterThanOrEqual(1);
  });

  test("handles [DONE] terminator — stops processing subsequent events", async () => {
    const resp = mockResponse([
      dataLine({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
      // Anything after [DONE] should be ignored — use a usage event to verify
      dataLine({ usage: { prompt_tokens: 9999, completion_tokens: 9999 } }),
    ]);
    const chunks = await collect(parseSSEStream(resp));
    // The finish event before [DONE] should be present
    expect(chunks.some((c) => c.type === "finish")).toBe(true);
    // The usage event after [DONE] should NOT appear
    const usage = chunks.filter((c) => c.type === "usage" && c.promptTokens === 9999);
    expect(usage.length).toBe(0);
  });

  test("handles partial SSE lines split across chunks", async () => {
    // Simulate the data line being split across two ReadableStream chunks
    // Use long content to exceed think-tag parser buffer threshold
    const fullLine = dataLine({
      choices: [
        { delta: { content: "This content was split across stream chunks" }, finish_reason: null },
      ],
    });
    const mid = Math.floor(fullLine.length / 2);
    const resp = mockResponse([fullLine.slice(0, mid), fullLine.slice(mid)]);
    const chunks = await collect(parseSSEStream(resp));
    const content = chunks.filter((c) => c.type === "content_delta");
    expect(content.length).toBeGreaterThanOrEqual(1);
  });

  test("empty stream yields no chunks", async () => {
    const resp = mockResponse([]);
    const chunks = await collect(parseSSEStream(resp));
    expect(chunks).toHaveLength(0);
  });

  test("handles multiple tool calls in single delta", async () => {
    const resp = mockResponse([
      dataLine({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "Read", arguments: "{}" } },
                { index: 1, id: "c2", function: { name: "Glob", arguments: "{}" } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      "data: [DONE]\n\n",
    ]);
    const chunks = await collect(parseSSEStream(resp));
    const tools = chunks.filter((c) => c.type === "tool_call_delta");
    expect(tools.length).toBe(2);
    expect(tools[0]!.functionName).toBe("Read");
    expect(tools[1]!.functionName).toBe("Glob");
  });
});

// ─── parseAnthropicSSEStream ────────────────────────────────────

describe("parseAnthropicSSEStream", () => {
  test("parses text_delta content", async () => {
    const resp = mockResponse([
      anthropicEvent("content_block_start", { index: 0, content_block: { type: "text" } }),
      anthropicEvent("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      }),
      anthropicEvent("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: " world" },
      }),
      anthropicEvent("content_block_stop", { index: 0 }),
      anthropicEvent("message_stop", {}),
    ]);
    const chunks = await collect(parseAnthropicSSEStream(resp));
    const content = chunks.filter((c) => c.type === "content_delta");
    expect(content.length).toBe(2);
    expect(content[0]!.content).toBe("Hello");
    expect(content[1]!.content).toBe(" world");
  });

  test("parses thinking_delta", async () => {
    const resp = mockResponse([
      anthropicEvent("content_block_start", { index: 0, content_block: { type: "thinking" } }),
      anthropicEvent("content_block_delta", {
        index: 0,
        delta: { type: "thinking_delta", thinking: "reasoning..." },
      }),
      anthropicEvent("content_block_stop", { index: 0 }),
      anthropicEvent("message_stop", {}),
    ]);
    const chunks = await collect(parseAnthropicSSEStream(resp));
    const thinking = chunks.filter((c) => c.type === "thinking_delta");
    expect(thinking.length).toBe(1);
    expect(thinking[0]!.thinking).toBe("reasoning...");
  });

  test("parses tool_use blocks", async () => {
    const resp = mockResponse([
      anthropicEvent("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "Bash" },
      }),
      anthropicEvent("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"command":' },
      }),
      anthropicEvent("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"ls"}' },
      }),
      anthropicEvent("content_block_stop", { index: 0 }),
      anthropicEvent("message_stop", {}),
    ]);
    const chunks = await collect(parseAnthropicSSEStream(resp));
    const toolChunks = chunks.filter((c) => c.type === "tool_call_delta");
    expect(toolChunks.length).toBe(3); // start + 2 input deltas
    expect(toolChunks[0]!.functionName).toBe("Bash");
    expect(toolChunks[0]!.toolCallId).toBe("tu_1");
    expect(toolChunks[1]!.functionArgDelta).toBe('{"command":');
    expect(toolChunks[2]!.functionArgDelta).toBe('"ls"}');
  });

  test("parses message_start usage", async () => {
    const resp = mockResponse([
      anthropicEvent("message_start", {
        message: { usage: { input_tokens: 500, output_tokens: 0 } },
      }),
      anthropicEvent("message_stop", {}),
    ]);
    const chunks = await collect(parseAnthropicSSEStream(resp));
    const usage = chunks.filter((c) => c.type === "usage");
    expect(usage.length).toBe(1);
    expect(usage[0]!.promptTokens).toBe(500);
  });

  test("maps Anthropic stop reasons to internal format", async () => {
    const resp = mockResponse([
      anthropicEvent("message_delta", { delta: { stop_reason: "end_turn" } }),
      anthropicEvent("message_stop", {}),
    ]);
    const chunks = await collect(parseAnthropicSSEStream(resp));
    const finish = chunks.filter((c) => c.type === "finish");
    expect(finish.length).toBe(1);
    expect(finish[0]!.finishReason).toBe("stop");
  });

  test("maps tool_use stop reason to tool_calls", async () => {
    const resp = mockResponse([
      anthropicEvent("message_delta", { delta: { stop_reason: "tool_use" } }),
      anthropicEvent("message_stop", {}),
    ]);
    const chunks = await collect(parseAnthropicSSEStream(resp));
    const finish = chunks.filter((c) => c.type === "finish");
    expect(finish[0]!.finishReason).toBe("tool_calls");
  });

  test("maps max_tokens stop reason to length", async () => {
    const resp = mockResponse([
      anthropicEvent("message_delta", { delta: { stop_reason: "max_tokens" } }),
      anthropicEvent("message_stop", {}),
    ]);
    const chunks = await collect(parseAnthropicSSEStream(resp));
    const finish = chunks.filter((c) => c.type === "finish");
    expect(finish[0]!.finishReason).toBe("length");
  });

  test("parses error events", async () => {
    const resp = mockResponse([
      anthropicEvent("error", { error: { message: "rate limit exceeded" } }),
    ]);
    const chunks = await collect(parseAnthropicSSEStream(resp));
    const errors = chunks.filter((c) => c.type === "error");
    expect(errors.length).toBe(1);
    expect(errors[0]!.content).toBe("rate limit exceeded");
  });

  test("handles message_delta with output usage", async () => {
    const resp = mockResponse([
      anthropicEvent("message_delta", {
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 0, output_tokens: 250 },
      }),
      anthropicEvent("message_stop", {}),
    ]);
    const chunks = await collect(parseAnthropicSSEStream(resp));
    const usage = chunks.filter((c) => c.type === "usage");
    expect(usage.length).toBe(1);
    expect(usage[0]!.completionTokens).toBe(250);
  });

  test("skips malformed JSON in Anthropic stream", async () => {
    const resp = mockResponse([
      "event: content_block_delta\ndata: {broken json\n\n",
      anthropicEvent("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      }),
      anthropicEvent("message_stop", {}),
    ]);
    const chunks = await collect(parseAnthropicSSEStream(resp));
    const content = chunks.filter((c) => c.type === "content_delta");
    expect(content.length).toBe(1);
    expect(content[0]!.content).toBe("ok");
  });
});

// ─── Empty Response Edge Cases ──────────────────────────��───────

describe("SSE Parser — empty response edge cases", () => {
  test("thinking-only stream: reasoning_content but no content", async () => {
    const resp = mockResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Let me analyze this..." }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "The answer involves..." }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    const chunks = await collect(parseSSEStream(resp));
    const thinking = chunks.filter((c) => c.type === "thinking_delta");
    const content = chunks.filter((c) => c.type === "content_delta");
    const finish = chunks.filter((c) => c.type === "finish");
    expect(thinking.length).toBe(2);
    expect(content.length).toBe(0);
    expect(finish.length).toBe(1);
    expect(finish[0]!.finishReason).toBe("stop");
  });

  test("tool-calls-only stream: tool_calls but no content", async () => {
    const resp = mockResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: '{"file' } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '_path":"/x"}' } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    const chunks = await collect(parseSSEStream(resp));
    const content = chunks.filter((c) => c.type === "content_delta");
    const tools = chunks.filter((c) => c.type === "tool_call_delta");
    expect(content.length).toBe(0);
    expect(tools.length).toBe(2);
  });

  test("completely empty stream: finish with no deltas", async () => {
    const resp = mockResponse([
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    const chunks = await collect(parseSSEStream(resp));
    const content = chunks.filter((c) => c.type === "content_delta");
    const thinking = chunks.filter((c) => c.type === "thinking_delta");
    expect(content.length).toBe(0);
    expect(thinking.length).toBe(0);
    const finish = chunks.filter((c) => c.type === "finish");
    expect(finish.length).toBe(1);
  });

  test("thinking in <reasoning> tags but no visible text", async () => {
    const resp = mockResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "<reasoning>I need to think about" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: " this carefully.</reasoning>" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    const chunks = await collect(parseSSEStream(resp));
    const thinking = chunks.filter((c) => c.type === "thinking_delta");
    const content = chunks.filter((c) => c.type === "content_delta");
    // The thinking tag parser should extract reasoning as thinking_delta
    expect(thinking.length).toBeGreaterThan(0);
    // No visible content should come through
    expect(content.length).toBe(0);
  });

  test("stream with finish_reason but unexpected format", async () => {
    const resp = mockResponse([
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    const chunks = await collect(parseSSEStream(resp));
    const finish = chunks.filter((c) => c.type === "finish");
    expect(finish.length).toBe(1);
    expect(finish[0]!.finishReason).toBe("length");
  });
});
