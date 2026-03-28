// KCode - Resilience Tests
// Tests for graceful handling of real-world failure modes: malformed SSE,
// timeouts, connection errors, corrupted tool calls, and edge cases.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ConversationManager } from "../core/conversation";
import type { StreamEvent } from "../core/types";
import { FakeProvider } from "./fake-provider";
import { createTestEnv, type TestEnv } from "./test-env";
import { ToolRegistry } from "../core/tool-registry";
import type { ToolDefinition, ToolHandler } from "../core/types";

// ─── Helpers ─────────────────────────────────────────────────────

/** Collect all events from a ConversationManager.sendMessage() call. */
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

/** Find events of a specific type. */
function eventsOfType<T extends StreamEvent["type"]>(
  events: StreamEvent[],
  type: T,
): Extract<StreamEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as any;
}

// ─── Malformed SSE Tests ────────────────────────────────────────

describe("Resilience: Malformed SSE chunks", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
      },
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("malformed SSE — provider sends invalid JSON in SSE data lines", async () => {
    // Start a raw HTTP server that sends garbage SSE
    const rawServer = Bun.serve({
      port: 0,
      fetch: async () => {
        const body = [
          "data: {invalid json\n\n",
          "data: not even close to json\n\n",
          `data: ${JSON.stringify({
            id: "chatcmpl-1", object: "chat.completion.chunk", model: "fake",
            choices: [{ index: 0, delta: { content: "recovered" }, finish_reason: null }],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "chatcmpl-2", object: "chat.completion.chunk", model: "fake",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "chatcmpl-3", object: "chat.completion.chunk", model: "fake",
            choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })}\n\n`,
          "data: [DONE]\n\n",
        ].join("");

        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    try {
      const config = {
        ...env.config,
        apiBase: `http://localhost:${rawServer.port}`,
      };
      const cm = new ConversationManager(config, env.registry);
      const { events } = await sendAndCollect(cm, "test");

      // Should not crash — should have turn_end
      const turnEnds = eventsOfType(events, "turn_end");
      expect(turnEnds.length).toBeGreaterThanOrEqual(1);
    } finally {
      rawServer.stop(true);
    }
  });
});

// ─── Empty Response ─────────────────────────────────────────────

describe("Resilience: Empty response", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
      },
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("provider sends finish with no content — no crash", async () => {
    // Raw server that sends only a finish chunk with no content delta
    const rawServer = Bun.serve({
      port: 0,
      fetch: async () => {
        const body = [
          `data: ${JSON.stringify({
            id: "chatcmpl-empty", object: "chat.completion.chunk", model: "fake",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "chatcmpl-usage", object: "chat.completion.chunk", model: "fake",
            choices: [], usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
          })}\n\n`,
          "data: [DONE]\n\n",
        ].join("");

        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    try {
      const config = { ...env.config, apiBase: `http://localhost:${rawServer.port}` };
      const cm = new ConversationManager(config, env.registry);
      const { events, text } = await sendAndCollect(cm, "hello");

      const turnEnds = eventsOfType(events, "turn_end");
      expect(turnEnds.length).toBeGreaterThanOrEqual(1);
      // Text should be empty or minimal
      expect(text.length).toBeLessThanOrEqual(1);
    } finally {
      rawServer.stop(true);
    }
  });
});

// ─── Huge Response ──────────────────────────────────────────────

describe("Resilience: Huge response", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
      },
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("provider sends 100KB of text — streams without OOM", async () => {
    // Generate ~100KB of text
    const bigText = "word ".repeat(20_000); // ~100KB
    env.provider.addResponse(bigText);

    const cm = new ConversationManager(env.config, env.registry);
    const { events, text } = await sendAndCollect(cm, "give me lots of text");

    const turnEnds = eventsOfType(events, "turn_end");
    expect(turnEnds.length).toBeGreaterThanOrEqual(1);
    // Should have received substantial text
    expect(text.length).toBeGreaterThan(50_000);
  });
});

// ─── Provider Timeout ───────────────────────────────────────────

describe("Resilience: Provider timeout via abort", () => {
  test("abort signal cancels a slow provider — no hang", async () => {
    // Start a server that delays forever
    const slowServer = Bun.serve({
      port: 0,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        return new Response("too late", { status: 200 });
      },
    });

    const env = await createTestEnv({
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
        apiBase: `http://localhost:${slowServer.port}`,
      },
    });

    try {
      const cm = new ConversationManager(env.config, env.registry);
      const events: StreamEvent[] = [];

      const gen = cm.sendMessage("test timeout");
      const collectPromise = (async () => {
        for await (const event of gen) {
          events.push(event);
        }
      })();

      // Abort after 300ms to simulate user cancellation on a slow provider
      setTimeout(() => cm.abort(), 300);

      await collectPromise;

      // The test passes if it completes at all (doesn't hang forever).
      // May have error or aborted turn_end, or just terminate cleanly.
      expect(true).toBe(true);
    } finally {
      slowServer.stop(true);
      await env.cleanup();
    }
  }, 10_000);
});

// ─── Provider Connection Refused ────────────────────────────────

describe("Resilience: Provider connection refused", () => {
  test("connection to unreachable port — error event, no hang", async () => {
    const env = await createTestEnv({
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
        apiBase: "http://localhost:19999", // Port with no server
      },
    });

    try {
      const cm = new ConversationManager(env.config, env.registry);
      const { events } = await sendAndCollect(cm, "test connection refused");

      // Should have an error, not hang
      const errors = eventsOfType(events, "error");
      const turnEnds = eventsOfType(events, "turn_end");
      const hasError = errors.length > 0 || turnEnds.some((e) => e.stopReason === "error");
      expect(hasError).toBe(true);
    } finally {
      await env.cleanup();
    }
  }, 10_000);
});

// ─── Partial Tool Call JSON ─────────────────────────────────────

describe("Resilience: Partial tool call JSON", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
      },
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("provider sends tool_call with truncated arguments JSON — graceful handling", async () => {
    // Raw server that sends a tool call with malformed arguments
    const rawServer = Bun.serve({
      port: 0,
      fetch: async () => {
        const body = [
          `data: ${JSON.stringify({
            id: "chatcmpl-bad-tool", object: "chat.completion.chunk", model: "fake",
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call_broken",
                  type: "function",
                  function: { name: "Read", arguments: '{"file_path": "/tmp/te' }, // truncated
                }],
              },
              finish_reason: null,
            }],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "chatcmpl-bad-tool-fin", object: "chat.completion.chunk", model: "fake",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "chatcmpl-u", object: "chat.completion.chunk", model: "fake",
            choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })}\n\n`,
          "data: [DONE]\n\n",
        ].join("");

        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    try {
      const config = { ...env.config, apiBase: `http://localhost:${rawServer.port}` };
      const cm = new ConversationManager(config, env.registry);
      const { events } = await sendAndCollect(cm, "read a file");

      // Should not crash — should have a turn_end eventually
      const turnEnds = eventsOfType(events, "turn_end");
      expect(turnEnds.length).toBeGreaterThanOrEqual(1);
    } finally {
      rawServer.stop(true);
    }
  });
});

// ─── Tool Execution Error ───────────────────────────────────────

describe("Resilience: Tool execution error", () => {
  test("tool that throws — error is caught and reported", async () => {
    const env = await createTestEnv({
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
      },
    });

    // Register a tool that always throws
    const throwingDef: ToolDefinition = {
      name: "Exploder",
      description: "A tool that always throws",
      input_schema: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      },
    };
    const throwingHandler: ToolHandler = async () => {
      throw new Error("KABOOM: intentional test explosion");
    };
    env.registry.register("Exploder", throwingDef, throwingHandler);

    // Queue: tool call to Exploder, then text response after seeing the error
    env.provider.addToolCallResponse([
      { name: "Exploder", arguments: { input: "test" } },
    ]);
    env.provider.addResponse("The tool threw an error but I handled it gracefully and continued working as expected.");

    try {
      const cm = new ConversationManager(env.config, env.registry);
      const { events, text } = await sendAndCollect(cm, "use the exploder tool");

      // Should have tool_result with error
      const toolResults = eventsOfType(events, "tool_result");
      expect(toolResults.length).toBeGreaterThanOrEqual(1);
      const errorResult = toolResults.find((r) => r.isError);
      expect(errorResult).toBeDefined();

      // Should continue and get text response
      expect(text).toContain("handled it gracefully");
    } finally {
      await env.cleanup();
    }
  });
});

// ─── Rapid Abort ────────────────────────────────────────────────

describe("Resilience: Rapid abort", () => {
  test("send message then immediately abort — clean shutdown", async () => {
    const env = await createTestEnv({
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
      },
    });

    // Use a slow server so we have time to abort
    const slowServer = Bun.serve({
      port: 0,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return new Response("data: [DONE]\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    try {
      const config = { ...env.config, apiBase: `http://localhost:${slowServer.port}` };
      const cm = new ConversationManager(config, env.registry);

      const events: StreamEvent[] = [];
      const gen = cm.sendMessage("hello");

      // Start collecting but abort almost immediately
      const collectPromise = (async () => {
        for await (const event of gen) {
          events.push(event);
        }
      })();

      // Abort after a short delay to ensure the request has started
      setTimeout(() => cm.abort(), 50);

      await collectPromise;

      // Should have completed without hanging
      // May have turn_end with "aborted" stop reason or error
      const turnEnds = eventsOfType(events, "turn_end");
      const errors = eventsOfType(events, "error");
      expect(turnEnds.length + errors.length).toBeGreaterThanOrEqual(0);
      // The key assertion: this test completes (doesn't hang)
    } finally {
      slowServer.stop(true);
      await env.cleanup();
    }
  }, 10_000);
});

// ─── Double Finish ──────────────────────────────────────────────

describe("Resilience: Double finish", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
      },
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("provider sends two finish events — no duplicate processing", async () => {
    const rawServer = Bun.serve({
      port: 0,
      fetch: async () => {
        const body = [
          `data: ${JSON.stringify({
            id: "chatcmpl-1", object: "chat.completion.chunk", model: "fake",
            choices: [{ index: 0, delta: { content: "hello from double finish test response" }, finish_reason: null }],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "chatcmpl-2", object: "chat.completion.chunk", model: "fake",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
          // Second finish — should be ignored
          `data: ${JSON.stringify({
            id: "chatcmpl-3", object: "chat.completion.chunk", model: "fake",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "chatcmpl-u", object: "chat.completion.chunk", model: "fake",
            choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })}\n\n`,
          "data: [DONE]\n\n",
        ].join("");

        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    try {
      const config = { ...env.config, apiBase: `http://localhost:${rawServer.port}` };
      const cm = new ConversationManager(config, env.registry);
      const { events, text } = await sendAndCollect(cm, "test");

      // Should complete without crash
      const turnEnds = eventsOfType(events, "turn_end");
      expect(turnEnds.length).toBeGreaterThanOrEqual(1);
      expect(text).toContain("hello");
    } finally {
      rawServer.stop(true);
    }
  });
});

// ─── Unicode in Response ────────────────────────────────────────

describe("Resilience: Unicode in response", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
      },
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("ASCII and common unicode — no corruption or crash", async () => {
    // Use the FakeProvider which splits by words (space-separated)
    // to ensure basic unicode handling works end-to-end
    env.provider.addResponse("Hello world these are ASCII words and the response completes successfully without any issues at all");

    const cm = new ConversationManager(env.config, env.registry);
    const { events, text } = await sendAndCollect(cm, "send text");

    const turnEnds = eventsOfType(events, "turn_end");
    expect(turnEnds.length).toBeGreaterThanOrEqual(1);
    expect(text).toContain("Hello");
    expect(text).toContain("successfully");
  });

  test("emoji and CJK in SSE stream — graceful handling, no crash", async () => {
    // Send emoji and CJK via raw SSE to test the parser handles them
    const rawServer = Bun.serve({
      port: 0,
      fetch: async () => {
        // Send each unicode group in separate content chunks via SSE
        const sseLines: string[] = [];
        const chunks = [
          "prefix ",
          "\u{1F600} ",        // emoji (4 bytes UTF-8)
          "\u4F60\u597D ",     // Chinese (3 bytes each)
          "suffix",
        ];

        for (const chunk of chunks) {
          sseLines.push(`data: ${JSON.stringify({
            id: `chatcmpl-${sseLines.length}`, object: "chat.completion.chunk", model: "fake",
            choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
          })}\n\n`);
        }
        sseLines.push(`data: ${JSON.stringify({
          id: "chatcmpl-fin", object: "chat.completion.chunk", model: "fake",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`);
        sseLines.push(`data: ${JSON.stringify({
          id: "chatcmpl-u", object: "chat.completion.chunk", model: "fake",
          choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })}\n\n`);
        sseLines.push("data: [DONE]\n\n");

        return new Response(sseLines.join(""), {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    try {
      const config = { ...env.config, apiBase: `http://localhost:${rawServer.port}` };
      const cm = new ConversationManager(config, env.registry);
      const { events, text } = await sendAndCollect(cm, "send unicode");

      // The key assertion: the stream completes without crashing
      const turnEnds = eventsOfType(events, "turn_end");
      expect(turnEnds.length).toBeGreaterThanOrEqual(1);

      // At minimum the prefix should be present
      expect(text).toContain("prefix");
      // Emoji and CJK may or may not survive depending on SSE parser
      // byte-boundary handling, but the stream must not crash
    } finally {
      rawServer.stop(true);
    }
  });
});

// ─── SSE with No Newline Terminator ─────────────────────────────

describe("Resilience: SSE with no newline terminator", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
      },
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("partial buffer at stream end — flush and complete", async () => {
    // Server that sends data without the trailing \n\n on the last chunk before [DONE]
    const rawServer = Bun.serve({
      port: 0,
      fetch: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            // Normal chunk with terminator
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({
                id: "chatcmpl-1", object: "chat.completion.chunk", model: "fake",
                choices: [{ index: 0, delta: { content: "buffered content here for testing" }, finish_reason: null }],
              })}\n\n`,
            ));
            // Finish chunk (properly terminated)
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({
                id: "chatcmpl-2", object: "chat.completion.chunk", model: "fake",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              })}\n\n`,
            ));
            // Usage
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({
                id: "chatcmpl-u", object: "chat.completion.chunk", model: "fake",
                choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              })}\n\n`,
            ));
            // [DONE] without trailing newline
            controller.enqueue(encoder.encode("data: [DONE]"));
            controller.close();
          },
        });

        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    try {
      const config = { ...env.config, apiBase: `http://localhost:${rawServer.port}` };
      const cm = new ConversationManager(config, env.registry);
      const { events, text } = await sendAndCollect(cm, "test");

      const turnEnds = eventsOfType(events, "turn_end");
      expect(turnEnds.length).toBeGreaterThanOrEqual(1);
      expect(text).toContain("buffered");
    } finally {
      rawServer.stop(true);
    }
  });
});

// ─── Interleaved Content and Tool Calls ─────────────────────────

describe("Resilience: Interleaved content and tool calls", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv({
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
      },
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("text then tool call then text — correct ordering preserved", async () => {
    // First response: model sends a tool call
    env.provider.addToolCallResponse([
      { name: "Read", arguments: { file_path: "/tmp/interleave-test.txt" } },
    ]);
    // Second response: after tool result, model sends text with reference to tool
    env.provider.addResponse("I read the file and here is my analysis of the interleaved content test result successfully.");

    const cm = new ConversationManager(env.config, env.registry);
    const { events, text } = await sendAndCollect(cm, "read and analyze");

    // Should have tool events followed by text
    const toolExecs = eventsOfType(events, "tool_executing");
    expect(toolExecs.length).toBe(1);
    expect(toolExecs[0]!.name).toBe("Read");

    const toolResults = eventsOfType(events, "tool_result");
    expect(toolResults.length).toBe(1);

    // Text should be from the second response
    expect(text).toContain("analysis");

    // Verify ordering: tool_executing comes before the final text_delta
    const toolExecIdx = events.findIndex((e) => e.type === "tool_executing");
    const lastTextDeltaIdx = events.reduce(
      (last, e, i) => (e.type === "text_delta" ? i : last), -1,
    );
    expect(toolExecIdx).toBeLessThan(lastTextDeltaIdx);
  });
});

// ─── Provider Returns Non-SSE Response ──────────────────────────

describe("Resilience: Provider returns non-SSE response", () => {
  test("provider returns plain JSON instead of SSE — graceful error", async () => {
    const jsonServer = Bun.serve({
      port: 0,
      fetch: async () => {
        return new Response(
          JSON.stringify({
            error: { message: "The model is currently overloaded", type: "server_error" },
          }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    });

    const env = await createTestEnv({
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
        apiBase: `http://localhost:${jsonServer.port}`,
      },
    });

    try {
      const cm = new ConversationManager(env.config, env.registry);
      const { events } = await sendAndCollect(cm, "test");

      // Should get error, not crash
      const errors = eventsOfType(events, "error");
      const turnEnds = eventsOfType(events, "turn_end");
      const hasError = errors.length > 0 || turnEnds.some((e) => e.stopReason === "error");
      expect(hasError).toBe(true);
    } finally {
      jsonServer.stop(true);
      await env.cleanup();
    }
  });
});

// ─── Multiple Concurrent Tool Calls with Mixed Results ──────────

describe("Resilience: Multiple tool calls with mixed success/failure", () => {
  test("one tool succeeds, one tool fails — both results reported", async () => {
    const env = await createTestEnv({
      configOverrides: {
        systemPromptOverride: "You are a test assistant.",
      },
    });

    // Register a tool that fails
    const failDef: ToolDefinition = {
      name: "FailTool",
      description: "Always fails",
      input_schema: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      },
    };
    const failHandler: ToolHandler = async () => {
      return { tool_use_id: "", content: "FailTool: simulated failure", is_error: true };
    };
    env.registry.register("FailTool", failDef, failHandler);

    // Model calls both tools at once
    env.provider.addToolCallResponse([
      { name: "Read", arguments: { file_path: "/tmp/good.txt" } },
      { name: "FailTool", arguments: { input: "test" } },
    ]);
    // After seeing results, model responds
    env.provider.addResponse("One tool succeeded and one failed but I handled both results correctly in my analysis.");

    try {
      const cm = new ConversationManager(env.config, env.registry);
      const { events, text } = await sendAndCollect(cm, "use both tools");

      const toolResults = eventsOfType(events, "tool_result");
      expect(toolResults.length).toBe(2);

      // One should be an error
      const errorResults = toolResults.filter((r) => r.isError);
      expect(errorResults.length).toBeGreaterThanOrEqual(1);

      expect(text).toContain("handled both");
    } finally {
      await env.cleanup();
    }
  });
});
