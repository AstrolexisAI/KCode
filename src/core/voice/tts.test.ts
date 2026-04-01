// KCode - TTS Tests

import { describe, test, expect, beforeEach } from "bun:test";
import { LocalTTS } from "./tts";

describe("LocalTTS", () => {
  let tts: LocalTTS;

  beforeEach(() => {
    tts = new LocalTTS({ backend: "espeak" });
  });

  // ─── splitSentences ─────────────────────────────────────────

  test("splits simple sentences", () => {
    const result = tts.splitSentences("Hello world. How are you?");
    expect(result.complete).toEqual(["Hello world.", "How are you?"]);
    expect(result.remaining).toBe("");
  });

  test("handles sentence with exclamation", () => {
    const result = tts.splitSentences("Wow! That is great.");
    expect(result.complete).toEqual(["Wow!", "That is great."]);
  });

  test("keeps incomplete sentence in remaining", () => {
    const result = tts.splitSentences("Hello world. This is not finished");
    expect(result.complete).toEqual(["Hello world."]);
    expect(result.remaining).toBe("This is not finished");
  });

  test("handles text with no punctuation", () => {
    const result = tts.splitSentences("No punctuation here");
    expect(result.complete).toEqual([]);
    expect(result.remaining).toBe("No punctuation here");
  });

  test("handles empty string", () => {
    const result = tts.splitSentences("");
    expect(result.complete).toEqual([]);
    expect(result.remaining).toBe("");
  });

  test("handles multiple periods", () => {
    const result = tts.splitSentences("First. Second. Third.");
    expect(result.complete).toHaveLength(3);
  });

  test("handles trailing whitespace after period", () => {
    const result = tts.splitSentences("Hello.  World. ");
    expect(result.complete).toEqual(["Hello.", "World."]);
  });

  test("handles question marks", () => {
    const result = tts.splitSentences("Is this working? Yes it is.");
    expect(result.complete).toEqual(["Is this working?", "Yes it is."]);
  });

  // ─── State management ──────────────────────────────────────

  test("isSpeaking returns false initially", () => {
    expect(tts.isSpeaking()).toBe(false);
  });

  test("stop does not crash when nothing is playing", () => {
    tts.stop();
    expect(tts.isSpeaking()).toBe(false);
  });

  // ─── speakStream ────────────────────────────────────────────

  test("speakStream processes async iterable", async () => {
    // Mock speak to track calls
    const spoken: string[] = [];
    const originalSpeak = tts.speak.bind(tts);
    tts.speak = async (text: string) => {
      spoken.push(text);
    };

    async function* textStream() {
      yield "Hello ";
      yield "world. ";
      yield "How ";
      yield "are you?";
    }

    await tts.speakStream(textStream());

    // Should have spoken "Hello world." and "How are you?"
    expect(spoken).toContain("Hello world.");
    expect(spoken).toContain("How are you?");
  });

  test("speakStream handles single chunk", async () => {
    const spoken: string[] = [];
    tts.speak = async (text: string) => { spoken.push(text); };

    async function* textStream() {
      yield "Short text.";
    }

    await tts.speakStream(textStream());
    expect(spoken).toContain("Short text.");
  });

  test("speakStream flushes remaining buffer", async () => {
    const spoken: string[] = [];
    tts.speak = async (text: string) => { spoken.push(text); };

    async function* textStream() {
      yield "No period here";
    }

    await tts.speakStream(textStream());
    expect(spoken).toContain("No period here");
  });
});
