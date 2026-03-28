// KCode - Kodi Animation Engine Tests

import { describe, test, expect } from "bun:test";
import { KodiAnimEngine } from "./kodi-animation";

describe("KodiAnimEngine", () => {
  test("initializes in idle mood", () => {
    const engine = new KodiAnimEngine();
    const frame = engine.tick(0);
    expect(frame.mood).toBe("idle");
    expect(frame.phase).toBe("idle");
  });

  test("tick returns all required layers", () => {
    const engine = new KodiAnimEngine();
    const frame = engine.tick(200);
    expect(frame).toHaveProperty("face");
    expect(frame).toHaveProperty("body");
    expect(frame).toHaveProperty("legs");
    expect(frame).toHaveProperty("effectL");
    expect(frame).toHaveProperty("effectR");
    expect(frame).toHaveProperty("accessory");
    expect(frame).toHaveProperty("bubble");
    expect(frame).toHaveProperty("mood");
    expect(frame).toHaveProperty("phase");
    expect(frame).toHaveProperty("intensity");
  });

  test("setMood transitions to target mood", () => {
    const engine = new KodiAnimEngine();
    engine.setMood("working");
    // May be in anticipation or performing
    const frame = engine.tick(0);
    expect(["working", "curious", "idle"]).toContain(frame.mood);
    // After enough time, should settle into working
    for (let i = 0; i < 20; i++) engine.tick(100);
    const later = engine.tick(0);
    expect(later.mood).toBe("working");
  });

  test("react sets mood and speech for tool_start", () => {
    const engine = new KodiAnimEngine();
    engine.react({ type: "tool_start", detail: "Read" });
    const frame = engine.tick(0);
    expect(frame.bubble).toContain("Read");
  });

  test("react sets celebrating for commit", async () => {
    const engine = new KodiAnimEngine();
    engine.react({ type: "commit" });
    // Wait for real-time transition to complete
    await Bun.sleep(400);
    for (let i = 0; i < 10; i++) engine.tick(100);
    const frame = engine.tick(0);
    expect(frame.mood).toBe("celebrating");
  });

  test("react sets worried for tool_error", async () => {
    const engine = new KodiAnimEngine();
    engine.react({ type: "tool_error" });
    await Bun.sleep(400);
    for (let i = 0; i < 10; i++) engine.tick(100);
    const frame = engine.tick(0);
    expect(frame.mood).toBe("worried");
  });

  test("react sets angry for test_fail", async () => {
    const engine = new KodiAnimEngine();
    engine.react({ type: "test_fail" });
    // Wait for real-time transition to complete
    await Bun.sleep(400);
    for (let i = 0; i < 10; i++) engine.tick(100);
    expect(engine.tick(0).mood).toBe("angry");
  });

  test("say sets bubble text with expiry", () => {
    const engine = new KodiAnimEngine();
    engine.say("hello!", 1000);
    expect(engine.tick(0).bubble).toBe("hello!");
  });

  test("windDown transitions to sleeping after long idle", () => {
    const engine = new KodiAnimEngine();
    engine.windDown(130_000);
    for (let i = 0; i < 20; i++) engine.tick(100);
    expect(engine.tick(0).mood).toBe("sleeping");
  });

  test("blink cycles eyes between open and closed", () => {
    const engine = new KodiAnimEngine();
    const faces = new Set<string>();
    // Tick enough times to see a blink
    for (let i = 0; i < 100; i++) {
      const frame = engine.tick(200);
      faces.add(frame.face);
    }
    // Should have at least 2 different face variants (open + closed)
    expect(faces.size).toBeGreaterThanOrEqual(2);
  });

  test("intensity increases with running agents", () => {
    const engine = new KodiAnimEngine();
    engine.runningAgents = 3;
    engine.react({ type: "tool_start" });
    const frame = engine.tick(0);
    expect(frame.intensity).toBeGreaterThan(0.7);
  });

  test("context pressure boosts intensity", () => {
    const engine = new KodiAnimEngine();
    engine.contextPressure = 0.9;
    engine.react({ type: "streaming" });
    const frame = engine.tick(0);
    expect(frame.intensity).toBeGreaterThan(0.5);
  });

  test("face layer contains box-drawing characters", () => {
    const engine = new KodiAnimEngine();
    const frame = engine.tick(0);
    expect(frame.face).toContain("│");
  });

  test("multiple rapid ticks produce stable output", () => {
    const engine = new KodiAnimEngine();
    engine.react({ type: "tool_start", detail: "Bash" });
    let lastMood = "";
    for (let i = 0; i < 50; i++) {
      const frame = engine.tick(50);
      expect(frame.mood).toBeTruthy();
      lastMood = frame.mood;
    }
    expect(lastMood).toBeTruthy();
  });
});
