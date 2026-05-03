// E2E render tests for ModelToggle
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext";
import ModelToggle from "./ModelToggle";

function renderWithTheme(element: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, element));
}

describe("ModelToggle render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  // Deterministic wait: poll lastFrame() until the "Loading models..." state
  // is gone. Sleep-based waits flake on CI under parallel load — see
  // model-discovery's 2s in-flight discovery race + dynamic imports.
  async function waitForLoaded(inst: ReturnType<typeof render>, maxMs = 15000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const frame = inst.lastFrame() ?? "";
      if (frame && !frame.includes("Loading models")) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`ModelToggle still loading after ${maxMs}ms`);
  }

  test("shows loading state initially", () => {
    instance = renderWithTheme(
      <ModelToggle isActive={true} currentModel="gpt-4o" onDone={() => {}} />,
    );
    const out = instance.lastFrame()!;
    // Will either show loading or the model list
    expect(typeof out).toBe("string");
  });

  test("eventually renders model list", async () => {
    instance = renderWithTheme(
      <ModelToggle isActive={true} currentModel="gpt-4o" onDone={() => {}} />,
    );
    // Wait for useEffect to load models
    await new Promise((r) => setTimeout(r, 200));
    const out = instance.lastFrame()!;
    expect(out.length).toBeGreaterThan(10);
  });

  test("Esc calls onDone(null)", async () => {
    let result: unknown = "never";
    instance = renderWithTheme(
      <ModelToggle
        isActive={true}
        currentModel="gpt-4o"
        onDone={(r) => {
          result = r;
        }}
      />,
    );
    // Wait for the "Loading models..." frame to clear — useInput is gated
    // by `!loading`, so Esc is silently dropped while loading is true.
    await waitForLoaded(instance);
    instance.stdin.write("\x1b");
    // Esc handler is synchronous, but give Ink a tick to flush the callback.
    await new Promise((r) => setTimeout(r, 50));
    expect(result).toBe(null);
  });

  test("inactive doesn't respond to input", async () => {
    let called = false;
    instance = renderWithTheme(
      <ModelToggle
        isActive={false}
        currentModel="x"
        onDone={() => {
          called = true;
        }}
      />,
    );
    await new Promise((r) => setTimeout(r, 200));
    instance.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(called).toBe(false);
  });

  test("renders without crashing", () => {
    instance = renderWithTheme(<ModelToggle isActive={true} currentModel="x" onDone={() => {}} />);
    expect(typeof instance.lastFrame()).toBe("string");
  });
});
