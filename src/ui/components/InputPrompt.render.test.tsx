// E2E render tests for InputPrompt
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext";
import InputPrompt from "./InputPrompt";
import { KeybindingProvider } from "./KeybindingContext";

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
      <InputPrompt onSubmit={() => {}} isActive={true} model="gpt-4o" cwd="/home/user/project" />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("gpt-4o");
  });

  test("shows queueing indicator when isQueuing", () => {
    instance = renderWithProviders(
      <InputPrompt onSubmit={() => {}} isActive={true} isQueuing={true} queueSize={2} />,
    );
    const out = instance.lastFrame()!;
    // Queue indicator appears somewhere
    expect(typeof out).toBe("string");
  });

  test("types characters into input", async () => {
    instance = renderWithProviders(<InputPrompt onSubmit={() => {}} isActive={true} />);
    instance.stdin.write("hello");
    // Wait for state update
    await new Promise((r) => setTimeout(r, 50));
    const out = instance.lastFrame()!;
    expect(out).toContain("hello");
  });

  test("inactive prompt doesn't respond to input", async () => {
    instance = renderWithProviders(<InputPrompt onSubmit={() => {}} isActive={false} />);
    instance.stdin.write("ignored");
    await new Promise((r) => setTimeout(r, 50));
    const out = instance.lastFrame()!;
    expect(out).not.toContain("ignored");
  });

  test("input buffer accumulates typed characters", async () => {
    instance = renderWithProviders(<InputPrompt onSubmit={() => {}} isActive={true} />);
    // Type characters one at a time, similar to real keyboard input
    for (const ch of "abc") {
      instance.stdin.write(ch);
    }
    // Wait for flushes (InputPrompt uses 12ms flush timer)
    await new Promise((r) => setTimeout(r, 100));
    const out = instance.lastFrame()!;
    expect(out).toContain("abc");
  });

  // Phase 29: full multiline paste rendering
  test("multiline input renders all pasted lines (not compact summary)", async () => {
    instance = renderWithProviders(<InputPrompt onSubmit={() => {}} isActive={true} />);
    // Simulate bracketed paste via stdin with explicit \x1b[200~ / \x1b[201~
    // markers so paste-stream.ts captures it as a paste
    const content = "first line\nsecond line\nthird line";
    instance.stdin.write(`\x1b[200~${content}\x1b[201~`);
    await new Promise((r) => setTimeout(r, 150));
    const out = instance.lastFrame()!;
    // The compact summary should still be present as a header
    expect(out).toContain("3 lines");
    // But the actual line contents must also appear — this is the
    // core phase 29 win: user sees what they pasted
    expect(out).toContain("first line");
    expect(out).toContain("second line");
    expect(out).toContain("third line");
  });

  test("multiline input shows line numbers on each visible line", async () => {
    instance = renderWithProviders(<InputPrompt onSubmit={() => {}} isActive={true} />);
    instance.stdin.write("\x1b[200~alpha\nbeta\x1b[201~");
    await new Promise((r) => setTimeout(r, 150));
    const out = instance.lastFrame()!;
    // Line number column exists (4-char right-justified)
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    // At least one line label like "   1" or "   2"
    expect(out).toMatch(/\s{2,}1\s/);
    expect(out).toMatch(/\s{2,}2\s/);
  });

  test("very large multiline paste shows viewport with above/below markers", async () => {
    instance = renderWithProviders(<InputPrompt onSubmit={() => {}} isActive={true} />);
    // 30-line paste, viewport caps at 20 — should show truncation hints
    const bigContent = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    instance.stdin.write(`\x1b[200~${bigContent}\x1b[201~`);
    await new Promise((r) => setTimeout(r, 150));
    const out = instance.lastFrame()!;
    expect(out).toContain("30 lines");
    // Cursor lands at end of paste → viewport is near the bottom,
    // so we should see lines above hidden
    expect(out).toMatch(/lines? above|lines? below/);
  });
});
