// E2E render tests for ContextGrid
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext";
import ContextGrid from "./ContextGrid";

function renderWithTheme(element: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, element));
}

describe("ContextGrid render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("renders when contextWindowSize > 0", () => {
    instance = renderWithTheme(
      <ContextGrid
        breakdown={{
          totalTokens: 50_000,
          contextWindowSize: 200_000,
          systemTokens: 15_000,
          messageTokens: 25_000,
          toolTokens: 10_000,
        }}
      />,
    );
    expect(typeof instance.lastFrame()).toBe("string");
  });

  test("renders nothing when contextWindowSize is 0", () => {
    instance = renderWithTheme(
      <ContextGrid
        breakdown={{
          totalTokens: 0,
          contextWindowSize: 0,
          systemTokens: 0,
          messageTokens: 0,
          toolTokens: 0,
        }}
      />,
    );
    // Should render empty/null
    const out = instance.lastFrame();
    expect(out).toBe("");
  });

  test("shows percentage used", () => {
    instance = renderWithTheme(
      <ContextGrid
        breakdown={{
          totalTokens: 100_000,
          contextWindowSize: 200_000,
          systemTokens: 30_000,
          messageTokens: 50_000,
          toolTokens: 20_000,
        }}
      />,
    );
    const out = instance.lastFrame()!;
    // "50%" may wrap across columns in narrow terminals — check both parts
    expect(out.replace(/\s+/g, " ")).toMatch(/5\s*0\s*%|50%/);
  });

  test("shows 0% when no tokens used", () => {
    instance = renderWithTheme(
      <ContextGrid
        breakdown={{
          totalTokens: 0,
          contextWindowSize: 200_000,
          systemTokens: 0,
          messageTokens: 0,
          toolTokens: 0,
        }}
      />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("0%");
  });

  test("caps at 100% when overfull", () => {
    instance = renderWithTheme(
      <ContextGrid
        breakdown={{
          totalTokens: 300_000,
          contextWindowSize: 200_000,
          systemTokens: 100_000,
          messageTokens: 150_000,
          toolTokens: 50_000,
        }}
      />,
    );
    const out = instance.lastFrame()!;
    // "100%" wraps vertically in narrow terminals — check for 1, 0, 0, % present
    const compact = out.replace(/[^0-9%]/g, "");
    expect(compact).toContain("100%");
  });

  test("renders visual bar", () => {
    instance = renderWithTheme(
      <ContextGrid
        breakdown={{
          totalTokens: 50_000,
          contextWindowSize: 200_000,
          systemTokens: 15_000,
          messageTokens: 25_000,
          toolTokens: 10_000,
        }}
      />,
    );
    const out = instance.lastFrame()!;
    // Contains block characters for the bar
    expect(out).toMatch(/[█░▓▒]/);
  });
});
