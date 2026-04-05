// E2E render tests for Kodi companion panel
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext";
import KodiCompanion from "./Kodi";

function renderWithTheme(element: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, element));
}

const baseProps = {
  mode: "input",
  toolUseCount: 0,
  tokenCount: 0,
  activeToolName: null,
  isThinking: false,
  runningAgents: 0,
  sessionElapsedMs: 0,
  lastEvent: null,
  model: "claude-opus-4-6",
  version: "2.6.16",
  workingDirectory: "/home/user/proj",
};

describe("Kodi render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("renders brand and version", () => {
    instance = renderWithTheme(<KodiCompanion {...baseProps} />);
    const out = instance.lastFrame()!;
    expect(out).toContain("KCode");
    expect(out).toContain("2.6.16");
    expect(out).toContain("Kulvex Code");
  });

  test("shows model name", () => {
    instance = renderWithTheme(<KodiCompanion {...baseProps} />);
    expect(instance.lastFrame()).toContain("claude-opus-4-6");
  });

  test("shows working directory (shortened)", () => {
    instance = renderWithTheme(<KodiCompanion {...baseProps} />);
    const out = instance.lastFrame()!;
    expect(out).toContain("proj");
  });

  test("shows tokens and tool count when > 0", () => {
    instance = renderWithTheme(
      <KodiCompanion {...baseProps} tokenCount={1234} toolUseCount={5} />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("1,234");
    expect(out).toContain("tools:5");
  });

  test("shows agent count when agents running", () => {
    instance = renderWithTheme(
      <KodiCompanion {...baseProps} runningAgents={2} />,
    );
    expect(instance.lastFrame()).toContain("agents:2");
  });

  test("shows permission mode", () => {
    instance = renderWithTheme(
      <KodiCompanion {...baseProps} permissionMode="auto" />,
    );
    expect(instance.lastFrame()).toContain("auto");
  });

  test("shows context bar when contextWindowSize set", () => {
    instance = renderWithTheme(
      <KodiCompanion
        {...baseProps}
        tokenCount={50_000}
        contextWindowSize={200_000}
      />,
    );
    expect(instance.lastFrame()).toContain("25%");
  });

  test("shows 5h usage bar when subscriptionUsage5h provided", () => {
    instance = renderWithTheme(
      <KodiCompanion {...baseProps} subscriptionUsage5h={0.45} />,
    );
    expect(instance.lastFrame()).toContain("5h:");
    expect(instance.lastFrame()).toContain("45%");
  });

  test("shows session name when provided", () => {
    instance = renderWithTheme(
      <KodiCompanion {...baseProps} sessionName="debugging" />,
    );
    expect(instance.lastFrame()).toContain("debugging");
  });

  test("renders Kodi sprite", () => {
    instance = renderWithTheme(<KodiCompanion {...baseProps} />);
    const out = instance.lastFrame()!;
    // Sprite contains ASCII art — should have the box drawing chars
    expect(out).toMatch(/[│─╭╮╰╯]/);
  });

  test("shows active profile when provided", () => {
    instance = renderWithTheme(
      <KodiCompanion {...baseProps} activeProfile="secure" />,
    );
    expect(instance.lastFrame()).toContain("secure");
  });

  test("renders agent statuses from lastEvent", () => {
    instance = renderWithTheme(
      <KodiCompanion
        {...baseProps}
        lastEvent={{
          type: "agent_progress",
          agentStatuses: [
            { name: "fix-auth", stepTitle: "Fix auth module", status: "running" },
            { name: "add-tests", stepTitle: "Add test coverage", status: "done", durationMs: 12000 },
          ],
        }}
      />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("Agents");
    expect(out).toContain("fix-auth");
    expect(out).toContain("Fix auth module");
    expect(out).toContain("add-tests");
  });
});
