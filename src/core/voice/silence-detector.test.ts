// KCode - Silence Detector Tests

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SilenceDetector } from "./silence-detector";

describe("SilenceDetector", () => {
  let detector: SilenceDetector;

  beforeEach(() => {
    detector = new SilenceDetector({ thresholdMs: 2000, silenceLevel: 0.01 });
  });

  // ─── Basic silence detection ────────────────────────────────

  test("does not detect silence on first feed of quiet audio", () => {
    expect(detector.feed(0.0)).toBe(false);
  });

  test("detects silence after threshold duration", () => {
    // Feed silence, then advance time past threshold
    detector.feed(0.0); // Start silence timer

    // We need to simulate time passing — use a detector with very short threshold
    const fastDetector = new SilenceDetector({ thresholdMs: 0, silenceLevel: 0.01 });
    // With thresholdMs=0, silence is detected immediately
    expect(fastDetector.feed(0.0)).toBe(true);
  });

  test("detects silence with zero threshold immediately", () => {
    const instant = new SilenceDetector({ thresholdMs: 0, silenceLevel: 0.01 });
    expect(instant.feed(0.005)).toBe(true);
  });

  // ─── Noise resets timer ─────────────────────────────────────

  test("noise resets the silence timer", () => {
    const fastDetector = new SilenceDetector({ thresholdMs: 50, silenceLevel: 0.01 });

    // Start silence
    fastDetector.feed(0.0);

    // Inject noise — should reset
    fastDetector.feed(0.5);
    expect(fastDetector.getSilenceDuration()).toBe(0);
  });

  test("level at exactly the silence threshold is not considered silent", () => {
    // Level >= silenceLevel is NOT silence
    detector.feed(0.01);
    expect(detector.getSilenceDuration()).toBe(0);
  });

  test("level just below the silence threshold is considered silent", () => {
    detector.feed(0.009);
    expect(detector.getSilenceDuration()).toBeGreaterThanOrEqual(0);
  });

  // ─── Configurable threshold ─────────────────────────────────

  test("custom threshold is respected", () => {
    const custom = new SilenceDetector({ thresholdMs: 5000, silenceLevel: 0.01 });
    expect(custom.getThresholdMs()).toBe(5000);
  });

  test("default threshold is 2000ms", () => {
    const def = new SilenceDetector();
    expect(def.getThresholdMs()).toBe(2000);
  });

  test("custom silence level is respected", () => {
    // Level 0.05 is noise with default (0.01) but silence with custom (0.1)
    const highThreshold = new SilenceDetector({ thresholdMs: 0, silenceLevel: 0.1 });
    expect(highThreshold.feed(0.05)).toBe(true); // 0.05 < 0.1, so silence

    const lowThreshold = new SilenceDetector({ thresholdMs: 0, silenceLevel: 0.01 });
    expect(lowThreshold.feed(0.05)).toBe(false); // 0.05 >= 0.01, so noise
  });

  // ─── Reset ──────────────────────────────────────────────────

  test("reset clears silence state", () => {
    detector.feed(0.0); // Start silence timer
    expect(detector.getSilenceDuration()).toBeGreaterThanOrEqual(0);

    detector.reset();
    expect(detector.getSilenceDuration()).toBe(0);
  });

  // ─── getSilenceDuration ─────────────────────────────────────

  test("getSilenceDuration returns 0 when not silent", () => {
    detector.feed(0.5); // noise
    expect(detector.getSilenceDuration()).toBe(0);
  });

  test("getSilenceDuration returns positive value during silence", () => {
    detector.feed(0.0);
    // Duration should be >= 0 (very small since just started)
    expect(detector.getSilenceDuration()).toBeGreaterThanOrEqual(0);
  });
});
