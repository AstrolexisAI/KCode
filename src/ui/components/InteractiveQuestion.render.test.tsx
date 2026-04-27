// E2E render tests for InteractiveQuestion
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext";
import InteractiveQuestion from "./InteractiveQuestion";

function renderWithTheme(element: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, element));
}

describe("InteractiveQuestion render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("shows question", () => {
    instance = renderWithTheme(
      <InteractiveQuestion
        question="Which model?"
        options={["opus", "sonnet"]}
        onSelect={() => {}}
        onCancel={() => {}}
        isActive={true}
      />,
    );
    expect(instance.lastFrame()).toContain("Which model?");
  });

  test("renders all options", () => {
    instance = renderWithTheme(
      <InteractiveQuestion
        question="Q"
        options={["Option A", "Option B", "Option C"]}
        onSelect={() => {}}
        onCancel={() => {}}
        isActive={true}
      />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("Option A");
    expect(out).toContain("Option B");
    expect(out).toContain("Option C");
  });

  test("numbers options 1-N", () => {
    instance = renderWithTheme(
      <InteractiveQuestion
        question="Q"
        options={["X", "Y", "Z"]}
        onSelect={() => {}}
        onCancel={() => {}}
        isActive={true}
      />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("1.");
    expect(out).toContain("2.");
    expect(out).toContain("3.");
  });

  test("marks first option as selected by default", () => {
    instance = renderWithTheme(
      <InteractiveQuestion
        question="Q"
        options={["first", "second"]}
        onSelect={() => {}}
        onCancel={() => {}}
        isActive={true}
      />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("▸");
  });

  test("shows help hint", () => {
    instance = renderWithTheme(
      <InteractiveQuestion
        question="Q"
        options={["a", "b"]}
        onSelect={() => {}}
        onCancel={() => {}}
        isActive={true}
      />,
    );
    expect(instance.lastFrame()).toContain("Enter");
    expect(instance.lastFrame()).toContain("Esc");
  });

  test("number key selects directly", async () => {
    let selected = null as string | null;
    instance = renderWithTheme(
      <InteractiveQuestion
        question="Q"
        options={["one", "two", "three"]}
        onSelect={(s) => {
          selected = s;
        }}
        onCancel={() => {}}
        isActive={true}
      />,
    );
    instance.stdin.write("2");
    await new Promise((r) => setTimeout(r, 50));
    expect(selected).toBe("two");
  });

  test("Enter selects current option", async () => {
    let selected = null as string | null;
    instance = renderWithTheme(
      <InteractiveQuestion
        question="Q"
        options={["alpha", "beta"]}
        onSelect={(s) => {
          selected = s;
        }}
        onCancel={() => {}}
        isActive={true}
      />,
    );
    instance.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(selected).toBe("alpha"); // first by default
  });

  test("Esc calls onCancel", async () => {
    let cancelled = false;
    instance = renderWithTheme(
      <InteractiveQuestion
        question="Q"
        options={["a"]}
        onSelect={() => {}}
        onCancel={() => {
          cancelled = true;
        }}
        isActive={true}
      />,
    );
    instance.stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 50));
    expect(cancelled).toBe(true);
  });

  test("arrow down changes selection", async () => {
    let selected = null as string | null;
    instance = renderWithTheme(
      <InteractiveQuestion
        question="Q"
        options={["first", "second"]}
        onSelect={(s) => {
          selected = s;
        }}
        onCancel={() => {}}
        isActive={true}
      />,
    );
    // Arrow down then Enter
    instance.stdin.write("\x1b[B"); // down arrow
    await new Promise((r) => setTimeout(r, 50));
    instance.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(selected).toBe("second");
  });

  test("j/k vim keys navigate", async () => {
    let selected = null as string | null;
    instance = renderWithTheme(
      <InteractiveQuestion
        question="Q"
        options={["first", "second"]}
        onSelect={(s) => {
          selected = s;
        }}
        onCancel={() => {}}
        isActive={true}
      />,
    );
    instance.stdin.write("j"); // vim down
    await new Promise((r) => setTimeout(r, 50));
    instance.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(selected).toBe("second");
  });
});
