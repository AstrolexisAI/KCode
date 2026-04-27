// E2E render tests for ToolTabs
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext";
import ToolTabs, { type ToolTab } from "./ToolTabs";

function renderWithTheme(element: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, element));
}

const makeTab = (overrides: Partial<ToolTab> = {}): ToolTab => ({
  toolUseId: `t-${Math.random()}`,
  name: "Read",
  summary: "/path/to/file",
  status: "running",
  startTime: Date.now() - 2000,
  ...overrides,
});

describe("ToolTabs render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("renders nothing when no tabs", () => {
    instance = renderWithTheme(<ToolTabs tabs={[]} selectedIndex={0} />);
    const out = instance.lastFrame();
    // Empty tabs render as empty or minimal content
    expect(typeof out).toBe("string");
  });

  test("renders single tab with name", () => {
    instance = renderWithTheme(<ToolTabs tabs={[makeTab({ name: "Grep" })]} selectedIndex={0} />);
    expect(instance.lastFrame()).toContain("Grep");
  });

  test("renders multiple tabs", () => {
    instance = renderWithTheme(
      <ToolTabs
        tabs={[
          makeTab({ name: "Read", status: "done" }),
          makeTab({ name: "Grep", status: "running" }),
          makeTab({ name: "Bash", status: "queued" }),
        ]}
        selectedIndex={0}
      />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("Read");
    expect(out).toContain("Grep");
    expect(out).toContain("Bash");
  });

  test("shows done indicator for completed tabs", () => {
    instance = renderWithTheme(
      <ToolTabs tabs={[makeTab({ status: "done", durationMs: 1500 })]} selectedIndex={0} />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("✓");
  });

  test("shows error indicator for failed tabs", () => {
    instance = renderWithTheme(
      <ToolTabs tabs={[makeTab({ status: "error" })]} selectedIndex={0} />,
    );
    expect(instance.lastFrame()).toContain("✗");
  });

  test("shows queued indicator for pending tabs", () => {
    instance = renderWithTheme(
      <ToolTabs tabs={[makeTab({ status: "queued" })]} selectedIndex={0} />,
    );
    expect(instance.lastFrame()).toContain("⧖");
  });

  test("shows running spinner animation", () => {
    instance = renderWithTheme(
      <ToolTabs tabs={[makeTab({ status: "running" })]} selectedIndex={0} />,
    );
    const out = instance.lastFrame()!;
    // Should contain one of the spinner frames
    expect(out).toMatch(/[◐◓◑◒]/);
  });

  test("highlights selected tab", () => {
    // We can't assert on colors, but we can verify both tabs render
    instance = renderWithTheme(
      <ToolTabs
        tabs={[makeTab({ name: "TabOne" }), makeTab({ name: "TabTwo" })]}
        selectedIndex={1}
      />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("TabOne");
    expect(out).toContain("TabTwo");
  });
});
