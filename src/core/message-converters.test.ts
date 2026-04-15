// KCode - Message Converter Tests
// Tests for OpenAI and Anthropic message/tool format converters

import { describe, expect, test } from "bun:test";
import {
  convertToAnthropicMessages,
  convertToAnthropicTools,
  convertToOpenAIMessages,
  convertToOpenAITools,
} from "./message-converters";
import type { Message } from "./types";

// ─── OpenAI Message Conversion ──────────────────────────────────

describe("convertToOpenAIMessages", () => {
  test("prepends system message from systemPrompt", () => {
    const result = convertToOpenAIMessages("You are helpful.", []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "system", content: "You are helpful." });
  });

  test("omits system message when systemPrompt is empty", () => {
    const result = convertToOpenAIMessages("", []);
    expect(result).toHaveLength(0);
  });

  test("converts simple string messages", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    const result = convertToOpenAIMessages("sys", messages);
    expect(result).toHaveLength(3); // system + 2
    expect(result[1]).toEqual({ role: "user", content: "Hello" });
    expect(result[2]).toEqual({ role: "assistant", content: "Hi there" });
  });

  test("converts assistant tool_use blocks to tool_calls", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "tc_1", name: "Read", input: { file_path: "/foo.ts" } },
        ],
      },
    ];
    const result = convertToOpenAIMessages("", messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("assistant");
    expect(result[0]!.content).toBe("Let me check.");
    expect(result[0]!.tool_calls).toHaveLength(1);
    expect(result[0]!.tool_calls![0]).toEqual({
      id: "tc_1",
      type: "function",
      function: { name: "Read", arguments: '{"file_path":"/foo.ts"}' },
    });
  });

  test("converts thinking blocks to text with tags", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "step by step" },
          { type: "text", text: "Answer" },
        ],
      },
    ];
    const result = convertToOpenAIMessages("", messages);
    expect(result[0]!.content).toContain("<thinking>step by step</thinking>");
    expect(result[0]!.content).toContain("Answer");
  });

  test("converts user tool_result blocks to tool role messages", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tc_1", content: "file contents here" }],
      },
    ];
    const result = convertToOpenAIMessages("", messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("tool");
    expect(result[0]!.tool_call_id).toBe("tc_1");
    expect(result[0]!.content).toBe("file contents here");
  });

  test("handles user message with both text and tool_result", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tc_1", content: "result data" },
          { type: "text", text: "Also this note" },
        ],
      },
    ];
    const result = convertToOpenAIMessages("", messages);
    // tool result first, then user text
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe("tool");
    expect(result[1]!).toEqual({ role: "user", content: "Also this note" });
  });

  test("handles tool_result with array content", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tc_2",
            content: [
              { type: "text", text: "line 1" },
              { type: "text", text: "line 2" },
            ],
          },
        ],
      },
    ];
    const result = convertToOpenAIMessages("", messages);
    expect(result[0]!.content).toBe("line 1\nline 2");
  });

  test("assistant with only tool_use (no text) sets content to null", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tc_1", name: "Bash", input: { command: "ls" } }],
      },
    ];
    const result = convertToOpenAIMessages("", messages);
    expect(result[0]!.content).toBeNull();
    expect(result[0]!.tool_calls).toHaveLength(1);
  });
});

// ─── OpenAI Tool Conversion ─────────────────────────────────────

describe("convertToOpenAITools", () => {
  test("converts tool definitions to function format", () => {
    const tools = [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ];
    const result = convertToOpenAITools(tools);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("function");
    expect(result[0]!.function.name).toBe("Read");
    expect(result[0]!.function.description).toBe("Read a file");
    expect(result[0]!.function.parameters).toEqual(tools[0]!.input_schema);
  });

  test("handles empty tool list", () => {
    expect(convertToOpenAITools([])).toEqual([]);
  });
});

// ─── Anthropic Message Conversion ───────────────────────────────

describe("convertToAnthropicMessages", () => {
  test("converts simple string messages preserving roles", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];
    const result = convertToAnthropicMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "Hello" });
    expect(result[1]).toEqual({ role: "assistant", content: "Hi" });
  });

  test("merges consecutive same-role string messages", () => {
    const messages: Message[] = [
      { role: "user", content: "Part 1" },
      { role: "user", content: "Part 2" },
    ];
    const result = convertToAnthropicMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toContain("Part 1");
    expect(result[0]!.content).toContain("Part 2");
  });

  test("prepends user message if conversation starts with assistant", () => {
    const messages: Message[] = [{ role: "assistant", content: "I am ready" }];
    const result = convertToAnthropicMessages(messages);
    expect(result[0]!.role).toBe("user");
    expect(result[1]!.role).toBe("assistant");
  });

  test("converts tool_use blocks in assistant messages", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }],
      },
    ];
    // Need a leading user message
    const withUser: Message[] = [{ role: "user", content: "do it" }, ...messages];
    const result = convertToAnthropicMessages(withUser);
    const assistantMsg = result.find((m) => m.role === "assistant")!;
    expect(Array.isArray(assistantMsg.content)).toBe(true);
    const blocks = assistantMsg.content as any[];
    expect(blocks[0].type).toBe("tool_use");
    expect(blocks[0].name).toBe("Bash");
    expect(blocks[0].id).toBe("tu_1");
  });

  test("converts tool_result blocks in user messages", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/x" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file data" }],
      },
    ];
    const result = convertToAnthropicMessages(messages);
    const lastUser = result[result.length - 1]!;
    expect(lastUser.role).toBe("user");
    const blocks = lastUser.content as any[];
    expect(blocks[0].type).toBe("tool_result");
    expect(blocks[0].tool_use_id).toBe("tu_1");
    expect(blocks[0].content).toBe("file data");
  });

  test("skips empty content blocks", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [] },
    ];
    const result = convertToAnthropicMessages(messages);
    // Empty assistant content should be skipped
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("user");
  });

  // ─── Orphan tool_use sanitization ─────────────────────────────
  //
  // Regression tests for the v2.10.76 bug where phase-20 (pkill guard)
  // blocked a bash call and some code path failed to emit the synthetic
  // tool_result, sending the orphan to Anthropic and hitting
  //   400 "tool_use ids were found without tool_result blocks
  //        immediately after: toolu_..."
  // Both claude-opus-4-6 and claude-sonnet-4-6 died on the same bug
  // during the NEXUS Telemetry session. The sanitizer is a serialization-
  // layer safety net that synthesizes a tool_result for any orphan.

  test("synthesizes tool_result for orphan tool_use when next message is missing", () => {
    const messages: Message[] = [
      { role: "user", content: "run pkill" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "toolu_orphan1", name: "Bash", input: { command: "pkill -9 node" } },
        ],
      },
    ];
    const result = convertToAnthropicMessages(messages);
    // Should have inserted a user message with synthetic tool_result
    expect(result).toHaveLength(3);
    const injected = result[2]!;
    expect(injected.role).toBe("user");
    expect(Array.isArray(injected.content)).toBe(true);
    const blocks = injected.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("tool_result");
    expect(blocks[0]!.tool_use_id).toBe("toolu_orphan1");
    expect(blocks[0]!.is_error).toBe(true);
  });

  test("synthesizes tool_result when next message is plain user text (no tool_result)", () => {
    const messages: Message[] = [
      { role: "user", content: "first" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_X", name: "Bash", input: { command: "ls" } }],
      },
      // User typed a follow-up before the tool result arrived — orphan
      { role: "user", content: "wait, stop" },
    ];
    const result = convertToAnthropicMessages(messages);
    // Sanitizer should inject synthetic tool_result BEFORE the user's
    // follow-up text, keeping the assistant tool_use paired.
    expect(result.length).toBeGreaterThanOrEqual(3);
    // Find the message right after the assistant with tool_use
    const assistantIdx = result.findIndex(
      (m) => m.role === "assistant" && Array.isArray(m.content),
    );
    const next = result[assistantIdx + 1];
    expect(next).toBeDefined();
    expect(next!.role).toBe("user");
    const blocks = next!.content as Array<{ type: string; tool_use_id?: string }>;
    const toolResults = blocks.filter((b) => b.type === "tool_result");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect(toolResults[0]!.tool_use_id).toBe("toolu_X");
  });

  test("appends missing tool_result when next message has partial pairing", () => {
    const messages: Message[] = [
      { role: "user", content: "do two things" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_A", name: "Read", input: { file_path: "/a" } },
          { type: "tool_use", id: "toolu_B", name: "Read", input: { file_path: "/b" } },
        ],
      },
      {
        role: "user",
        content: [
          // Only B has a result, A is an orphan
          { type: "tool_result", tool_use_id: "toolu_B", content: "b data" },
        ],
      },
    ];
    const result = convertToAnthropicMessages(messages);
    expect(result).toHaveLength(3);
    const toolResultMsg = result[2]!;
    const blocks = toolResultMsg.content as Array<{ type: string; tool_use_id?: string }>;
    const ids = blocks
      .filter((b) => b.type === "tool_result")
      .map((b) => b.tool_use_id);
    // Both A and B must be present; order is implementation-defined but
    // the important invariant is both ids appear.
    expect(ids).toContain("toolu_A");
    expect(ids).toContain("toolu_B");
  });

  test("leaves correctly-paired tool_use/tool_result alone", () => {
    const messages: Message[] = [
      { role: "user", content: "read a file" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_ok", name: "Read", input: { file_path: "/x" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_ok", content: "x contents" }],
      },
    ];
    const before = JSON.stringify(convertToAnthropicMessages(messages));
    // Re-running should not mutate — convertToAnthropicMessages must be idempotent
    const after = JSON.stringify(convertToAnthropicMessages(messages));
    expect(before).toBe(after);
    // Structure should have exactly 3 messages, no synthetic injection
    const result = convertToAnthropicMessages(messages);
    expect(result).toHaveLength(3);
    const tr = (result[2]!.content as Array<{ type: string }>).filter(
      (b) => b.type === "tool_result",
    );
    expect(tr).toHaveLength(1);
  });
});

// ─── Anthropic Tool Conversion ──────────────────────────────────

describe("convertToAnthropicTools", () => {
  test("passes through tool definitions (already Anthropic format)", () => {
    const tools = [{ name: "Edit", description: "Edit a file", input_schema: { type: "object" } }];
    const result = convertToAnthropicTools(tools);
    expect(result).toEqual([
      { name: "Edit", description: "Edit a file", input_schema: { type: "object" } },
    ]);
  });

  test("handles empty tool list", () => {
    expect(convertToAnthropicTools([])).toEqual([]);
  });
});
