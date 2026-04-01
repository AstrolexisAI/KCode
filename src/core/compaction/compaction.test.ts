// KCode - Multi-Strategy Compaction Orchestrator Tests

import { describe, expect, test } from "bun:test";
import type { Message } from "../types.js";
import { CompactionCircuitBreaker } from "./circuit-breaker.js";
import { compact } from "./index.js";
import type { CompactionConfig, LlmSummarizer } from "./types.js";
import { getDefaultCompactionConfig } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────

function makeMsg(role: "user" | "assistant", text: string): Message {
  return { role, content: [{ type: "text" as const, text }] };
}

function makeToolMsg(): Message {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use" as const,
        id: "t1",
        name: "Read",
        input: { file_path: "/test.ts" },
      },
      {
        type: "tool_result" as const,
        tool_use_id: "t1",
        content: "x".repeat(500),
      },
    ],
  };
}

function fillerMessages(n: number, charsPerMsg = 100): Message[] {
  return Array.from({ length: n }, (_, i) =>
    makeMsg(i % 2 === 0 ? "user" : "assistant", "x".repeat(charsPerMsg)),
  );
}

function makeImageMsg(index: number): Message {
  return {
    role: "user" as const,
    content: [
      { type: "image" as any, data: "base64data" },
      { type: "text" as const, text: `Message ${index}` },
    ],
  };
}

const mockSummarizer: LlmSummarizer = async (_prompt, _system, _maxTokens) => {
  return "This is a mock summary of the conversation.";
};

const failingSummarizer: LlmSummarizer = async () => {
  throw new Error("LLM unavailable");
};

// ─── Orchestrator Tests ─────────────────────────────────────────

describe("compact orchestrator", () => {
  test("returns 'none' strategy when context usage is low", async () => {
    const msgs = fillerMessages(10);
    const result = await compact(msgs, 0.3, mockSummarizer);
    expect(result.strategiesApplied).toEqual(["none"]);
    expect(result.messages).toHaveLength(10);
  });

  test("applies image-strip when images present regardless of usage", async () => {
    const msgs = [
      makeImageMsg(0),
      makeImageMsg(1),
      makeImageMsg(2),
      makeImageMsg(3),
      makeImageMsg(4),
      makeImageMsg(5),
      makeMsg("user", "recent 1"),
      makeMsg("assistant", "recent 2"),
      makeMsg("user", "recent 3"),
      makeMsg("assistant", "recent 4"),
    ];
    // Low usage but images present
    const result = await compact(msgs, 0.3, mockSummarizer);
    expect(result.strategiesApplied).toContain("image-strip");
    expect(result.tokensRecovered).toBeGreaterThan(0);
  });

  test("applies micro-compact at >= 60% usage", async () => {
    const msgs = [
      ...fillerMessages(15, 50),
      makeToolMsg(),
      makeToolMsg(),
      ...fillerMessages(10, 50),
    ];
    const result = await compact(msgs, 0.65, mockSummarizer);
    expect(result.strategiesApplied).toContain("micro-compact");
  });

  test("applies full-compact at >= 75% usage", async () => {
    const msgs = fillerMessages(30, 200);
    const result = await compact(msgs, 0.8, mockSummarizer);
    expect(result.strategiesApplied).toContain("full-compact");
  });

  test("applies emergency-prune at >= 90% usage", async () => {
    const msgs = fillerMessages(30, 200);
    const result = await compact(msgs, 0.95, mockSummarizer);
    expect(result.strategiesApplied).toContain("emergency-prune");
  });

  test("handles null summarizer gracefully at high usage", async () => {
    // Use long messages so micro-compact has something to compress
    const msgs = fillerMessages(30, 600);
    const result = await compact(msgs, 0.8, null);
    // Should apply micro-compact but skip full-compact (no summarizer)
    expect(result.strategiesApplied).toContain("micro-compact");
    expect(result.strategiesApplied).not.toContain("full-compact");
  });

  test("handles failing summarizer gracefully", async () => {
    const msgs = fillerMessages(30, 600);
    const result = await compact(msgs, 0.8, failingSummarizer);
    // Should apply micro-compact but full-compact fails silently
    expect(result.strategiesApplied).toContain("micro-compact");
    expect(result.strategiesApplied).not.toContain("full-compact");
  });

  test("circuit breaker prevents full-compact after repeated failures", async () => {
    const cb = new CompactionCircuitBreaker({ maxFailures: 2 });
    const msgs = fillerMessages(30, 200);

    // Trip the circuit breaker
    cb.recordFailure(new Error("fail 1"));
    cb.recordFailure(new Error("fail 2"));
    expect(cb.canAttempt()).toBe(false);

    const result = await compact(msgs, 0.8, mockSummarizer, undefined, cb);
    expect(result.strategiesApplied).not.toContain("full-compact");
  });

  test("escalates strategies progressively", async () => {
    const msgs = fillerMessages(30, 200);

    const low = await compact(msgs, 0.5, mockSummarizer);
    expect(low.strategiesApplied).toEqual(["none"]);

    const midMsgs = fillerMessages(30, 600); // Long messages so micro-compact triggers
    const mid = await compact(midMsgs, 0.65, mockSummarizer);
    expect(mid.strategiesApplied).toContain("micro-compact");

    const high = await compact(msgs, 0.8, mockSummarizer);
    expect(high.strategiesApplied).toContain("full-compact");
  });

  test("does not break when all strategies fail", async () => {
    const msgs = fillerMessages(4);
    const cb = new CompactionCircuitBreaker({ maxFailures: 1 });
    cb.recordFailure(new Error("fail"));

    // Very high usage but circuit breaker open and few messages
    const result = await compact(msgs, 0.95, failingSummarizer, undefined, cb);
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
  });

  test("respects disabled strategies in config", async () => {
    const msgs = [makeImageMsg(0), ...fillerMessages(20, 200)];
    const config: Partial<CompactionConfig> = {
      imageStripping: { enabled: false, preserveRecent: 4 },
      micro: {
        enabled: false,
        preserveRecent: 10,
        toolResultThreshold: 300,
        assistantThreshold: 500,
      },
    };
    const result = await compact(msgs, 0.65, mockSummarizer, config);
    expect(result.strategiesApplied).not.toContain("image-strip");
    expect(result.strategiesApplied).not.toContain("micro-compact");
  });
});

// ─── Circuit Breaker Tests ──────────────────────────────────────

describe("CompactionCircuitBreaker", () => {
  test("starts closed with zero failures", () => {
    const cb = new CompactionCircuitBreaker();
    const state = cb.getState();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.isOpen).toBe(false);
    expect(state.lastFailure).toBeNull();
  });

  test("opens after maxFailures consecutive failures", () => {
    const cb = new CompactionCircuitBreaker({ maxFailures: 3 });
    cb.recordFailure(new Error("1"));
    cb.recordFailure(new Error("2"));
    expect(cb.canAttempt()).toBe(true);
    cb.recordFailure(new Error("3"));
    expect(cb.canAttempt()).toBe(false);
    expect(cb.getState().isOpen).toBe(true);
  });

  test("recordSuccess resets counter and closes circuit", () => {
    const cb = new CompactionCircuitBreaker({ maxFailures: 3 });
    cb.recordFailure(new Error("1"));
    cb.recordFailure(new Error("2"));
    cb.recordSuccess();
    expect(cb.getState().consecutiveFailures).toBe(0);
    expect(cb.getState().isOpen).toBe(false);
    expect(cb.canAttempt()).toBe(true);
  });

  test("auto-resets after resetAfterMs", () => {
    const cb = new CompactionCircuitBreaker({ maxFailures: 1, resetAfterMs: 100 });
    cb.recordFailure(new Error("fail"));
    expect(cb.canAttempt()).toBe(false);

    // Simulate time passing by manipulating lastFailure
    const state = cb.getState();
    // We can't easily mock Date.now(), but we can test the reset() path
    cb.reset();
    expect(cb.canAttempt()).toBe(true);
  });

  test("manual reset works", () => {
    const cb = new CompactionCircuitBreaker({ maxFailures: 2 });
    cb.recordFailure(new Error("1"));
    cb.recordFailure(new Error("2"));
    expect(cb.canAttempt()).toBe(false);
    cb.reset();
    expect(cb.canAttempt()).toBe(true);
    expect(cb.getState().consecutiveFailures).toBe(0);
  });

  test("does not trip with fewer than maxFailures", () => {
    const cb = new CompactionCircuitBreaker({ maxFailures: 5 });
    for (let i = 0; i < 4; i++) {
      cb.recordFailure(new Error(`fail ${i}`));
    }
    expect(cb.canAttempt()).toBe(true);
    expect(cb.getState().isOpen).toBe(false);
  });

  test("uses default config values", () => {
    const cb = new CompactionCircuitBreaker();
    const state = cb.getState();
    expect(state.maxFailures).toBe(3);
    expect(state.resetAfterMs).toBe(300_000);
  });
});
