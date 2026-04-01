import { test, expect, describe } from "bun:test";
import {
  isTruncated,
  mergeConsecutiveAssistant,
  mergeParts,
} from "./continuation-merger";

describe("continuation-merger", () => {
  describe("isTruncated", () => {
    test("true when finish_reason is length", () => {
      expect(
        isTruncated({ role: "assistant", content: "text", finish_reason: "length" }),
      ).toBe(true);
    });

    test("true when finish_reason is max_tokens", () => {
      expect(
        isTruncated({
          role: "assistant",
          content: "text",
          finish_reason: "max_tokens",
        }),
      ).toBe(true);
    });

    test("false when finish_reason is stop", () => {
      expect(
        isTruncated({
          role: "assistant",
          content: "This is complete.",
          finish_reason: "stop",
        }),
      ).toBe(false);
    });

    test("false when content ends with punctuation", () => {
      expect(isTruncated({ role: "assistant", content: "Done." })).toBe(false);
      expect(isTruncated({ role: "assistant", content: "Really?" })).toBe(false);
      expect(isTruncated({ role: "assistant", content: "Wow!" })).toBe(false);
    });

    test("false when content is too short", () => {
      expect(isTruncated({ role: "assistant", content: "Hi" })).toBe(false);
    });

    test("true for open code block", () => {
      expect(
        isTruncated({
          role: "assistant",
          content: "Here is code:\n```typescript\nconst x =",
        }),
      ).toBe(true);
    });

    test("false for closed code block", () => {
      expect(
        isTruncated({
          role: "assistant",
          content: "Here is code:\n```typescript\nconst x = 1;\n```",
        }),
      ).toBe(false);
    });

    test("false for empty content", () => {
      expect(isTruncated({ role: "assistant", content: "" })).toBe(false);
    });
  });

  describe("mergeConsecutiveAssistant", () => {
    test("no merge when no consecutive assistant", () => {
      const msgs = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello." },
        { role: "user", content: "bye" },
        { role: "assistant", content: "goodbye." },
      ];
      const { messages, mergeCount } = mergeConsecutiveAssistant(msgs);
      expect(mergeCount).toBe(0);
      expect(messages).toHaveLength(4);
    });

    test("merges truncated consecutive assistant messages", () => {
      const msgs = [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "This is a long response that was truncat",
          finish_reason: "length",
        },
        { role: "assistant", content: "ed and continued here." },
      ];
      const { messages, mergeCount } = mergeConsecutiveAssistant(msgs);
      expect(mergeCount).toBe(1);
      expect(messages).toHaveLength(2);
      expect((messages[1].content as string)).toContain("truncat");
      expect((messages[1].content as string)).toContain("ed and continued");
    });

    test("does not merge when first is not truncated", () => {
      const msgs = [
        { role: "assistant", content: "Complete sentence." },
        { role: "assistant", content: "Another message." },
      ];
      const { messages, mergeCount } = mergeConsecutiveAssistant(msgs);
      expect(mergeCount).toBe(0);
      expect(messages).toHaveLength(2);
    });

    test("handles single message", () => {
      const msgs = [{ role: "assistant", content: "solo" }];
      const { messages, mergeCount } = mergeConsecutiveAssistant(msgs);
      expect(mergeCount).toBe(0);
      expect(messages).toHaveLength(1);
    });

    test("handles empty array", () => {
      const { messages, mergeCount } = mergeConsecutiveAssistant([]);
      expect(mergeCount).toBe(0);
      expect(messages).toHaveLength(0);
    });
  });

  describe("mergeParts", () => {
    test("single part — no merge", () => {
      const result = mergeParts(["hello"]);
      expect(result.merged).toBe(false);
      expect(result.originalParts).toBe(1);
      expect(result.finalContent).toBe("hello");
    });

    test("empty array", () => {
      const result = mergeParts([]);
      expect(result.merged).toBe(false);
      expect(result.finalContent).toBe("");
    });

    test("two parts merge", () => {
      const result = mergeParts(["first part", "second part"]);
      expect(result.merged).toBe(true);
      expect(result.originalParts).toBe(2);
      expect(result.finalContent).toContain("first part");
      expect(result.finalContent).toContain("second part");
    });

    test("three parts merge", () => {
      const result = mergeParts(["a", "b", "c"]);
      expect(result.merged).toBe(true);
      expect(result.originalParts).toBe(3);
    });

    test("mid-word join", () => {
      const result = mergeParts(["truncat", "ed word"]);
      expect(result.finalContent).toContain("truncated word");
    });
  });
});
