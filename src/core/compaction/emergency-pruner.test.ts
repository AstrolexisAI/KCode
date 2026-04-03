import { describe, expect, test } from "bun:test";
import { emergencyPrune, type Message } from "./emergency-pruner";

function makeMessages(count: number): Message[] {
  const msgs: Message[] = [{ role: "system", content: "You are helpful." }];
  for (let i = 0; i < count; i++) {
    msgs.push({ role: "user", content: `Question ${i}: ${"x".repeat(200)}` });
    msgs.push({ role: "assistant", content: `Answer ${i}: ${"y".repeat(200)}` });
    msgs.push({ role: "tool", content: `Result ${i}: ${"z".repeat(5000)}` });
  }
  return msgs;
}

describe("emergencyPrune", () => {
  describe("no pruning needed", () => {
    test("returns original when currentTokens <= targetTokens", () => {
      const msgs = makeMessages(2);
      const { messages, result } = emergencyPrune(msgs, {
        pinnedIndices: new Set(),
        currentTokens: 1000,
        targetTokens: 2000,
      });
      expect(messages).toEqual(msgs);
      expect(result.estimatedTokensFreed).toBe(0);
    });
  });

  describe("truncate-tools strategy", () => {
    test("truncates large tool results", () => {
      const msgs: Message[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
        { role: "tool", content: "x".repeat(20000) },
      ];
      const { messages, result } = emergencyPrune(msgs, {
        pinnedIndices: new Set(),
        currentTokens: 6000,
        targetTokens: 3000,
      });
      const toolMsg = messages.find((m) => m.role === "tool")!;
      expect(typeof toolMsg.content === "string" ? toolMsg.content.length : 0).toBeLessThan(20000);
      expect(result.strategy).toBe("truncate-tools");
    });

    test("respects pinned indices — pinned tool not truncated", () => {
      const msgs: Message[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "q1" },
        { role: "tool", content: "x".repeat(20000), name: "pinned-tool" },
        { role: "tool", content: "y".repeat(20000), name: "unpinned-tool" },
      ];
      const { messages } = emergencyPrune(msgs, {
        pinnedIndices: new Set([2]), // pin first tool at index 2
        currentTokens: 12000,
        targetTokens: 8000,
      });
      // Find both tool messages
      const pinned = messages.find((m) => (m as any).name === "pinned-tool");
      const unpinned = messages.find((m) => (m as any).name === "unpinned-tool");
      // Pinned should be intact, unpinned should be truncated
      if (pinned) {
        expect((pinned.content as string).length).toBe(20000);
      }
      if (unpinned) {
        expect((unpinned.content as string).length).toBeLessThan(20000);
      }
    });
  });

  describe("remove-old-turns strategy", () => {
    test("removes old messages keeping last 20%", () => {
      const msgs = makeMessages(10); // 31 messages (1 system + 30)
      const { messages } = emergencyPrune(msgs, {
        pinnedIndices: new Set(),
        currentTokens: 20000,
        targetTokens: 2000,
      });
      expect(messages.length).toBeLessThan(msgs.length);
      // System message always kept
      expect(messages[0].role).toBe("system");
    });
  });

  describe("strip-tool-results strategy", () => {
    test("replaces tool results with placeholder", () => {
      const msgs: Message[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
        { role: "tool", content: "x".repeat(100) },
      ];
      // Force escalation past truncate and remove
      const { messages } = emergencyPrune(msgs, {
        pinnedIndices: new Set(),
        currentTokens: 50000,
        targetTokens: 100,
      });
      // Find tool messages
      const toolMsgs = messages.filter((m) => m.role === "tool");
      for (const t of toolMsgs) {
        const text = typeof t.content === "string" ? t.content : "";
        expect(text.length).toBeLessThan(50);
      }
    });
  });

  describe("nuclear strategy", () => {
    test("keeps only system + last turn", () => {
      const msgs = makeMessages(20); // Many messages
      const { messages, result } = emergencyPrune(msgs, {
        pinnedIndices: new Set(),
        currentTokens: 100000,
        targetTokens: 10,
      });
      expect(result.strategy).toBe("nuclear");
      expect(messages.length).toBeLessThanOrEqual(3);
      expect(messages[0].role).toBe("system");
    });

    test("nuclear warning is descriptive", () => {
      const msgs = makeMessages(5);
      const { result } = emergencyPrune(msgs, {
        pinnedIndices: new Set(),
        currentTokens: 100000,
        targetTokens: 1,
      });
      expect(result.warning).toContain("NUCLEAR");
    });
  });

  describe("array content format", () => {
    test("handles messages with array content", () => {
      const msgs: Message[] = [
        { role: "system", content: "sys" },
        {
          role: "tool",
          content: [{ type: "text", text: "z".repeat(20000) }],
        },
      ];
      const { messages } = emergencyPrune(msgs, {
        pinnedIndices: new Set(),
        currentTokens: 6000,
        targetTokens: 3000,
      });
      expect(messages).toHaveLength(2);
    });
  });
});
