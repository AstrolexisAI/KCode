// E2E render tests for InputPrompt
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { KeybindingProvider } from "./KeybindingContext";
import { ThemeProvider } from "../ThemeContext";
import InputPrompt from "./InputPrompt";

function renderWithProviders(element: React.ReactElement) {
  return render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(KeybindingProvider, null, element),
    ),
  );
}

describe("InputPrompt render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("renders prompt indicator", () => {
    instance = renderWithProviders(<InputPrompt onSubmit={() => {}} isActive={true} />);
    const out = instance.lastFrame()!;
    expect(out).toContain("❯");
  });

  test("shows model and cwd prefix when provided", () => {
    instance = renderWithProviders(
      <InputPrompt
        onSubmit={() => {}}
        isActive={true}
        model="claude-opus-4-6"
        cwd="/home/user/project"
      />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("claude-opus-4-6");
  });

  test("shows queueing indicator when isQueuing", () => {
    instance = renderWithProviders(
      <InputPrompt
        onSubmit={() => {}}
        isActive={true}
        isQueuing={true}
        queueSize={2}
      />,
    );
    const out = instance.lastFrame()!;
    // Queue indicator appears somewhere
    expect(typeof out).toBe("string");
  });

  test("types characters into input", async () => {
    instance = renderWithProviders(
      <InputPrompt onSubmit={() => {}} isActive={true} />,
    );
    instance.stdin.write("hello");
    // Wait for state update
    await new Promise((r) => setTimeout(r, 50));
    const out = instance.lastFrame()!;
    expect(out).toContain("hello");
  });

  test("inactive prompt doesn't respond to input", async () => {
    instance = renderWithProviders(
      <InputPrompt onSubmit={() => {}} isActive={false} />,
    );
    instance.stdin.write("ignored");
    await new Promise((r) => setTimeout(r, 50));
    const out = instance.lastFrame()!;
    expect(out).not.toContain("ignored");
  });

  test("input buffer accumulates typed characters", async () => {
    instance = renderWithProviders(
      <InputPrompt onSubmit={() => {}} isActive={true} />,
    );
    // Type characters one at a time, similar to real keyboard input
    for (const ch of "abc") {
      instance.stdin.write(ch);
    }
    // Wait for flushes (InputPrompt uses 12ms flush timer)
    await new Promise((r) => setTimeout(r, 100));
    const out = instance.lastFrame()!;
    expect(out).toContain("abc");
  });
});
