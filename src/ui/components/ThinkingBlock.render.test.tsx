// E2E render tests for ThinkingBlock
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext";
import ThinkingBlock from "./ThinkingBlock";

function renderWithTheme(element: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, element));
}

describe("ThinkingBlock render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("streaming shows 'Reasoning' banner", () => {
    instance = renderWithTheme(
      <ThinkingBlock text="Analyzing the problem..." isStreaming={true} />,
    );
    expect(instance.lastFrame()).toContain("Reasoning");
  });

  test("streaming shows brain emoji", () => {
    instance = renderWithTheme(
      <ThinkingBlock text="thinking" isStreaming={true} />,
    );
    expect(instance.lastFrame()).toContain("🧠");
  });

  test("streaming shows live preview of content", () => {
    instance = renderWithTheme(
      <ThinkingBlock
        text="First thought\nSecond thought\nThird thought"
        isStreaming={true}
      />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("Third thought"); // last line always shown
  });

  test("streaming truncates very long lines", () => {
    const longLine = "x".repeat(200);
    instance = renderWithTheme(
      <ThinkingBlock text={longLine} isStreaming={true} />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("…"); // ellipsis for truncation
  });

  test("streaming shows 'more lines above' when text is long", () => {
    const manyLines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    instance = renderWithTheme(
      <ThinkingBlock text={manyLines} isStreaming={true} />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("more lines above");
  });

  test("completed (collapsed) shows 'Reasoned' summary", () => {
    instance = renderWithTheme(
      <ThinkingBlock text="done thinking" isStreaming={false} />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("Reasoned");
  });

  test("completed collapsed shows token + line count", () => {
    const multiline = "line one\nline two\nline three";
    instance = renderWithTheme(
      <ThinkingBlock text={multiline} isStreaming={false} />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("3 lines");
  });

  test("completed single line shows 'line' singular", () => {
    instance = renderWithTheme(
      <ThinkingBlock text="just one line" isStreaming={false} />,
    );
    expect(instance.lastFrame()).toContain("1 line");
  });

  test("completed expanded shows full content", () => {
    instance = renderWithTheme(
      <ThinkingBlock
        text="Full reasoning text here"
        isStreaming={false}
        defaultExpanded={true}
      />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("Full reasoning text here");
  });

  test("empty text streaming doesn't crash", () => {
    instance = renderWithTheme(<ThinkingBlock text="" isStreaming={true} />);
    expect(instance.lastFrame()).toContain("Reasoning");
  });
});
