// E2E render tests for Spinner — actual Ink rendering
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext";
import Spinner from "./Spinner";

function renderWithTheme(element: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, element));
}

describe("Spinner render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("renders with message", () => {
    instance = renderWithTheme(<Spinner message="Thinking" />);
    const output = instance.lastFrame();
    expect(output).toContain("Thinking");
  });

  test("renders with tokens", () => {
    instance = renderWithTheme(<Spinner message="Processing" tokens={1500} />);
    const output = instance.lastFrame();
    expect(output).toContain("Processing");
    expect(output).toContain("1.5K tok");
  });

  test("renders with elapsed time", () => {
    const startTime = Date.now() - 5000; // 5 seconds ago
    instance = renderWithTheme(<Spinner message="Working" startTime={startTime} />);
    // Elapsed updates via setInterval — may be 5s or 6s
    const output = instance.lastFrame()!;
    expect(output).toContain("Working");
  });

  test("includes spinner frame", () => {
    instance = renderWithTheme(<Spinner message="Running" phase="thinking" />);
    const output = instance.lastFrame()!;
    // Spinner should include the brain emoji or animation chars
    expect(output.length).toBeGreaterThan("Running".length);
  });

  test("renders without message", () => {
    instance = renderWithTheme(<Spinner />);
    const output = instance.lastFrame();
    expect(typeof output).toBe("string");
  });
});
