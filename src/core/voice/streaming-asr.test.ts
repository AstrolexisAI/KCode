// KCode - Streaming ASR Tests

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StreamingASR } from "./streaming-asr";

describe("StreamingASR", () => {
  let asr: StreamingASR;

  beforeEach(() => {
    asr = new StreamingASR({ backend: "chunked", chunkDuration: 100 });
  });

  afterEach(() => {
    asr.stop();
  });

  // ─── float32ToInt16 conversion ──────────────────────────────

  test("float32ToInt16 converts correctly for zero", () => {
    const input = new Float32Array([0, 0, 0]);
    const output = asr.float32ToInt16(input);
    expect(output[0]).toBe(0);
    expect(output[1]).toBe(0);
  });

  test("float32ToInt16 converts positive values", () => {
    const input = new Float32Array([0.5]);
    const output = asr.float32ToInt16(input);
    expect(output[0]).toBe(16384); // 0.5 * 32768
  });

  test("float32ToInt16 converts negative values", () => {
    const input = new Float32Array([-0.5]);
    const output = asr.float32ToInt16(input);
    expect(output[0]).toBe(-16384);
  });

  test("float32ToInt16 clamps at max", () => {
    const input = new Float32Array([1.5]); // Over 1.0
    const output = asr.float32ToInt16(input);
    expect(output[0]).toBe(32767); // Clamped to max
  });

  test("float32ToInt16 clamps at min", () => {
    const input = new Float32Array([-1.5]);
    const output = asr.float32ToInt16(input);
    expect(output[0]).toBe(-32768); // Clamped to min
  });

  test("float32ToInt16 preserves length", () => {
    const input = new Float32Array(100);
    const output = asr.float32ToInt16(input);
    expect(output.length).toBe(100);
  });

  // ─── State management ───────────────────────────────────────

  test("isRunning returns false before start", () => {
    expect(asr.isRunning()).toBe(false);
  });

  test("stop sets running to false", () => {
    asr.stop();
    expect(asr.isRunning()).toBe(false);
  });

  // ─── Chunked mode ──────────────────────────────────────────

  test("feedAudio accumulates in chunked mode", async () => {
    const transcripts: string[] = [];
    // We can't fully test without whisper installed, but we can verify no crash
    await asr.start((event) => {
      transcripts.push(event.text);
    });
    expect(asr.isRunning()).toBe(true);

    const audio = new Float32Array(320).fill(0.1);
    asr.feedAudio(audio);
    asr.feedAudio(audio);

    asr.stop();
    expect(asr.isRunning()).toBe(false);
  });

  // ─── Multiple start/stop cycles ─────────────────────────────

  test("can restart after stop", async () => {
    await asr.start(() => {});
    expect(asr.isRunning()).toBe(true);
    asr.stop();
    expect(asr.isRunning()).toBe(false);

    await asr.start(() => {});
    expect(asr.isRunning()).toBe(true);
    asr.stop();
  });
});
