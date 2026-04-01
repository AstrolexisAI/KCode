// KCode - VAD Tests

import { beforeEach, describe, expect, test } from "bun:test";
import { VoiceActivityDetector } from "./vad";

describe("VoiceActivityDetector", () => {
  let vad: VoiceActivityDetector;

  beforeEach(() => {
    vad = new VoiceActivityDetector({ sensitivity: "medium" }, 16000, 320);
  });

  // ─── RMS calculation ────────────────────────────────────────

  test("calculateRMS returns 0 for silence", () => {
    const silence = new Float32Array(320);
    expect(vad.calculateRMS(silence)).toBe(0);
  });

  test("calculateRMS returns correct value for known signal", () => {
    // Constant signal of 0.5 => RMS = 0.5
    const signal = new Float32Array(320).fill(0.5);
    expect(vad.calculateRMS(signal)).toBeCloseTo(0.5, 4);
  });

  test("calculateRMS returns correct value for sine wave", () => {
    const signal = new Float32Array(320);
    for (let i = 0; i < 320; i++) {
      signal[i] = Math.sin((2 * Math.PI * i) / 320);
    }
    // RMS of sine = 1/sqrt(2) ≈ 0.7071
    expect(vad.calculateRMS(signal)).toBeCloseTo(0.7071, 3);
  });

  test("calculateRMS handles empty array", () => {
    expect(vad.calculateRMS(new Float32Array(0))).toBe(0);
  });

  // ─── Calibration ────────────────────────────────────────────

  test("calibration sets baseline from noise floor", () => {
    const noise = new Float32Array(320).fill(0.001);
    vad.calibrate(noise);
    expect(vad.isCalibrated()).toBe(true);
    expect(vad.getBaseline()).toBeGreaterThan(0);
  });

  test("calibration adjusts threshold based on baseline", () => {
    const noise = new Float32Array(320).fill(0.01);
    vad.calibrate(noise);
    // Medium sensitivity: threshold = baseline * 3
    expect(vad.getThreshold()).toBeCloseTo(0.01 * 3, 4);
  });

  test("multiple calibration samples refine baseline", () => {
    const noise1 = new Float32Array(320).fill(0.01);
    const noise2 = new Float32Array(320).fill(0.02);
    vad.calibrate(noise1);
    const baseline1 = vad.getBaseline();
    vad.calibrate(noise2);
    const baseline2 = vad.getBaseline();
    // Average should be between the two
    expect(baseline2).toBeGreaterThan(baseline1);
  });

  // ─── Sensitivity ────────────────────────────────────────────

  test("high sensitivity uses lower multiplier", () => {
    const highVad = new VoiceActivityDetector({ sensitivity: "high" });
    const noise = new Float32Array(320).fill(0.01);
    highVad.calibrate(noise);
    // High = multiplier 2
    expect(highVad.getThreshold()).toBeCloseTo(0.01 * 2, 4);
  });

  test("low sensitivity uses higher multiplier", () => {
    const lowVad = new VoiceActivityDetector({ sensitivity: "low" });
    const noise = new Float32Array(320).fill(0.01);
    lowVad.calibrate(noise);
    // Low = multiplier 5
    expect(lowVad.getThreshold()).toBeCloseTo(0.01 * 5, 4);
  });

  // ─── Speech detection ───────────────────────────────────────

  test("detects speech-start with loud signal", () => {
    // Set a low threshold
    vad.calibrate(new Float32Array(320).fill(0.001));

    // Feed loud audio frames
    const loud = new Float32Array(320).fill(0.5);
    let event = null;
    for (let i = 0; i < 50; i++) {
      // Enough frames to exceed speechDuration
      const e = vad.process(loud);
      if (e) event = e;
    }

    expect(event).not.toBeNull();
    expect(event!.type).toBe("speech-start");
  });

  test("detects speech-end after silence", () => {
    vad.calibrate(new Float32Array(320).fill(0.001));

    // Start speech
    const loud = new Float32Array(320).fill(0.5);
    for (let i = 0; i < 50; i++) vad.process(loud);

    // Feed silence
    const silence = new Float32Array(320).fill(0.0001);
    let event = null;
    for (let i = 0; i < 200; i++) {
      // Enough for silenceDuration
      const e = vad.process(silence);
      if (e && e.type === "speech-end") event = e;
    }

    expect(event).not.toBeNull();
    expect(event!.type).toBe("speech-end");
  });

  test("no event during silence", () => {
    vad.calibrate(new Float32Array(320).fill(0.01));
    const silence = new Float32Array(320).fill(0.001);
    const event = vad.process(silence);
    expect(event).toBeNull();
  });

  // ─── Reset ──────────────────────────────────────────────────

  test("reset clears speech state but keeps calibration", () => {
    vad.calibrate(new Float32Array(320).fill(0.001));
    const loud = new Float32Array(320).fill(0.5);
    for (let i = 0; i < 50; i++) vad.process(loud);

    vad.reset();
    expect(vad.getCurrentState()).toBe("silence");
    expect(vad.isCalibrated()).toBe(true);
  });

  test("fullReset clears everything", () => {
    vad.calibrate(new Float32Array(320).fill(0.01));
    vad.fullReset();
    expect(vad.isCalibrated()).toBe(false);
    expect(vad.getBaseline()).toBe(0);
  });
});
