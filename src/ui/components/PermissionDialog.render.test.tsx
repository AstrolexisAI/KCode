// E2E render tests for PermissionDialog
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext";
import PermissionDialog from "./PermissionDialog";

function renderWithTheme(element: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, element));
}

describe("PermissionDialog render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("shows permission required header", () => {
    instance = renderWithTheme(
      <PermissionDialog
        request={{ toolName: "Bash", description: "Execute rm -rf /tmp" }}
        onChoice={() => {}}
        isActive={true}
      />,
    );
    expect(instance.lastFrame()).toContain("Permission Required");
  });

  test("shows tool name", () => {
    instance = renderWithTheme(
      <PermissionDialog
        request={{ toolName: "Write", description: "writing to file.ts" }}
        onChoice={() => {}}
        isActive={true}
      />,
    );
    expect(instance.lastFrame()).toContain("Write");
  });

  test("shows description", () => {
    instance = renderWithTheme(
      <PermissionDialog
        request={{ toolName: "Bash", description: "git push origin main" }}
        onChoice={() => {}}
        isActive={true}
      />,
    );
    expect(instance.lastFrame()).toContain("git push origin main");
  });

  test("shows all three choices", () => {
    instance = renderWithTheme(
      <PermissionDialog
        request={{ toolName: "Bash", description: "x" }}
        onChoice={() => {}}
        isActive={true}
      />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("Allow");
    expect(out).toContain("Always");
    expect(out).toContain("Deny");
  });

  test("shows key shortcuts [y] [a] [n]", () => {
    instance = renderWithTheme(
      <PermissionDialog
        request={{ toolName: "Bash", description: "x" }}
        onChoice={() => {}}
        isActive={true}
      />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("[y]");
    expect(out).toContain("[a]");
    expect(out).toContain("[n]");
  });

  test("calls onChoice('allow') on y key", async () => {
    let choice: string | null = null;
    instance = renderWithTheme(
      <PermissionDialog
        request={{ toolName: "Bash", description: "x" }}
        onChoice={(c) => {
          choice = c;
        }}
        isActive={true}
      />,
    );
    instance.stdin.write("y");
    await new Promise((r) => setTimeout(r, 50));
    expect(choice).toBe("allow");
  });

  test("calls onChoice('deny') on n key", async () => {
    let choice: string | null = null;
    instance = renderWithTheme(
      <PermissionDialog
        request={{ toolName: "Bash", description: "x" }}
        onChoice={(c) => {
          choice = c;
        }}
        isActive={true}
      />,
    );
    instance.stdin.write("n");
    await new Promise((r) => setTimeout(r, 50));
    expect(choice).toBe("deny");
  });

  test("calls onChoice('allow_always') on a key", async () => {
    let choice: string | null = null;
    instance = renderWithTheme(
      <PermissionDialog
        request={{ toolName: "Bash", description: "x" }}
        onChoice={(c) => {
          choice = c;
        }}
        isActive={true}
      />,
    );
    instance.stdin.write("a");
    await new Promise((r) => setTimeout(r, 50));
    expect(choice).toBe("allow_always");
  });

  test("ignores keys when inactive", async () => {
    let choice: string | null = null;
    instance = renderWithTheme(
      <PermissionDialog
        request={{ toolName: "Bash", description: "x" }}
        onChoice={(c) => {
          choice = c;
        }}
        isActive={false}
      />,
    );
    instance.stdin.write("y");
    await new Promise((r) => setTimeout(r, 50));
    expect(choice).toBe(null);
  });
});
