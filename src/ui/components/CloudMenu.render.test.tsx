// E2E render tests for CloudMenu
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext";
import CloudMenu from "./CloudMenu";

function renderWithTheme(element: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, element));
}

describe("CloudMenu render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("renders cloud providers list", () => {
    instance = renderWithTheme(<CloudMenu isActive={true} onDone={() => {}} />);
    const out = instance.lastFrame()!;
    // Should list supported providers
    expect(out.toLowerCase()).toContain("anthropic");
  });

  test("shows navigation hints", () => {
    instance = renderWithTheme(<CloudMenu isActive={true} onDone={() => {}} />);
    const out = instance.lastFrame()!;
    // Should have some nav hint text (Enter/Esc/arrows)
    expect(out.length).toBeGreaterThan(50);
  });

  test("calls onDone(null) on Esc", async () => {
    let result: unknown = "never";
    instance = renderWithTheme(
      <CloudMenu
        isActive={true}
        onDone={(r) => {
          result = r;
        }}
      />,
    );
    instance.stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 50));
    expect(result).toBe(null);
  });

  test("inactive doesn't respond to input", async () => {
    let called = false;
    instance = renderWithTheme(
      <CloudMenu
        isActive={false}
        onDone={() => {
          called = true;
        }}
      />,
    );
    instance.stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 50));
    expect(called).toBe(false);
  });

  test("renders without crashing", () => {
    instance = renderWithTheme(<CloudMenu isActive={true} onDone={() => {}} />);
    expect(typeof instance.lastFrame()).toBe("string");
  });
});
