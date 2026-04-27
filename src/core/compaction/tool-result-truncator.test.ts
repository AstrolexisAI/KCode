import { describe, expect, test } from "bun:test";
import { DEFAULT_TRUNCATION_CONFIG, truncateToolResults } from "./tool-result-truncator";

describe("truncateToolResults", () => {
  test("does not truncate short tool results", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "tool" as const, content: "short result", name: "Read" },
    ];
    const { messages: output, truncatedCount, charsSaved } = truncateToolResults(messages);
    expect(truncatedCount).toBe(0);
    expect(charsSaved).toBe(0);
    expect(output[1]!.content).toBe("short result");
  });

  test("truncates tool results exceeding maxChars", () => {
    const longResult = "x".repeat(15000);
    const messages = [{ role: "tool" as const, content: longResult, name: "Read" }];
    const { messages: output, truncatedCount, charsSaved } = truncateToolResults(messages);
    expect(truncatedCount).toBe(1);
    expect(charsSaved).toBeGreaterThan(0);
    expect((output[0]!.content as string).length).toBeLessThan(longResult.length);
    expect(output[0]!.content).toContain("chars omitted");
  });

  test("preserves head and tail content", () => {
    const head = "HEAD_CONTENT_";
    const tail = "_TAIL_CONTENT";
    const middle = "m".repeat(15000);
    const longResult = head + middle + tail;
    const messages = [{ role: "tool" as const, content: longResult, name: "Bash" }];
    const { messages: output } = truncateToolResults(messages, {
      headChars: head.length + 10,
      tailChars: tail.length + 10,
    });
    const content = output[0]!.content as string;
    expect(content).toContain("HEAD_CONTENT_");
    expect(content).toContain("_TAIL_CONTENT");
  });

  test("skips protected tools", () => {
    const longResult = "x".repeat(15000);
    const messages = [{ role: "tool" as const, content: longResult, name: "Read" }];
    const { truncatedCount } = truncateToolResults(messages, {
      protectedTools: ["Read"],
    });
    expect(truncatedCount).toBe(0);
  });

  test("does not affect non-tool messages", () => {
    const longContent = "x".repeat(15000);
    const messages = [
      { role: "user" as const, content: longContent },
      { role: "assistant" as const, content: longContent },
    ];
    const { truncatedCount } = truncateToolResults(messages);
    expect(truncatedCount).toBe(0);
  });

  test("aggressive mode uses lower threshold", () => {
    const result = "x".repeat(5000);
    const messages = [{ role: "tool" as const, content: result, name: "Bash" }];

    // Normal mode: 5000 < 10000 default → no truncation
    const normal = truncateToolResults(messages);
    expect(normal.truncatedCount).toBe(0);

    // Aggressive mode: 5000 > 2000 → truncated
    const aggressive = truncateToolResults(messages, {}, true);
    expect(aggressive.truncatedCount).toBe(1);
  });

  test("handles multiple tool results", () => {
    const messages = [
      { role: "tool" as const, content: "x".repeat(15000), name: "Bash" },
      { role: "user" as const, content: "ok" },
      { role: "tool" as const, content: "y".repeat(15000), name: "Grep" },
    ];
    const { truncatedCount } = truncateToolResults(messages);
    expect(truncatedCount).toBe(2);
  });

  test("handles array content format", () => {
    const messages = [
      {
        role: "tool" as const,
        content: [{ type: "text", text: "z".repeat(15000) }],
        name: "Read",
      },
    ];
    const { truncatedCount } = truncateToolResults(messages);
    expect(truncatedCount).toBe(1);
  });

  test("DEFAULT_TRUNCATION_CONFIG has sensible values", () => {
    expect(DEFAULT_TRUNCATION_CONFIG.maxChars).toBe(10000);
    expect(DEFAULT_TRUNCATION_CONFIG.aggressiveMaxChars).toBe(2000);
    expect(DEFAULT_TRUNCATION_CONFIG.headChars).toBe(1000);
    expect(DEFAULT_TRUNCATION_CONFIG.tailChars).toBe(500);
    expect(DEFAULT_TRUNCATION_CONFIG.protectedTools).toEqual([]);
  });
});
