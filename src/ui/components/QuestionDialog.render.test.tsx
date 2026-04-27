// E2E render tests for QuestionDialog
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext";
import QuestionDialog from "./QuestionDialog";

function renderWithTheme(element: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, element));
}

describe("QuestionDialog render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("shows title with ? marker", () => {
    instance = renderWithTheme(
      <QuestionDialog
        title="Resume session?"
        message="A previous session exists"
        onChoice={() => {}}
        isActive={true}
      />,
    );
    expect(instance.lastFrame()).toContain("Resume session?");
  });

  test("shows message", () => {
    instance = renderWithTheme(
      <QuestionDialog
        title="t"
        message="Do you want to continue?"
        onChoice={() => {}}
        isActive={true}
      />,
    );
    expect(instance.lastFrame()).toContain("Do you want to continue");
  });

  test("shows optional detail", () => {
    instance = renderWithTheme(
      <QuestionDialog
        title="t"
        message="m"
        detail="Last message: 2 hours ago"
        onChoice={() => {}}
        isActive={true}
      />,
    );
    expect(instance.lastFrame()).toContain("2 hours ago");
  });

  test("defaults to Yes/No options", () => {
    instance = renderWithTheme(
      <QuestionDialog title="t" message="m" onChoice={() => {}} isActive={true} />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("Yes");
    expect(out).toContain("No");
    expect(out).toContain("[y]");
    expect(out).toContain("[n]");
  });

  test("uses custom options when provided", () => {
    instance = renderWithTheme(
      <QuestionDialog
        title="t"
        message="m"
        options={[
          { key: "1", label: "Opus" },
          { key: "2", label: "Sonnet" },
          { key: "3", label: "Haiku" },
        ]}
        onChoice={() => {}}
        isActive={true}
      />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("Opus");
    expect(out).toContain("Sonnet");
    expect(out).toContain("Haiku");
  });

  test("y key calls onChoice('y')", async () => {
    let choice = null as string | null;
    instance = renderWithTheme(
      <QuestionDialog
        title="t"
        message="m"
        onChoice={(k) => {
          choice = k;
        }}
        isActive={true}
      />,
    );
    instance.stdin.write("y");
    await new Promise((r) => setTimeout(r, 50));
    expect(choice).toBe("y");
  });

  test("Enter defaults to first option", async () => {
    let choice = null as string | null;
    instance = renderWithTheme(
      <QuestionDialog
        title="t"
        message="m"
        options={[
          { key: "a", label: "Accept" },
          { key: "r", label: "Reject" },
        ]}
        onChoice={(k) => {
          choice = k;
        }}
        isActive={true}
      />,
    );
    instance.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(choice).toBe("a");
  });

  test("Escape defaults to last option", async () => {
    let choice = null as string | null;
    instance = renderWithTheme(
      <QuestionDialog
        title="t"
        message="m"
        onChoice={(k) => {
          choice = k;
        }}
        isActive={true}
      />,
    );
    instance.stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 50));
    expect(choice).toBe("n");
  });

  test("ignores input when inactive", async () => {
    let choice = null as string | null;
    instance = renderWithTheme(
      <QuestionDialog
        title="t"
        message="m"
        onChoice={(k) => {
          choice = k;
        }}
        isActive={false}
      />,
    );
    instance.stdin.write("y");
    await new Promise((r) => setTimeout(r, 50));
    expect(choice).toBe(null);
  });
});
