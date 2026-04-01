import { beforeEach, describe, expect, test } from "bun:test";
import { DebugTracer, getDebugTracer, resetDebugTracer } from "./debug-tracer.ts";

describe("debug-tracer", () => {
  let tracer: DebugTracer;

  beforeEach(() => {
    tracer = new DebugTracer();
  });

  // ─── Enable / Disable ───

  test("starts disabled by default", () => {
    expect(tracer.isEnabled()).toBe(false);
  });

  test("enable and disable toggle state", () => {
    tracer.enable();
    expect(tracer.isEnabled()).toBe(true);
    tracer.disable();
    expect(tracer.isEnabled()).toBe(false);
  });

  // ─── Trace Recording ───

  test("trace records events when enabled", () => {
    tracer.enable();
    tracer.trace("decision", "chose plan A", "it was faster");
    expect(tracer.size).toBe(1);
    const events = tracer.getEvents();
    expect(events[0]!.category).toBe("decision");
    expect(events[0]!.action).toBe("chose plan A");
    expect(events[0]!.reason).toBe("it was faster");
    expect(events[0]!.timestamp).toBeGreaterThan(0);
  });

  test("trace is a no-op when disabled", () => {
    tracer.trace("decision", "chose plan A", "it was faster");
    expect(tracer.size).toBe(0);
  });

  test("trace records details when provided", () => {
    tracer.enable();
    tracer.trace("tool", "selected Grep", "pattern match", { pattern: "foo" });
    const events = tracer.getEvents();
    expect(events[0]!.details).toEqual({ pattern: "foo" });
  });

  // ─── Filtering ───

  test("getEvents filters by category", () => {
    tracer.enable();
    tracer.trace("decision", "a1", "r1");
    tracer.trace("tool", "a2", "r2");
    tracer.trace("decision", "a3", "r3");

    const decisions = tracer.getEvents({ category: "decision" });
    expect(decisions.length).toBe(2);
    expect(decisions.every((e) => e.category === "decision")).toBe(true);
  });

  test("getEvents filters by limit", () => {
    tracer.enable();
    for (let i = 0; i < 10; i++) {
      tracer.trace("decision", `action-${i}`, "reason");
    }
    const limited = tracer.getEvents({ limit: 3 });
    expect(limited.length).toBe(3);
    expect(limited[0]!.action).toBe("action-7"); // last 3
  });

  test("getEvents filters by since timestamp", () => {
    tracer.enable();
    tracer.trace("decision", "old", "old reason");
    const cutoff = Date.now() + 1;
    // Manually push a future-dated event for testing
    (tracer as any).events.push({
      timestamp: cutoff + 100,
      category: "tool" as const,
      action: "new",
      reason: "new reason",
    });

    const recent = tracer.getEvents({ since: cutoff });
    expect(recent.length).toBe(1);
    expect(recent[0]!.action).toBe("new");
  });

  test("getLastEvents returns the last N events", () => {
    tracer.enable();
    tracer.trace("decision", "a1", "r1");
    tracer.trace("tool", "a2", "r2");
    tracer.trace("guard", "a3", "r3");

    const last2 = tracer.getLastEvents(2);
    expect(last2.length).toBe(2);
    expect(last2[0]!.action).toBe("a2");
    expect(last2[1]!.action).toBe("a3");
  });

  // ─── Formatting ───

  test("formatEvent produces a concise one-liner", () => {
    tracer.enable();
    tracer.trace("tool", "Selected Grep", "pattern needed");
    const event = tracer.getEvents()[0]!;
    const line = tracer.formatEvent(event);
    expect(line).toContain("TOOL");
    expect(line).toContain("Selected Grep");
    expect(line).toContain("pattern needed");
  });

  test("formatEvent includes details in parentheses", () => {
    tracer.enable();
    tracer.trace("model", "switch", "fallback", { from: "gpt-4", to: "gpt-3.5" });
    const event = tracer.getEvents()[0]!;
    const line = tracer.formatEvent(event);
    expect(line).toContain("from=gpt-4");
    expect(line).toContain("to=gpt-3.5");
  });

  test("formatTrace formats all events as multi-line string", () => {
    tracer.enable();
    tracer.trace("decision", "a1", "r1");
    tracer.trace("tool", "a2", "r2");
    const output = tracer.formatTrace();
    expect(output).toContain("Debug Trace (2 events)");
    expect(output).toContain("a1");
    expect(output).toContain("a2");
  });

  test("formatTrace returns message when no events", () => {
    const output = tracer.formatTrace();
    expect(output).toContain("No debug trace events recorded");
  });

  // ─── Clear ───

  test("clear removes all events", () => {
    tracer.enable();
    tracer.trace("decision", "a1", "r1");
    tracer.trace("tool", "a2", "r2");
    expect(tracer.size).toBe(2);
    tracer.clear();
    expect(tracer.size).toBe(0);
    expect(tracer.getEvents().length).toBe(0);
  });

  // ─── Convenience Methods ───

  test("traceToolChoice records tool selection event", () => {
    tracer.enable();
    tracer.traceToolChoice("Grep", "need to search", ["Glob", "Read"]);
    const events = tracer.getEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.category).toBe("tool");
    expect(events[0]!.action).toContain("Grep");
    expect(events[0]!.details?.alternatives).toEqual(["Glob", "Read"]);
  });

  test("traceModelSwitch records model change", () => {
    tracer.enable();
    tracer.traceModelSwitch("gpt-4", "gpt-3.5", "primary failed");
    const events = tracer.getEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.category).toBe("model");
    expect(events[0]!.action).toContain("gpt-4");
    expect(events[0]!.action).toContain("gpt-3.5");
    expect(events[0]!.details?.from).toBe("gpt-4");
    expect(events[0]!.details?.to).toBe("gpt-3.5");
  });

  test("tracePermission records permission decision", () => {
    tracer.enable();
    tracer.tracePermission("Bash", "allowed", "Bash(npm run *)");
    const events = tracer.getEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.category).toBe("permission");
    expect(events[0]!.action).toContain("Bash");
    expect(events[0]!.details?.rule).toBe("Bash(npm run *)");
  });

  test("traceCompaction records context reduction", () => {
    tracer.enable();
    tracer.traceCompaction(50000, 20000, "llm");
    const events = tracer.getEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.category).toBe("context");
    expect(events[0]!.details?.saved).toBe(30000);
    expect(events[0]!.details?.method).toBe("llm");
  });

  test("traceGuard records guard state", () => {
    tracer.enable();
    tracer.traceGuard("loop-detector", true, "3 similar bash commands");
    const events = tracer.getEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.category).toBe("guard");
    expect(events[0]!.action).toContain("triggered");
  });

  test("traceRouting records routing decision", () => {
    tracer.enable();
    tracer.traceRouting("vision", "llava-v1.5", ["gpt-4", "llava-v1.5"]);
    const events = tracer.getEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.category).toBe("routing");
    expect(events[0]!.details?.taskType).toBe("vision");
    expect(events[0]!.details?.candidates).toEqual(["gpt-4", "llava-v1.5"]);
  });

  // ─── Convenience methods are no-ops when disabled ───

  test("convenience methods do nothing when disabled", () => {
    tracer.traceToolChoice("Grep", "reason");
    tracer.traceModelSwitch("a", "b", "reason");
    tracer.tracePermission("Bash", "allowed");
    tracer.traceCompaction(100, 50, "pruned");
    tracer.traceGuard("loop", true);
    tracer.traceRouting("code", "model");
    expect(tracer.size).toBe(0);
  });

  // ─── Buffer cap ───

  test("caps events buffer at MAX_EVENTS", () => {
    tracer.enable();
    for (let i = 0; i < 2100; i++) {
      tracer.trace("decision", `action-${i}`, "reason");
    }
    expect(tracer.size).toBeLessThanOrEqual(2000);
    // Oldest events should have been trimmed
    const events = tracer.getEvents();
    expect(events[0]!.action).toBe("action-100"); // 2100 - 2000 = first kept is 100
  });

  // ─── Singleton ───

  test("getDebugTracer returns singleton", () => {
    resetDebugTracer();
    const t1 = getDebugTracer();
    const t2 = getDebugTracer();
    expect(t1).toBe(t2);
    resetDebugTracer();
  });

  test("resetDebugTracer creates fresh instance", () => {
    resetDebugTracer();
    const t1 = getDebugTracer();
    t1.enable();
    t1.trace("decision", "a1", "r1");

    resetDebugTracer();
    const t2 = getDebugTracer();
    expect(t2.isEnabled()).toBe(false);
    expect(t2.size).toBe(0);
    expect(t2).not.toBe(t1);
    resetDebugTracer();
  });
});
