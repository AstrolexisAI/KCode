// Tests for Spinner component — format helpers for tokens, speed, elapsed time
import { describe, expect, test } from "bun:test";
import { formatElapsed, formatSpeed, formatTokens } from "./Spinner";

describe("formatElapsed", () => {
  test("seconds under 60s", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(500)).toBe("0s");
    expect(formatElapsed(5000)).toBe("5s");
    expect(formatElapsed(59_000)).toBe("59s");
  });

  test("minutes + seconds format with zero-padding", () => {
    expect(formatElapsed(60_000)).toBe("1m00s");
    expect(formatElapsed(65_000)).toBe("1m05s");
    expect(formatElapsed(125_000)).toBe("2m05s");
    expect(formatElapsed(3599_000)).toBe("59m59s");
  });

  test("hours roll into minutes", () => {
    expect(formatElapsed(3600_000)).toBe("60m00s");
  });
});

describe("formatTokens", () => {
  test("under 1000 shows raw count", () => {
    expect(formatTokens(0)).toBe("0 tok");
    expect(formatTokens(42)).toBe("42 tok");
    expect(formatTokens(999)).toBe("999 tok");
  });

  test("1K-10K shows one decimal", () => {
    expect(formatTokens(1000)).toBe("1.0K tok");
    expect(formatTokens(1500)).toBe("1.5K tok");
    expect(formatTokens(9999)).toBe("10.0K tok");
  });

  test("10K+ shows rounded thousands", () => {
    expect(formatTokens(10_000)).toBe("10K tok");
    expect(formatTokens(42_500)).toBe("43K tok");
    expect(formatTokens(1_234_567)).toBe("1235K tok");
  });
});

describe("formatSpeed", () => {
  test("under 1 t/s shows <1", () => {
    expect(formatSpeed(0)).toBe("<1 t/s");
    expect(formatSpeed(0.5)).toBe("<1 t/s");
    expect(formatSpeed(0.99)).toBe("<1 t/s");
  });

  test("1-10 t/s shows decimal", () => {
    expect(formatSpeed(1)).toBe("1.0 t/s");
    expect(formatSpeed(5.7)).toBe("5.7 t/s");
    expect(formatSpeed(9.99)).toBe("10.0 t/s");
  });

  test("10+ t/s rounds to integer", () => {
    expect(formatSpeed(10)).toBe("10 t/s");
    expect(formatSpeed(42.7)).toBe("43 t/s");
    expect(formatSpeed(150)).toBe("150 t/s");
  });
});
