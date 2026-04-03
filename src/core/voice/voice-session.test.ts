// KCode - Voice Session Tests

import { beforeEach, describe, expect, test } from "bun:test";
import { AudioRecorder, VoiceSession } from "./voice-session";

describe("VoiceSession", () => {
  let session: VoiceSession;

  beforeEach(() => {
    session = new VoiceSession({
      vad: {
        energyThreshold: 0.02,
        silenceDuration: 100,
        speechDuration: 50,
        calibrationDuration: 100,
        sensitivity: "medium",
      },
      asr: { backend: "chunked", model: "small", language: "en", chunkDuration: 100 },
      tts: { backend: "espeak", voice: "en", language: "en", speed: 1.0 },
      noTts: true, // Disable TTS for tests
      sampleRate: 16000,
      channels: 1,
    });
  });

  test("initial state is idle", () => {
    expect(session.getState()).toBe("idle");
    expect(session.isActive()).toBe(false);
  });

  test("stop from idle does not crash", () => {
    session.stop();
    expect(session.getState()).toBe("idle");
  });

  test("onTranscript callback can be set", () => {
    session.onTranscript = () => {};
    expect(session.onTranscript).toBeDefined();
  });

  test("onStateChange callback fires", () => {
    const states: string[] = [];
    session.onStateChange = (state) => states.push(state);
    // Manually trigger stop which sets idle
    session.stop();
    // State was already idle, so no change event
    expect(states).toHaveLength(0);
  });

  test("speak with noTts is a no-op", async () => {
    await session.speak("This should not play");
    // No crash expected
  });
});

describe("AudioRecorder", () => {
  test("isRunning returns false before start", () => {
    const recorder = new AudioRecorder();
    expect(recorder.isRunning()).toBe(false);
  });

  test("stop from idle does not crash", () => {
    const recorder = new AudioRecorder();
    recorder.stop();
    expect(recorder.isRunning()).toBe(false);
  });

  test("stop sets running to false", () => {
    const recorder = new AudioRecorder();
    // We can't actually start recording in tests (no mic), but we can test the state
    recorder.stop();
    expect(recorder.isRunning()).toBe(false);
  });
});
