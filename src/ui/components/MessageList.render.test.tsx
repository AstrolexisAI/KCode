// E2E render tests for MessageList
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext";
import MessageList, { type MessageEntry } from "./MessageList";

function renderWithTheme(element: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, element));
}

describe("MessageList render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("renders user text message", () => {
    const entries: MessageEntry[] = [
      { kind: "text", role: "user", text: "Hello KCode" },
    ];
    instance = renderWithTheme(
      <MessageList
        completed={entries}
        streamingText=""
       
      />,
    );
    expect(instance.lastFrame()).toContain("Hello KCode");
  });

  test("renders assistant text message", () => {
    const entries: MessageEntry[] = [
      { kind: "text", role: "assistant", text: "Hi there" },
    ];
    instance = renderWithTheme(
      <MessageList completed={entries} streamingText="" />,
    );
    expect(instance.lastFrame()).toContain("Hi there");
  });

  test("renders tool_use entry with name", () => {
    const entries: MessageEntry[] = [
      { kind: "tool_use", name: "Read", summary: "/tmp/file.ts" },
    ];
    instance = renderWithTheme(
      <MessageList completed={entries} streamingText="" />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("Read");
  });

  test("renders tool_result with result content", () => {
    const entries: MessageEntry[] = [
      {
        kind: "tool_result",
        name: "Grep",
        result: "line 1 matches\nline 2 matches",
        isError: false,
      },
    ];
    instance = renderWithTheme(
      <MessageList completed={entries} streamingText="" />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("line 1 matches");
  });

  test("tool_result with error shows error indicator", () => {
    const entries: MessageEntry[] = [
      {
        kind: "tool_result",
        name: "Bash",
        result: "command not found",
        isError: true,
      },
    ];
    instance = renderWithTheme(
      <MessageList completed={entries} streamingText="" />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("command not found");
    // Error indicator — usually ✗ or "Error"
    expect(out).toMatch(/[✗✘]|[Ee]rror|failed/);
  });

  test("renders banner entry", () => {
    const entries: MessageEntry[] = [
      { kind: "banner", title: "Welcome", subtitle: "v2.6.16" },
    ];
    instance = renderWithTheme(
      <MessageList completed={entries} streamingText="" />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("Welcome");
    expect(out).toContain("v2.6.16");
  });

  test("shows streaming text while loading", () => {
    instance = renderWithTheme(
      <MessageList
        completed={[]}
        streamingText="Generating response..."
       
      />,
    );
    expect(instance.lastFrame()).toContain("Generating response");
  });

  test("does not render loading message inside the message flow", () => {
    instance = renderWithTheme(
      <MessageList
        completed={[]}
        streamingText=""
       
       
      />,
    );
    expect(instance.lastFrame()).not.toContain("Connecting");
  });

  test("renders multiple entries in order", () => {
    const entries: MessageEntry[] = [
      { kind: "text", role: "user", text: "First" },
      { kind: "text", role: "assistant", text: "Second" },
      { kind: "text", role: "user", text: "Third" },
    ];
    instance = renderWithTheme(
      <MessageList completed={entries} streamingText="" />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("First");
    expect(out).toContain("Second");
    expect(out).toContain("Third");
    const firstIdx = out.indexOf("First");
    const secondIdx = out.indexOf("Second");
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  test("empty state renders without error", () => {
    instance = renderWithTheme(
      <MessageList completed={[]} streamingText="" />,
    );
    expect(typeof instance.lastFrame()).toBe("string");
  });
});
