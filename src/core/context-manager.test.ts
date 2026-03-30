import { test, expect, describe } from "bun:test";
import { estimateContextTokens, emergencyPrune } from "./context-manager.ts";
import type { Message, ConversationState, StreamEvent } from "./types.ts";

// CHARS_PER_TOKEN = 3.5 (from token-budget.ts)

// ─── Helper ─────────────────────────────────────────────────────

function makeState(messages: Message[], tokenCount = 0): ConversationState {
  return { messages, tokenCount, toolUseCount: 0 };
}

function makeMsg(role: "user" | "assistant", content: Message["content"]): Message {
  return { role, content };
}

/** Create N filler messages, each with `charsPerMsg` characters of content. */
function fillerMessages(n: number, charsPerMsg = 100): Message[] {
  return Array.from({ length: n }, (_, i) =>
    makeMsg(i % 2 === 0 ? "user" : "assistant", "x".repeat(charsPerMsg)),
  );
}

// ─── estimateContextTokens ──────────────────────────────────────

describe("estimateContextTokens", () => {
  test("empty prompt and no messages returns 0", () => {
    expect(estimateContextTokens("", [])).toBe(0);
  });

  test("prompt only — 350 chars yields ceil(350/3.5) = 100", () => {
    const prompt = "a".repeat(350);
    expect(estimateContextTokens(prompt, [])).toBe(100);
  });

  test("string message content counted by length", () => {
    const msg = makeMsg("user", "a".repeat(70)); // 70 chars
    // total = 70, ceil(70 / 3.5) = 20
    expect(estimateContextTokens("", [msg])).toBe(20);
  });

  test("array content with text blocks counted by text.length", () => {
    const msg = makeMsg("assistant", [
      { type: "text", text: "a".repeat(35) },
    ]);
    // 35 chars -> ceil(35/3.5) = 10
    expect(estimateContextTokens("", [msg])).toBe(10);
  });

  test("array content with tool_result (string) counted by content.length", () => {
    const msg = makeMsg("user", [
      { type: "tool_result", tool_use_id: "t1", content: "b".repeat(70) },
    ]);
    // 70 chars -> ceil(70/3.5) = 20
    expect(estimateContextTokens("", [msg])).toBe(20);
  });

  test("array content with tool_result (non-string) adds 100", () => {
    const msg = makeMsg("user", [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: [{ type: "text", text: "nested" }] as any,
      },
    ]);
    // 100 chars -> ceil(100/3.5) = ceil(28.57) = 29
    expect(estimateContextTokens("", [msg])).toBe(29);
  });

  test("array content with tool_use counted by JSON.stringify(input).length", () => {
    const input = { file: "test.ts" };
    const inputLen = JSON.stringify(input).length; // {"file":"test.ts"} = 18
    const msg = makeMsg("assistant", [
      { type: "tool_use", id: "tu1", name: "Read", input },
    ]);
    expect(estimateContextTokens("", [msg])).toBe(Math.ceil(inputLen / 3.5));
  });

  test("multiple messages accumulate chars", () => {
    const msgs: Message[] = [
      makeMsg("user", "a".repeat(35)),       // 35
      makeMsg("assistant", "b".repeat(35)),   // 35
    ];
    // total 70 -> ceil(70/3.5) = 20
    expect(estimateContextTokens("", msgs)).toBe(20);
  });

  test("prompt + messages combine", () => {
    const prompt = "p".repeat(35); // 35
    const msgs = [makeMsg("user", "u".repeat(35))]; // 35
    // total 70 -> 20
    expect(estimateContextTokens(prompt, msgs)).toBe(20);
  });

  test("thinking blocks are not counted", () => {
    const msg = makeMsg("assistant", [
      { type: "thinking", thinking: "a".repeat(1000) },
    ]);
    // thinking blocks don't match text/tool_result/tool_use → 0 chars
    expect(estimateContextTokens("", [msg])).toBe(0);
  });

  test("mixed content blocks sum correctly", () => {
    const input = { a: 1 }; // JSON.stringify = {"a":1} -> 7 chars
    const msg = makeMsg("assistant", [
      { type: "text", text: "a".repeat(35) },                          // 35
      { type: "tool_use", id: "tu1", name: "Bash", input },            // 7
      { type: "tool_result", tool_use_id: "tu1", content: "c".repeat(28) }, // 28
    ]);
    // total = 35 + 7 + 28 = 70 -> ceil(70/3.5) = 20
    expect(estimateContextTokens("", [msg])).toBe(20);
  });
});

// ─── emergencyPrune ─────────────────────────────────────────────

describe("emergencyPrune", () => {
  test("under 95% threshold returns empty array", () => {
    // 10 messages of 100 chars each = 1000 chars -> ~286 tokens
    // contextWindow = 1000, 95% = 950 -> 286 < 950 -> no prune
    const state = makeState(fillerMessages(10, 100));
    const events = emergencyPrune(state, "", 1000);
    expect(events).toEqual([]);
  });

  test("<=6 messages returns empty array even if over 95%", () => {
    // 6 messages of 1000 chars = 6000 chars -> ~1715 tokens
    // contextWindow = 100, 95% = 95 -> over threshold, but only 6 messages
    const state = makeState(fillerMessages(6, 1000));
    const events = emergencyPrune(state, "", 100);
    expect(events).toEqual([]);
  });

  test("exactly 6 messages over threshold still returns empty (boundary)", () => {
    const state = makeState(fillerMessages(6, 5000));
    const events = emergencyPrune(state, "", 10);
    expect(events).toEqual([]);
  });

  test("over 95% with many messages drops ~30% and returns compaction events", () => {
    // 20 messages of 350 chars = 7000 chars -> ceil(7000/3.5) = 2000 tokens
    // contextWindow = 2000, 95% = 1900 -> 2000 >= 1900 -> prune
    const msgs = fillerMessages(20, 350);
    const state = makeState(msgs);
    const contextWindow = 2000;

    const events = emergencyPrune(state, "", contextWindow);

    // Should return exactly 2 events: compaction_start + compaction_end
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "compaction_start" });
    expect(events[1]).toMatchObject({ type: "compaction_end", method: "pruned" });
  });

  test("drop count is max(2, floor(messages.length * 0.3))", () => {
    // 20 messages -> floor(20 * 0.3) = 6, max(2, 6) = 6
    const msgs = fillerMessages(20, 350);
    const state = makeState(msgs);
    const events = emergencyPrune(state, "", 2000);
    const startEvent = events[0] as { type: "compaction_start"; messageCount: number };
    expect(startEvent.messageCount).toBe(6);
  });

  test("small message count uses minimum drop of 2", () => {
    // 7 messages of 350 chars = 2450 chars -> ceil(2450/3.5) = 700 tokens
    // contextWindow = 700, 95% = 665 -> 700 >= 665 -> prune
    // floor(7 * 0.3) = 2, max(2, 2) = 2
    const msgs = fillerMessages(7, 350);
    const state = makeState(msgs);
    const events = emergencyPrune(state, "", 700);
    const startEvent = events[0] as { type: "compaction_start"; messageCount: number };
    expect(startEvent.messageCount).toBe(2);
  });

  test("first message is preserved after pruning", () => {
    const msgs = fillerMessages(20, 350);
    const firstMsg = { ...msgs[0]! };
    const state = makeState(msgs);
    emergencyPrune(state, "", 2000);

    // First message content should be unchanged
    expect(state.messages[0]!.content).toBe(firstMsg.content);
    expect(state.messages[0]!.role).toBe(firstMsg.role);
  });

  test("system message inserted after pruning", () => {
    const msgs = fillerMessages(20, 350);
    const state = makeState(msgs);
    emergencyPrune(state, "", 2000);

    // Second message should be the system notification
    const sysMsg = state.messages[1]!;
    expect(sysMsg.role).toBe("user");
    expect(typeof sysMsg.content).toBe("string");
    expect((sysMsg.content as string)).toContain("[SYSTEM]");
    expect((sysMsg.content as string)).toContain("emergency-pruned");
  });

  test("message count decreases after pruning", () => {
    const msgs = fillerMessages(20, 350);
    const originalLength = msgs.length;
    const state = makeState(msgs);
    emergencyPrune(state, "", 2000);

    // 20 original - 6 dropped (from rest[6:]) + 1 system msg inserted = 15
    // kept[0] + system + rest.slice(6) = 1 + 1 + (19 - 6) = 15
    expect(state.messages.length).toBe(originalLength - 6 + 1);
  });

  test("tokenCount is updated on state after pruning", () => {
    const msgs = fillerMessages(20, 350);
    const state = makeState(msgs, 0);
    emergencyPrune(state, "", 2000);

    // tokenCount should now reflect the pruned messages
    const expected = estimateContextTokens("", state.messages);
    expect(state.tokenCount).toBe(expected);
  });
});
