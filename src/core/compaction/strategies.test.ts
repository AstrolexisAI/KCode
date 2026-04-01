// KCode - Individual Compaction Strategy Tests

import { describe, expect, test } from "bun:test";
import type { ContentBlock, Message, TextBlock, ToolResultBlock, ToolUseBlock } from "../types.js";
import { restoreRecentFiles } from "./strategies/file-restorer.js";
import { extractFilePaths, fullCompact } from "./strategies/full-compact.js";
import { hasImages, stripImages } from "./strategies/image-stripper.js";
import { microCompact } from "./strategies/micro-compact.js";
import {
  buildSessionResumptionMessage,
  sessionMemoryCompact,
} from "./strategies/session-memory-compact.js";
import type { LlmSummarizer } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────

function makeMsg(role: "user" | "assistant", text: string): Message {
  return { role, content: [{ type: "text" as const, text }] };
}

function makeStringMsg(role: "user" | "assistant", text: string): Message {
  return { role, content: text };
}

function makeImageMsg(text: string, alt?: string): Message {
  const blocks: any[] = [
    { type: "image", data: "base64data", ...(alt ? { alt } : {}) },
    { type: "text", text },
  ];
  return { role: "user" as const, content: blocks };
}

function makeDocMsg(text: string): Message {
  return {
    role: "user" as const,
    content: [
      { type: "document" as any, data: "pdfdata" },
      { type: "text" as const, text },
    ],
  };
}

function makeToolUseMsg(
  toolName: string,
  input: Record<string, unknown>,
  resultContent: string,
  isError = false,
): Message {
  return {
    role: "assistant" as const,
    content: [
      {
        type: "tool_use" as const,
        id: "tu_" + Math.random().toString(36).slice(2),
        name: toolName,
        input,
      } as ToolUseBlock,
      {
        type: "tool_result" as const,
        tool_use_id: "tu_" + Math.random().toString(36).slice(2),
        content: resultContent,
        is_error: isError,
      } as ToolResultBlock,
    ],
  };
}

function fillerMessages(n: number, charsPerMsg = 100): Message[] {
  return Array.from({ length: n }, (_, i) =>
    makeMsg(i % 2 === 0 ? "user" : "assistant", "x".repeat(charsPerMsg)),
  );
}

const mockSummarizer: LlmSummarizer = async (_prompt, _system, _maxTokens) => {
  return "Summary: the user worked on feature X. Files: /src/test.ts was modified.";
};

const structuredSummarizer: LlmSummarizer = async () => {
  return (
    "## What was done\nImplemented feature X\n\n" +
    "## Files modified\n- /src/foo.ts\n- /src/bar.ts\n\n" +
    "## Pending tasks\n- Add tests\n- Update docs\n\n" +
    "## User preferences\n- Prefers TypeScript\n- Wants concise code"
  );
};

const nullSummarizer: LlmSummarizer = async () => null;

// ─── Image Stripper ─────────────────────────────────────────────

describe("Image Stripper", () => {
  test("hasImages returns true when images present", () => {
    const msgs = [makeMsg("user", "hi"), makeImageMsg("with image")];
    expect(hasImages(msgs)).toBe(true);
  });

  test("hasImages returns false with no images", () => {
    const msgs = [makeMsg("user", "hi"), makeMsg("assistant", "hello")];
    expect(hasImages(msgs)).toBe(false);
  });

  test("hasImages detects document blocks", () => {
    const msgs = [makeDocMsg("with doc")];
    expect(hasImages(msgs)).toBe(true);
  });

  test("strips images from older messages", () => {
    const msgs = [
      makeImageMsg("old 1"),
      makeImageMsg("old 2"),
      makeMsg("user", "recent 1"),
      makeMsg("assistant", "recent 2"),
      makeMsg("user", "recent 3"),
      makeMsg("assistant", "recent 4"),
    ];
    const result = stripImages(msgs, { enabled: true, preserveRecent: 4 });
    expect(result.strippedCount).toBe(2);
    expect(result.tokensRecovered).toBe(3000); // 2 * 1500
    // First two messages should have text markers
    const first = result.messages[0]!;
    expect(Array.isArray(first.content)).toBe(true);
    const blocks = first.content as ContentBlock[];
    expect(
      blocks.some((b) => b.type === "text" && (b as TextBlock).text.includes("imagen removida")),
    ).toBe(true);
    // Original text preserved
    expect(blocks.some((b) => b.type === "text" && (b as TextBlock).text === "old 1")).toBe(true);
  });

  test("preserves images in the last N messages", () => {
    const msgs = [
      makeImageMsg("old"),
      makeImageMsg("recent 1"),
      makeImageMsg("recent 2"),
      makeImageMsg("recent 3"),
      makeImageMsg("recent 4"),
    ];
    const result = stripImages(msgs, { enabled: true, preserveRecent: 4 });
    expect(result.strippedCount).toBe(1); // Only the first one is stripped
  });

  test("preserves alt text if present", () => {
    const msgs = [
      makeImageMsg("text", "screenshot of the error"),
      makeMsg("user", "r1"),
      makeMsg("assistant", "r2"),
      makeMsg("user", "r3"),
      makeMsg("assistant", "r4"),
    ];
    const result = stripImages(msgs, { enabled: true, preserveRecent: 4 });
    const blocks = result.messages[0]!.content as ContentBlock[];
    const marker = blocks.find(
      (b) => b.type === "text" && (b as TextBlock).text.includes("screenshot"),
    );
    expect(marker).toBeDefined();
  });

  test("counts tokens recovered correctly", () => {
    const msgs = [
      makeImageMsg("1"),
      makeImageMsg("2"),
      makeImageMsg("3"),
      makeMsg("user", "r1"),
      makeMsg("assistant", "r2"),
      makeMsg("user", "r3"),
      makeMsg("assistant", "r4"),
    ];
    const result = stripImages(msgs, { enabled: true, preserveRecent: 4 });
    expect(result.strippedCount).toBe(3);
    expect(result.tokensRecovered).toBe(4500); // 3 * 1500
  });

  test("does not modify messages without images", () => {
    const msgs = fillerMessages(10);
    const result = stripImages(msgs);
    expect(result.strippedCount).toBe(0);
    expect(result.tokensRecovered).toBe(0);
  });

  test("strips document blocks too", () => {
    const msgs = [
      makeDocMsg("old doc"),
      makeMsg("user", "r1"),
      makeMsg("assistant", "r2"),
      makeMsg("user", "r3"),
      makeMsg("assistant", "r4"),
    ];
    const result = stripImages(msgs, { enabled: true, preserveRecent: 4 });
    expect(result.strippedCount).toBe(1);
  });
});

// ─── Micro-Compact ──────────────────────────────────────────────

describe("Micro-Compact", () => {
  test("compresses long tool results", () => {
    const msgs = [
      makeMsg("user", "do something"),
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "Read",
            input: { file_path: "/src/test.ts" },
          } as ToolUseBlock,
          {
            type: "tool_result" as const,
            tool_use_id: "t1",
            content: "x".repeat(500),
          } as ToolResultBlock,
        ],
      },
      ...fillerMessages(10, 50), // recent, preserved
    ];

    const result = microCompact(msgs, {
      enabled: true,
      preserveRecent: 10,
      toolResultThreshold: 300,
      assistantThreshold: 500,
    });
    expect(result.compressedCount).toBeGreaterThan(0);
    expect(result.tokensRecovered).toBeGreaterThan(0);
  });

  test("does not touch the last N messages", () => {
    const recentToolMsg: Message = {
      role: "assistant",
      content: [
        {
          type: "tool_result" as const,
          tool_use_id: "t1",
          content: "x".repeat(1000),
        } as ToolResultBlock,
      ],
    };
    const msgs = [
      ...fillerMessages(5),
      recentToolMsg, // This is within the last 10
      ...fillerMessages(9, 50),
    ];

    const result = microCompact(msgs, {
      enabled: true,
      preserveRecent: 10,
      toolResultThreshold: 300,
      assistantThreshold: 500,
    });
    // The recentToolMsg is in the last 10, should be untouched
    const idx = msgs.indexOf(recentToolMsg);
    const resultBlock = (result.messages[idx]!.content as ContentBlock[])[0] as ToolResultBlock;
    expect(typeof resultBlock.content === "string" && resultBlock.content.length).toBe(1000);
  });

  test("generates JSON structured summary for tool results", () => {
    const msgs = [
      makeMsg("user", "read the file"),
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "Read",
            input: { file_path: "/src/index.ts" },
          } as ToolUseBlock,
          {
            type: "tool_result" as const,
            tool_use_id: "t1",
            content: "a".repeat(500),
          } as ToolResultBlock,
        ],
      },
      ...fillerMessages(10, 50),
    ];

    const result = microCompact(msgs, {
      enabled: true,
      preserveRecent: 10,
      toolResultThreshold: 100,
      assistantThreshold: 500,
    });
    const compactedMsg = result.messages[1]!;
    const blocks = compactedMsg.content as ContentBlock[];
    const toolResult = blocks.find((b) => b.type === "tool_result") as ToolResultBlock;
    expect(toolResult).toBeDefined();
    const parsed = JSON.parse(toolResult.content as string);
    expect(parsed.result).toBe("exito");
    expect(parsed.output_preview).toBeDefined();
  });

  test("compresses long assistant text messages", () => {
    const msgs = [
      makeMsg("user", "question"),
      makeMsg("assistant", "a".repeat(800)),
      ...fillerMessages(10, 50),
    ];

    const result = microCompact(msgs, {
      enabled: true,
      preserveRecent: 10,
      toolResultThreshold: 300,
      assistantThreshold: 500,
    });
    expect(result.compressedCount).toBeGreaterThan(0);
    const compacted = result.messages[1]!;
    const blocks = compacted.content as ContentBlock[];
    const textBlock = blocks.find((b) => b.type === "text") as TextBlock;
    expect(textBlock.text).toContain("compactado");
    expect(textBlock.text.length).toBeLessThan(800);
  });

  test("compresses long user text messages", () => {
    const msgs = [
      makeMsg("user", "u".repeat(600)),
      makeMsg("assistant", "ok"),
      ...fillerMessages(10, 50),
    ];

    const result = microCompact(msgs, {
      enabled: true,
      preserveRecent: 10,
      toolResultThreshold: 300,
      assistantThreshold: 500,
    });
    expect(result.compressedCount).toBeGreaterThan(0);
  });

  test("compresses string content messages", () => {
    const msgs = [
      makeStringMsg("user", "u".repeat(600)),
      makeStringMsg("assistant", "a".repeat(800)),
      ...fillerMessages(10, 50),
    ];

    const result = microCompact(msgs, {
      enabled: true,
      preserveRecent: 10,
      toolResultThreshold: 300,
      assistantThreshold: 500,
    });
    expect(result.compressedCount).toBe(2);
  });

  test("handles error tool results", () => {
    const msgs = [
      makeMsg("user", "run command"),
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "Bash",
            input: { command: "npm test" },
          } as ToolUseBlock,
          {
            type: "tool_result" as const,
            tool_use_id: "t1",
            content: "Error: ".padEnd(500, "x"),
            is_error: true,
          } as ToolResultBlock,
        ],
      },
      ...fillerMessages(10, 50),
    ];

    const result = microCompact(msgs, {
      enabled: true,
      preserveRecent: 10,
      toolResultThreshold: 100,
      assistantThreshold: 500,
    });
    const blocks = result.messages[1]!.content as ContentBlock[];
    const toolResult = blocks.find((b) => b.type === "tool_result") as ToolResultBlock;
    const parsed = JSON.parse(toolResult.content as string);
    expect(parsed.result).toBe("error");
  });

  test("leaves short messages untouched", () => {
    const msgs = [makeMsg("user", "hi"), makeMsg("assistant", "hello"), ...fillerMessages(10, 50)];

    const result = microCompact(msgs);
    expect(result.compressedCount).toBe(0);
    expect(result.tokensRecovered).toBe(0);
  });

  test("preserves Edit tool results (coherence tool)", () => {
    const msgs = [
      makeMsg("user", "edit the file"),
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "Edit",
            input: { file_path: "/src/test.ts", old_string: "x", new_string: "y" },
          } as ToolUseBlock,
          {
            type: "tool_result" as const,
            tool_use_id: "t1",
            content: "a".repeat(500),
          } as ToolResultBlock,
        ],
      },
      ...fillerMessages(10, 50),
    ];

    const result = microCompact(msgs, {
      enabled: true,
      preserveRecent: 10,
      toolResultThreshold: 100,
      assistantThreshold: 500,
    });
    // Edit results should NOT be compacted
    const blocks = result.messages[1]!.content as ContentBlock[];
    const toolResult = blocks.find((b) => b.type === "tool_result") as ToolResultBlock;
    expect(typeof toolResult.content === "string" && toolResult.content.length).toBe(500);
  });

  test("preserves Write tool results (coherence tool)", () => {
    const msgs = [
      makeMsg("user", "write the file"),
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "Write",
            input: { file_path: "/src/test.ts", content: "..." },
          } as ToolUseBlock,
          {
            type: "tool_result" as const,
            tool_use_id: "t1",
            content: "b".repeat(500),
          } as ToolResultBlock,
        ],
      },
      ...fillerMessages(10, 50),
    ];

    const result = microCompact(msgs, {
      enabled: true,
      preserveRecent: 10,
      toolResultThreshold: 100,
      assistantThreshold: 500,
    });
    const blocks = result.messages[1]!.content as ContentBlock[];
    const toolResult = blocks.find((b) => b.type === "tool_result") as ToolResultBlock;
    expect(typeof toolResult.content === "string" && toolResult.content.length).toBe(500);
  });

  test("compacts Read tool results (heavy tool)", () => {
    const msgs = [
      makeMsg("user", "read the file"),
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "Read",
            input: { file_path: "/src/test.ts" },
          } as ToolUseBlock,
          {
            type: "tool_result" as const,
            tool_use_id: "t1",
            content: "c".repeat(500),
          } as ToolResultBlock,
        ],
      },
      ...fillerMessages(10, 50),
    ];

    const result = microCompact(msgs, {
      enabled: true,
      preserveRecent: 10,
      toolResultThreshold: 100,
      assistantThreshold: 500,
    });
    expect(result.compressedCount).toBeGreaterThan(0);
  });

  test("allows custom compactableTools override", () => {
    const msgs = [
      makeMsg("user", "custom"),
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "CustomTool",
            input: {},
          } as ToolUseBlock,
          {
            type: "tool_result" as const,
            tool_use_id: "t1",
            content: "d".repeat(500),
          } as ToolResultBlock,
        ],
      },
      ...fillerMessages(10, 50),
    ];

    const result = microCompact(msgs, {
      enabled: true,
      preserveRecent: 10,
      toolResultThreshold: 100,
      assistantThreshold: 500,
      compactableTools: ["CustomTool"],
      preserveTools: [],
    });
    expect(result.compressedCount).toBeGreaterThan(0);
  });
});

// ─── Full Compact ───────────────────────────────────────────────

describe("Full Compact", () => {
  test("generates summary with mock LLM", async () => {
    const msgs = fillerMessages(20, 100);
    const result = await fullCompact(msgs, 1, 5, mockSummarizer);
    expect(result.messages.length).toBeLessThan(20);
    expect(result.compactedMessages.length).toBe(14); // 20 - 1 - 5
    expect(result.summaryTokens).toBeGreaterThan(0);
    // Summary message should be present
    const summaryMsg = result.messages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some(
          (b) => b.type === "text" && (b as TextBlock).text.includes("Conversation Summary"),
        ),
    );
    expect(summaryMsg).toBeDefined();
  });

  test("preserves first and last messages", async () => {
    const msgs = fillerMessages(20, 100);
    const firstMsg = msgs[0]!;
    const lastMsgs = msgs.slice(-5);

    const result = await fullCompact(msgs, 1, 5, mockSummarizer);
    expect(result.messages[0]).toBe(firstMsg);
    // Last 5 should be at the end
    const resultTail = result.messages.slice(-5);
    expect(resultTail).toEqual(lastMsgs);
  });

  test("throws if LLM returns null", async () => {
    const msgs = fillerMessages(20, 100);
    await expect(fullCompact(msgs, 1, 5, nullSummarizer)).rejects.toThrow("null");
  });

  test("handles small message arrays (no compaction needed)", async () => {
    const msgs = fillerMessages(5, 100);
    const result = await fullCompact(msgs, 1, 5, mockSummarizer);
    // 5 messages, keepFirst=1 keepLast=5 -> nothing to compact
    expect(result.messages).toEqual(msgs);
    expect(result.compactedMessages).toEqual([]);
  });

  test("caps summary to 10K chars", async () => {
    const longSummarizer: LlmSummarizer = async () => "x".repeat(15_000);
    const msgs = fillerMessages(20, 100);
    const result = await fullCompact(msgs, 1, 5, longSummarizer);
    const summaryMsg = result.messages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some(
          (b) => b.type === "text" && (b as TextBlock).text.includes("[summary truncated]"),
        ),
    );
    expect(summaryMsg).toBeDefined();
  });

  test("respects maxSummaryTokens config", async () => {
    let receivedMaxTokens = 0;
    const spySummarizer: LlmSummarizer = async (_prompt, _system, maxTokens) => {
      receivedMaxTokens = maxTokens;
      return "summary";
    };
    const msgs = fillerMessages(20, 100);
    await fullCompact(msgs, 1, 5, spySummarizer, { maxSummaryTokens: 5000 });
    expect(receivedMaxTokens).toBe(5000);
  });
});

// ─── Extract File Paths ─────────────────────────────────────────

describe("extractFilePaths", () => {
  test("extracts paths from tool_use blocks", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "Read",
            input: { file_path: "/src/foo.ts" },
          } as ToolUseBlock,
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use" as const,
            id: "t2",
            name: "Edit",
            input: { file_path: "/src/bar.ts" },
          } as ToolUseBlock,
        ],
      },
    ];
    const paths = extractFilePaths(msgs);
    expect(paths).toContain("/src/foo.ts");
    expect(paths).toContain("/src/bar.ts");
  });

  test("deduplicates paths", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "Read",
            input: { file_path: "/src/foo.ts" },
          } as ToolUseBlock,
          {
            type: "tool_use" as const,
            id: "t2",
            name: "Read",
            input: { file_path: "/src/foo.ts" },
          } as ToolUseBlock,
        ],
      },
    ];
    expect(extractFilePaths(msgs)).toHaveLength(1);
  });

  test("extracts path from Glob/Grep via 'path' field", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "Glob",
            input: { path: "/src" },
          } as ToolUseBlock,
        ],
      },
    ];
    expect(extractFilePaths(msgs)).toContain("/src");
  });

  test("returns empty for messages without file tools", () => {
    const msgs = fillerMessages(5);
    expect(extractFilePaths(msgs)).toEqual([]);
  });
});

// ─── File Restorer ──────────────────────────────────────────────

describe("File Restorer", () => {
  test("injects restored file context after summary message", async () => {
    const summaryMsg: Message = {
      role: "user",
      content: [
        { type: "text" as const, text: "[Conversation Summary - Full Compaction] summary here" },
      ],
    };
    const messages = [makeMsg("user", "first"), summaryMsg, makeMsg("user", "recent")];
    const compacted: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "Read",
            input: { file_path: "/test.ts" },
          } as ToolUseBlock,
        ],
      },
    ];

    const mockReader = async (_path: string, _max: number) => "file content here";
    const result = await restoreRecentFiles(messages, compacted, {}, mockReader);

    // Should have more messages now (injected context pairs)
    expect(result.length).toBeGreaterThan(messages.length);
    const restored = result.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some(
          (b) => b.type === "text" && (b as TextBlock).text.includes("Contexto restaurado"),
        ),
    );
    expect(restored).toBeDefined();
  });

  test("respects max files to restore", async () => {
    const summaryMsg: Message = {
      role: "user",
      content: [
        { type: "text" as const, text: "[Conversation Summary - Full Compaction] summary" },
      ],
    };
    const messages = [makeMsg("user", "first"), summaryMsg, makeMsg("user", "recent")];
    const compacted: Message[] = [
      {
        role: "assistant",
        content: Array.from({ length: 10 }, (_, i) => ({
          type: "tool_use" as const,
          id: `t${i}`,
          name: "Read",
          input: { file_path: `/src/file${i}.ts` },
        })) as ToolUseBlock[],
      },
    ];

    const mockReader = async (_path: string) => "content";
    const result = await restoreRecentFiles(
      messages,
      compacted,
      { maxFilesToRestore: 3 },
      mockReader,
    );

    // Count restored context pairs (each pair is user + assistant)
    const restoredPairs = result.filter(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some(
          (b) => b.type === "text" && (b as TextBlock).text.includes("Contexto restaurado"),
        ),
    ).length;
    expect(restoredPairs).toBeLessThanOrEqual(3);
  });

  test("handles missing files gracefully", async () => {
    const summaryMsg: Message = {
      role: "user",
      content: [
        { type: "text" as const, text: "[Conversation Summary - Full Compaction] summary" },
      ],
    };
    const messages = [makeMsg("user", "first"), summaryMsg];
    const compacted: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "Read",
            input: { file_path: "/gone.ts" },
          } as ToolUseBlock,
        ],
      },
    ];

    const mockReader = async () => null;
    const result = await restoreRecentFiles(messages, compacted, {}, mockReader);
    expect(result).toEqual(messages);
  });

  test("returns original messages when no file paths found", async () => {
    const messages = fillerMessages(5);
    const result = await restoreRecentFiles(messages, []);
    expect(result).toEqual(messages);
  });

  test("respects budget", async () => {
    const summaryMsg: Message = {
      role: "user",
      content: [
        { type: "text" as const, text: "[Conversation Summary - Full Compaction] summary" },
      ],
    };
    const messages = [makeMsg("user", "first"), summaryMsg];
    const compacted: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "Read",
            input: { file_path: "/big.ts" },
          } as ToolUseBlock,
          {
            type: "tool_use" as const,
            id: "t2",
            name: "Read",
            input: { file_path: "/small.ts" },
          } as ToolUseBlock,
        ],
      },
    ];

    // 1 token budget = 3.5 chars, so 10 token budget = 35 chars
    const mockReader = async (path: string) =>
      path === "/big.ts" ? "x".repeat(100) : "y".repeat(5);
    const result = await restoreRecentFiles(
      messages,
      compacted,
      { fileRestoreBudget: 10 }, // Very tight budget (35 chars)
      mockReader,
    );
    // The big file (100 chars) exceeds budget, small file (5 chars) fits
    const restored = result.filter(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some(
          (b) => b.type === "text" && (b as TextBlock).text.includes("Contexto restaurado"),
        ),
    );
    // Only the small file should be restored (it comes after big in the list,
    // but since big is skipped, small might fit)
    expect(restored.length).toBeLessThanOrEqual(1);
  });
});

// ─── Session Memory Compact ─────────────────────────────────────

describe("Session Memory Compact", () => {
  test("generates structured summary for large transcripts", async () => {
    const msgs = fillerMessages(60);
    const result = await sessionMemoryCompact(msgs, structuredSummarizer, {
      thresholdMessages: 50,
    });
    expect(result).not.toBeNull();
    expect(result!.summary).toContain("Implemented feature X");
    expect(result!.filesModified).toContain("/src/foo.ts");
    expect(result!.pendingTasks).toContain("Add tests");
    expect(result!.userPreferences).toContain("Prefers TypeScript");
  });

  test("returns null if transcript below threshold", async () => {
    const msgs = fillerMessages(30);
    const result = await sessionMemoryCompact(msgs, mockSummarizer, {
      thresholdMessages: 50,
    });
    expect(result).toBeNull();
  });

  test("returns null if LLM returns null", async () => {
    const msgs = fillerMessages(60);
    const result = await sessionMemoryCompact(msgs, nullSummarizer, {
      thresholdMessages: 50,
    });
    expect(result).toBeNull();
  });

  test("extracts file paths from tool_use when LLM misses them", async () => {
    const msgs: Message[] = [
      ...fillerMessages(45),
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "Edit",
            input: { file_path: "/src/main.ts" },
          } as ToolUseBlock,
        ],
      },
      ...fillerMessages(15),
    ];

    // This summarizer returns no file section
    const noFileSummarizer: LlmSummarizer = async () =>
      "## What was done\nSome work\n\n## Pending tasks\n- Fix bugs";
    const result = await sessionMemoryCompact(msgs, noFileSummarizer, {
      thresholdMessages: 50,
    });
    expect(result).not.toBeNull();
    expect(result!.filesModified).toContain("/src/main.ts");
  });

  test("uses default threshold of 50", async () => {
    const msgs = fillerMessages(49);
    const result = await sessionMemoryCompact(msgs, mockSummarizer);
    expect(result).toBeNull();
  });

  test("buildSessionResumptionMessage creates proper message", async () => {
    const compactResult = {
      summary: "We worked on X",
      filesModified: ["/src/a.ts", "/src/b.ts"],
      pendingTasks: ["Write tests"],
      userPreferences: ["Use TypeScript"],
    };

    const msg = buildSessionResumptionMessage(compactResult);
    expect(msg.role).toBe("user");
    const text = (msg.content as ContentBlock[])[0] as TextBlock;
    expect(text.text).toContain("Sesion anterior resumida");
    expect(text.text).toContain("/src/a.ts");
    expect(text.text).toContain("Write tests");
    expect(text.text).toContain("Use TypeScript");
  });
});
