// Tests for processStreamEvents — streaming throttle behavior.
// First test file for stream-handler; extend from here.

import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "../core/types.js";
import { processStreamEvents, type StreamHandlerDeps } from "./stream-handler.js";

function makeDeps() {
  const calls = {
    streamingThinking: [] as string[],
    streamingText: [] as string[],
  };
  const noop = () => {};
  const deps = {
    config: { workingDirectory: "/tmp" },
    conversationManager: {} as never,
    tabRemovalTimers: { current: new Set<ReturnType<typeof setTimeout>>() },
    setLoadingMessage: noop,
    setLastKodiEvent: noop,
    setIsThinking: noop,
    setStreamingThinking: (v: string) => calls.streamingThinking.push(v),
    setCompleted: noop,
    setStreamingText: (v: string) => calls.streamingText.push(v),
    setToolUseCount: noop,
    setBashStreamOutput: noop,
    setActiveTabs: noop,
    setTokenCount: noop,
    setTurnTokens: noop,
    setSpinnerPhase: noop,
    setRunningAgentCount: noop,
    setWatcherSuggestions: noop,
  } satisfies StreamHandlerDeps;
  return { deps, calls };
}

async function* eventsFrom(list: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of list) yield e;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("processStreamEvents throttling", () => {
  test("thinking_delta is throttled: many deltas collapse into few renders", async () => {
    const { deps, calls } = makeDeps();
    const events: StreamEvent[] = [];
    for (let i = 0; i < 200; i++) {
      events.push({ type: "thinking_delta", thinking: `tok${i} ` });
    }
    await processStreamEvents(eventsFrom(events), deps);
    // Let the 66ms flush timer fire
    await sleep(120);

    // Unthrottled this was 200 setState calls (one per token); throttled it
    // must be a small constant number of flushes.
    expect(calls.streamingThinking.length).toBeLessThanOrEqual(3);
    // The flushed value carries the full accumulated thinking so far
    const last = calls.streamingThinking.at(-1) ?? "";
    expect(last).toContain("tok0 ");
    expect(last).toContain("tok199 ");
  });

  test("long streaming text shows the tail, not the head", async () => {
    const { deps, calls } = makeDeps();
    const lines = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
    await processStreamEvents(eventsFrom([{ type: "text_delta", text: lines }]), deps);
    await sleep(120);

    const last = calls.streamingText.at(-1) ?? "";
    expect(last).toContain("... writing (40 lines)");
    // Tail is visible; head is summarized away
    expect(last).toContain("line-39");
    expect(last).not.toContain("line-0\n");
  });
});
