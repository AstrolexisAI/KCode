import { describe, test, expect } from "bun:test";
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

  test("mark5-80b is large", () => {
    expect(detectModelSize("mnemo:mark5-80b")).toBe("large");
  });

  test("mark5-titan is large", () => {
    expect(detectModelSize("mnemo:mark5-titan")).toBe("large");
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
    const p = getModelProfile("mnemo:mark5-80b");
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
    const p = getModelProfile("mnemo:mark5-80b");
    expect(isToolAllowedForProfile("Plan", p)).toBe(true);
    expect(isToolAllowedForProfile("Agent", p)).toBe(true);
    expect(isToolAllowedForProfile("NotebookEdit", p)).toBe(true);
  });
});
