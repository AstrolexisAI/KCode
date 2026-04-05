// E2E render tests for Header — bottom status bar
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext";
import Header from "./Header";

function renderWithTheme(element: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, element));
}

describe("Header render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("shows model name", () => {
    instance = renderWithTheme(
      <Header
        model="claude-opus-4-6"
        workingDirectory="/home/user/project"
        tokenCount={0}
        toolUseCount={0}
      />,
    );
    expect(instance.lastFrame()).toContain("claude-opus-4-6");
  });

  test("shows token count", () => {
    instance = renderWithTheme(
      <Header model="m" workingDirectory="/x" tokenCount={42000} toolUseCount={5} />,
    );
    const out = instance.lastFrame()!;
    expect(out).toMatch(/42[,\s]?000|42K/i);
  });

  test("shows tool count", () => {
    instance = renderWithTheme(
      <Header model="m" workingDirectory="/x" tokenCount={0} toolUseCount={12} />,
    );
    expect(instance.lastFrame()).toContain("12");
  });

  test("shows working directory (shortened)", () => {
    instance = renderWithTheme(
      <Header
        model="m"
        workingDirectory="/home/user/KCode"
        tokenCount={0}
        toolUseCount={0}
      />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("KCode");
  });

  test("shows session name when provided", () => {
    instance = renderWithTheme(
      <Header
        model="m"
        workingDirectory="/x"
        tokenCount={0}
        toolUseCount={0}
        sessionName="my-session"
      />,
    );
    expect(instance.lastFrame()).toContain("my-session");
  });

  test("shows permission mode when provided", () => {
    instance = renderWithTheme(
      <Header
        model="m"
        workingDirectory="/x"
        tokenCount={0}
        toolUseCount={0}
        permissionMode="auto"
      />,
    );
    expect(instance.lastFrame()).toContain("auto");
  });

  test("shows running agents count when > 0", () => {
    instance = renderWithTheme(
      <Header
        model="m"
        workingDirectory="/x"
        tokenCount={0}
        toolUseCount={0}
        runningAgents={3}
      />,
    );
    expect(instance.lastFrame()).toContain("3");
  });

  test("shows context bar when contextWindowSize provided", () => {
    instance = renderWithTheme(
      <Header
        model="m"
        workingDirectory="/x"
        tokenCount={50_000}
        toolUseCount={0}
        contextWindowSize={100_000}
      />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("50%");
  });
});
