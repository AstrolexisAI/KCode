import { describe, expect, test } from "bun:test";
import { detectModelSize, getModelProfile, isToolAllowedForProfile } from "./model-profile";

describe("detectModelSize", () => {
  test("mark5-pico is tiny", () => {
    expect(detectModelSize("mnemo:mark5-pico")).toBe("tiny");
  });

  test("mark5-nano is small", () => {
    expect(detectModelSize("mnemo:mark5-nano")).toBe("small");
  });

  test("mark5-mini is medium", () => {
    expect(detectModelSize("mnemo:mark5-mini")).toBe("medium");
  });

  test("mark5-mid is medium", () => {
    expect(detectModelSize("mnemo:mark5-mid")).toBe("medium");
  });

  test("frontier cloud APIs are large", () => {
    expect(detectModelSize("claude-opus-4-7")).toBe("large");
  });

  test("claude models are large", () => {
    expect(detectModelSize("claude-sonnet-4-6")).toBe("large");
  });

  test("gpt-4 is large", () => {
    expect(detectModelSize("gpt-4o")).toBe("large");
  });

  test("unknown model defaults to medium", () => {
    expect(detectModelSize("some-custom-model")).toBe("medium");
  });

  test("name with 7b is small", () => {
    expect(detectModelSize("my-custom-7b-model")).toBe("small");
  });

  // Regression: quantization labels like "4bit"/"8bit" must NOT trigger
  // the "1b/2b/3b/4b" param-count match. GLM-4.7-Flash is a 32B model;
  // calling it tiny gave maxTokens=2048 and a 7-min hang on Mac
  // (verified 2026-05-09).
  test("MLX repo with 4bit suffix resolves to medium via mlxRepo lookup", () => {
    expect(detectModelSize("mlx-community/GLM-4.7-Flash-4bit")).toBe("medium");
  });

  test("8bit / Q8_0 suffix doesn't trigger 8b match", () => {
    expect(detectModelSize("custom-model-8bit")).toBe("medium"); // unknown → default
    expect(detectModelSize("custom-model-Q8_0")).toBe("medium");
  });

  test("standalone '7b' still matches small (no quant suffix interference)", () => {
    expect(detectModelSize("Qwen2.5-7b-instruct")).toBe("small");
  });

  test("32b in name still matches medium even with 4bit quant", () => {
    expect(detectModelSize("custom-32b-instruct-4bit")).toBe("medium");
  });
});

describe("getModelProfile", () => {
  test("tiny profile has limited tools", () => {
    const p = getModelProfile("mnemo:mark5-pico");
    expect(p.tools).not.toBe("all");
    expect((p.tools as string[]).length).toBeLessThan(10);
    expect(p.maxTokens).toBe(2048);
    expect(p.promptMode).toBe("lite");
  });

  test("small profile has more tools", () => {
    const p = getModelProfile("mnemo:mark5-nano");
    expect(p.tools).not.toBe("all");
    expect((p.tools as string[]).length).toBeGreaterThan(5);
    expect(p.maxTokens).toBe(4096);
  });

  test("large profile has all tools", () => {
    const p = getModelProfile("claude-opus-4-7");
    expect(p.tools).toBe("all");
    expect(p.maxTokens).toBe(16384);
    expect(p.promptMode).toBe("full");
  });
});

describe("isToolAllowedForProfile", () => {
  test("Read is allowed for tiny", () => {
    const p = getModelProfile("mnemo:mark5-pico");
    expect(isToolAllowedForProfile("Read", p)).toBe(true);
  });

  test("Plan is not allowed for tiny", () => {
    const p = getModelProfile("mnemo:mark5-pico");
    expect(isToolAllowedForProfile("Plan", p)).toBe(false);
  });

  test("everything is allowed for large", () => {
    const p = getModelProfile("claude-opus-4-7");
    expect(isToolAllowedForProfile("Plan", p)).toBe(true);
    expect(isToolAllowedForProfile("Agent", p)).toBe(true);
    expect(isToolAllowedForProfile("NotebookEdit", p)).toBe(true);
  });
});
