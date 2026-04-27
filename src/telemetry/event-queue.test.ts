import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventQueue } from "./event-queue";
import type { TelemetryEvent, TelemetrySink } from "./types";

function makeEvent(
  name: string = "kcode.test",
  overrides: Partial<TelemetryEvent> = {},
): TelemetryEvent {
  return {
    name,
    timestamp: new Date().toISOString(),
    traceId: "trace-1",
    spanId: `span-${Math.random().toString(36).slice(2, 8)}`,
    attributes: {},
    ...overrides,
  };
}

/** A sink that records everything it receives. */
class MockSink implements TelemetrySink {
  name: string;
  batches: TelemetryEvent[][] = [];
  shutdownCalled = false;
  shouldFail = false;

  constructor(name: string = "mock") {
    this.name = name;
  }

  async send(events: TelemetryEvent[]): Promise<void> {
    if (this.shouldFail) throw new Error("Sink failure");
    this.batches.push([...events]);
  }

  async shutdown(): Promise<void> {
    this.shutdownCalled = true;
  }

  get totalEvents(): number {
    return this.batches.reduce((sum, b) => sum + b.length, 0);
  }
}

describe("event-queue", () => {
  let queue: EventQueue;

  afterEach(async () => {
    if (queue) await queue.shutdown();
  });

  // ─── Basic enqueue/flush ───

  test("enqueue adds events to buffer", () => {
    queue = new EventQueue();
    queue.enqueue(makeEvent());
    queue.enqueue(makeEvent());
    expect(queue.bufferedCount).toBe(2);
  });

  test("flush sends buffered events to sink", async () => {
    queue = new EventQueue();
    const sink = new MockSink();
    queue.addSink(sink);

    queue.enqueue(makeEvent("kcode.tool.execute"));
    queue.enqueue(makeEvent("kcode.llm.request"));
    await queue.flush();

    expect(sink.batches.length).toBe(1);
    expect(sink.batches[0]!.length).toBe(2);
    expect(queue.bufferedCount).toBe(0);
  });

  test("flush is no-op when buffer is empty", async () => {
    queue = new EventQueue();
    const sink = new MockSink();
    queue.addSink(sink);

    await queue.flush();
    expect(sink.batches.length).toBe(0);
  });

  // ─── Multiple sinks ───

  test("flush sends to all registered sinks", async () => {
    queue = new EventQueue();
    const sink1 = new MockSink("sink-a");
    const sink2 = new MockSink("sink-b");
    queue.addSink(sink1);
    queue.addSink(sink2);

    queue.enqueue(makeEvent());
    await queue.flush();

    expect(sink1.totalEvents).toBe(1);
    expect(sink2.totalEvents).toBe(1);
  });

  // ─── Sink management ───

  test("addSink prevents duplicates by name", () => {
    queue = new EventQueue();
    const sink1 = new MockSink("same-name");
    const sink2 = new MockSink("same-name");
    queue.addSink(sink1);
    queue.addSink(sink2);

    expect(queue.sinkNames.length).toBe(1);
  });

  test("removeSink removes by name", async () => {
    queue = new EventQueue();
    const sink = new MockSink("removable");
    queue.addSink(sink);
    expect(queue.sinkNames).toContain("removable");

    queue.removeSink("removable");
    expect(queue.sinkNames).not.toContain("removable");

    queue.enqueue(makeEvent());
    await queue.flush();
    expect(sink.totalEvents).toBe(0);
  });

  // ─── Circular buffer ───

  test("circular buffer drops oldest events when full", () => {
    queue = new EventQueue(5); // tiny buffer
    for (let i = 0; i < 10; i++) {
      queue.enqueue(makeEvent(`event-${i}`));
    }
    // Should only keep the last 5
    expect(queue.bufferedCount).toBeLessThanOrEqual(5);
  });

  // ─── Fire-and-forget on sink failure ───

  test("sink failure does not throw and does not block other sinks", async () => {
    queue = new EventQueue();
    const failingSink = new MockSink("failing");
    failingSink.shouldFail = true;
    const goodSink = new MockSink("good");

    queue.addSink(failingSink);
    queue.addSink(goodSink);

    queue.enqueue(makeEvent());
    // Should not throw
    await queue.flush();

    // Good sink still received the events
    expect(goodSink.totalEvents).toBe(1);
  });

  // ─── Shutdown ───

  test("shutdown flushes remaining events", async () => {
    queue = new EventQueue();
    const sink = new MockSink();
    queue.addSink(sink);

    queue.enqueue(makeEvent());
    queue.enqueue(makeEvent());

    await queue.shutdown();

    expect(sink.totalEvents).toBe(2);
    expect(sink.shutdownCalled).toBe(true);
  });

  test("enqueue is no-op after shutdown", async () => {
    queue = new EventQueue();
    const sink = new MockSink();
    queue.addSink(sink);

    await queue.shutdown();
    queue.enqueue(makeEvent());

    expect(queue.bufferedCount).toBe(0);
  });

  test("shutdown calls shutdown on all sinks", async () => {
    queue = new EventQueue();
    const sink1 = new MockSink("s1");
    const sink2 = new MockSink("s2");
    queue.addSink(sink1);
    queue.addSink(sink2);

    await queue.shutdown();

    expect(sink1.shutdownCalled).toBe(true);
    expect(sink2.shutdownCalled).toBe(true);
  });

  // ─── Size-based flush trigger ───

  test("auto-flushes when buffer hits 100 events", async () => {
    queue = new EventQueue();
    const sink = new MockSink();
    queue.addSink(sink);

    // Enqueue 100 events to trigger size-based flush
    for (let i = 0; i < 100; i++) {
      queue.enqueue(makeEvent(`event-${i}`));
    }

    // Give microtask a chance to run
    await new Promise((r) => setTimeout(r, 50));

    expect(sink.totalEvents).toBe(100);
    expect(queue.bufferedCount).toBe(0);
  });

  // ─── Multiple flushes ───

  test("multiple flushes work correctly", async () => {
    queue = new EventQueue();
    const sink = new MockSink();
    queue.addSink(sink);

    queue.enqueue(makeEvent("batch-1"));
    await queue.flush();

    queue.enqueue(makeEvent("batch-2a"));
    queue.enqueue(makeEvent("batch-2b"));
    await queue.flush();

    expect(sink.batches.length).toBe(2);
    expect(sink.batches[0]!.length).toBe(1);
    expect(sink.batches[1]!.length).toBe(2);
    expect(sink.totalEvents).toBe(3);
  });
});
