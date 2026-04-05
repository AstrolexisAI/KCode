// E2E render tests for DiffViewer component
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext";
import DiffViewer from "./DiffViewer";

function renderWithTheme(element: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, element));
}

const SAMPLE_DIFF = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;`;

describe("DiffViewer render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("renders single diff", () => {
    instance = renderWithTheme(<DiffViewer diffs={[SAMPLE_DIFF]} isActive={true} />);
    const out = instance.lastFrame()!;
    expect(out).toContain("file.ts");
  });

  test("shows diff header lines", () => {
    instance = renderWithTheme(<DiffViewer diffs={[SAMPLE_DIFF]} isActive={true} />);
    const out = instance.lastFrame()!;
    expect(out).toContain("@@");
  });

  test("shows added lines", () => {
    instance = renderWithTheme(<DiffViewer diffs={[SAMPLE_DIFF]} isActive={true} />);
    const out = instance.lastFrame()!;
    expect(out).toContain("+const y = 3;");
  });

  test("shows removed lines", () => {
    instance = renderWithTheme(<DiffViewer diffs={[SAMPLE_DIFF]} isActive={true} />);
    const out = instance.lastFrame()!;
    expect(out).toContain("-const y = 2;");
  });

  test("empty diffs array renders without crashing", () => {
    instance = renderWithTheme(<DiffViewer diffs={[]} isActive={true} />);
    expect(typeof instance.lastFrame()).toBe("string");
  });

  test("Esc key calls onClose", async () => {
    let closed = false;
    instance = renderWithTheme(
      <DiffViewer
        diffs={[SAMPLE_DIFF]}
        isActive={true}
        onClose={() => {
          closed = true;
        }}
      />,
    );
    instance.stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(true);
  });

  test("inactive doesn't respond to input", async () => {
    let closed = false;
    instance = renderWithTheme(
      <DiffViewer
        diffs={[SAMPLE_DIFF]}
        isActive={false}
        onClose={() => {
          closed = true;
        }}
      />,
    );
    instance.stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(false);
  });

  test("multiple diffs render with nav", () => {
    instance = renderWithTheme(
      <DiffViewer diffs={[SAMPLE_DIFF, SAMPLE_DIFF, SAMPLE_DIFF]} isActive={true} />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("file.ts");
  });
});
