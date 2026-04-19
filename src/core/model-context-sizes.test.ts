// Tests for the model context-size registry used by the setup
// wizard and migration 005.

import { describe, expect, test } from "bun:test";
import { guessContextSize } from "./model-context-sizes";

describe("guessContextSize", () => {
  test("Claude 4.x family resolves to 1M (beta tier KCode enables by default)", () => {
    expect(guessContextSize("claude-sonnet-4-6")).toBe(1_000_000);
    expect(guessContextSize("claude-opus-4-7")).toBe(1_000_000);
    expect(guessContextSize("claude-haiku-4-5")).toBe(1_000_000);
  });

  test("older Claude 3.x remains at 200k (no 1M beta)", () => {
    expect(guessContextSize("claude-opus-3")).toBe(200_000);
    expect(guessContextSize("claude-sonnet-3-7")).toBe(200_000);
    expect(guessContextSize("claude-future")).toBe(200_000);
  });

  test("unknown Claude 4.x variants fall through to 1M prefix rule", () => {
    expect(guessContextSize("claude-sonnet-4-99")).toBe(1_000_000);
    expect(guessContextSize("claude-opus-4-future")).toBe(1_000_000);
  });

  test("OpenAI flagship + reasoning families", () => {
    expect(guessContextSize("gpt-4o")).toBe(128_000);
    expect(guessContextSize("gpt-4o-mini")).toBe(128_000);
    expect(guessContextSize("o3")).toBe(200_000);
    expect(guessContextSize("o4-mini")).toBe(200_000);
  });

  test("Grok variants — grok-4 gets 2M, grok-3 stays at 131k", () => {
    expect(guessContextSize("grok-4")).toBe(2_000_000);
    expect(guessContextSize("grok-code-fast-1")).toBe(256_000);
    expect(guessContextSize("grok-3")).toBe(131_072);
    // Unknown grok-* prefix fallback
    expect(guessContextSize("grok-2")).toBe(131_072);
  });

  test("unknown grok-4 subvariants fall through to 2M prefix rule", () => {
    expect(guessContextSize("grok-4-mini")).toBe(2_000_000);
    expect(guessContextSize("grok-4-turbo")).toBe(2_000_000);
  });

  test("DeepSeek distinguishes reasoner from chat", () => {
    expect(guessContextSize("deepseek-chat")).toBe(64_000);
    expect(guessContextSize("deepseek-v3")).toBe(64_000);
    expect(guessContextSize("deepseek-r1")).toBe(65_536);
    expect(guessContextSize("deepseek-reasoner")).toBe(65_536);
  });

  test("Gemini family", () => {
    expect(guessContextSize("gemini-2.5-pro")).toBe(2_000_000);
    expect(guessContextSize("gemini-2.5-flash")).toBe(1_000_000);
  });

  test("Llama family (Together/Groq format)", () => {
    expect(guessContextSize("llama-3.3-70b-versatile")).toBe(131_072);
    expect(guessContextSize("meta-llama/Llama-3.3-70B-Instruct-Turbo")).toBe(131_072);
  });

  test("unknown model returns undefined (caller decides default)", () => {
    expect(guessContextSize("totally-made-up-model-xyz")).toBeUndefined();
    expect(guessContextSize("")).toBeUndefined();
  });

  test("regression guard: no exact entry bleeds into wrong prefix rule", () => {
    // gpt-3.5-turbo has its own 16k entry; it must NOT pick up
    // the gpt-4 prefix rule's 128k size.
    expect(guessContextSize("gpt-3.5-turbo")).toBe(16_385);
  });
});
