// E2E render tests for SudoPasswordPrompt
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext";
import SudoPasswordPrompt from "./SudoPasswordPrompt";

function renderWithTheme(element: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, element));
}

describe("SudoPasswordPrompt render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("shows password required header", () => {
    instance = renderWithTheme(
      <SudoPasswordPrompt onSubmit={() => {}} isActive={true} />,
    );
    expect(instance.lastFrame()).toContain("Sudo Password Required");
  });

  test("shows lock emoji", () => {
    instance = renderWithTheme(
      <SudoPasswordPrompt onSubmit={() => {}} isActive={true} />,
    );
    expect(instance.lastFrame()).toContain("🔒");
  });

  test("shows explanation text", () => {
    instance = renderWithTheme(
      <SudoPasswordPrompt onSubmit={() => {}} isActive={true} />,
    );
    expect(instance.lastFrame()).toContain("elevated privileges");
  });

  test("shows input cursor initially with no dots", () => {
    instance = renderWithTheme(
      <SudoPasswordPrompt onSubmit={() => {}} isActive={true} />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("Password:");
    expect(out).not.toContain("•");
  });

  test("shows Submit and Cancel hints", () => {
    instance = renderWithTheme(
      <SudoPasswordPrompt onSubmit={() => {}} isActive={true} />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("Submit");
    expect(out).toContain("Cancel");
  });

  test("masks typed characters with dots", async () => {
    instance = renderWithTheme(
      <SudoPasswordPrompt onSubmit={() => {}} isActive={true} />,
    );
    instance.stdin.write("secret");
    await new Promise((r) => setTimeout(r, 100));
    const out = instance.lastFrame()!;
    // 6 dots for "secret"
    expect(out).toContain("••••••");
  });

  test("backspace removes characters", async () => {
    instance = renderWithTheme(
      <SudoPasswordPrompt onSubmit={() => {}} isActive={true} />,
    );
    instance.stdin.write("abcde");
    await new Promise((r) => setTimeout(r, 50));
    instance.stdin.write("\x7f"); // backspace
    instance.stdin.write("\x7f");
    await new Promise((r) => setTimeout(r, 50));
    const out = instance.lastFrame()!;
    expect(out).toContain("•••");
    expect(out).not.toContain("••••");
  });

  test("Enter submits password", async () => {
    let received: string | null = "never";
    instance = renderWithTheme(
      <SudoPasswordPrompt
        onSubmit={(pw) => {
          received = pw;
        }}
        isActive={true}
      />,
    );
    instance.stdin.write("mypassword");
    await new Promise((r) => setTimeout(r, 50));
    instance.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toBe("mypassword");
  });

  test("Esc calls onSubmit(null)", async () => {
    let received = "initial" as string | null;
    instance = renderWithTheme(
      <SudoPasswordPrompt
        onSubmit={(pw) => {
          received = pw;
        }}
        isActive={true}
      />,
    );
    instance.stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toBe(null);
  });

  test("Enter on empty password does nothing", async () => {
    let called = false;
    instance = renderWithTheme(
      <SudoPasswordPrompt
        onSubmit={() => {
          called = true;
        }}
        isActive={true}
      />,
    );
    instance.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(called).toBe(false);
  });

  test("ignores input when inactive", async () => {
    instance = renderWithTheme(
      <SudoPasswordPrompt onSubmit={() => {}} isActive={false} />,
    );
    instance.stdin.write("abc");
    await new Promise((r) => setTimeout(r, 50));
    const out = instance.lastFrame()!;
    expect(out).not.toContain("•");
  });
});
