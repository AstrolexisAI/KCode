import { test, expect, describe, afterEach } from "bun:test";

import {
  listStyles,
  setCurrentStyle,
  getCurrentStyle,
  getStyleInstructions,
} from "./output-styles.ts";

describe("output-styles", () => {
  afterEach(() => {
    // Reset to default style after each test
    setCurrentStyle("default");
  });

  // ─── listStyles ───

  test("listStyles returns at least 4 built-in styles", () => {
    const styles = listStyles();

    expect(styles.length).toBeGreaterThanOrEqual(4);
    expect(styles).toContain("default");
    expect(styles).toContain("concise");
    expect(styles).toContain("verbose");
    expect(styles).toContain("code-only");
  });

  // ─── setCurrentStyle / getCurrentStyle ───

  test("setCurrentStyle changes the active style", () => {
    expect(getCurrentStyle()).toBe("default");

    const ok = setCurrentStyle("concise");

    expect(ok).toBe(true);
    expect(getCurrentStyle()).toBe("concise");
  });

  test("setCurrentStyle returns false for unknown style", () => {
    const ok = setCurrentStyle("nonexistent-style-xyz");

    expect(ok).toBe(false);
    expect(getCurrentStyle()).toBe("default");
  });

  // ─── getStyleInstructions ───

  test("getStyleInstructions returns empty string for default", () => {
    setCurrentStyle("default");
    const instructions = getStyleInstructions();

    expect(instructions).toBe("");
  });

  test("getStyleInstructions returns string for non-default style", () => {
    setCurrentStyle("concise");
    const instructions = getStyleInstructions();

    expect(typeof instructions).toBe("string");
    expect(instructions.length).toBeGreaterThan(0);
    expect(instructions).toContain("concise");
  });

  test("getStyleInstructions returns content for verbose style", () => {
    setCurrentStyle("verbose");
    const instructions = getStyleInstructions();

    expect(instructions.length).toBeGreaterThan(0);
  });

  test("getStyleInstructions returns content for code-only style", () => {
    setCurrentStyle("code-only");
    const instructions = getStyleInstructions();

    expect(instructions.length).toBeGreaterThan(0);
    expect(instructions.toLowerCase()).toContain("code");
  });
});
