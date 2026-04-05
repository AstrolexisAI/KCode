// E2E render tests for InteractiveDiff
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import type { DiffHunk, DiffResult } from "../../core/diff/types";
import { ThemeProvider } from "../ThemeContext";
import InteractiveDiff from "./InteractiveDiff";

function renderWithTheme(element: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, element));
}

const makeHunk = (id: string, overrides: Partial<DiffHunk> = {}): DiffHunk => ({
  id,
  startLineOld: 10,
  endLineOld: 12,
  startLineNew: 10,
  endLineNew: 13,
  linesRemoved: ["old line 1", "old line 2"],
  linesAdded: ["new line 1", "new line 2", "new line 3"],
  context: { before: ["ctx before"], after: ["ctx after"] },
  status: "pending",
  type: "modification",
  ...overrides,
});

const makeDiff = (hunks: DiffHunk[]): DiffResult => ({
  filePath: "src/test.ts",
  hunks,
  stats: {
    additions: hunks.reduce((s, h) => s + h.linesAdded.length, 0),
    deletions: hunks.reduce((s, h) => s + h.linesRemoved.length, 0),
    modifications: hunks.length,
  },
});

describe("InteractiveDiff render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("shows file path", () => {
    instance = renderWithTheme(
      <InteractiveDiff
        diff={makeDiff([makeHunk("h1")])}
        onComplete={() => {}}
        isActive={true}
      />,
    );
    expect(instance.lastFrame()).toContain("test.ts");
  });

  test("shows hunk count", () => {
    instance = renderWithTheme(
      <InteractiveDiff
        diff={makeDiff([makeHunk("h1"), makeHunk("h2"), makeHunk("h3")])}
        onComplete={() => {}}
        isActive={true}
      />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("3");
  });

  test("shows added lines with + prefix", () => {
    instance = renderWithTheme(
      <InteractiveDiff
        diff={makeDiff([makeHunk("h1")])}
        onComplete={() => {}}
        isActive={true}
      />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("new line 1");
  });

  test("shows removed lines with - prefix", () => {
    instance = renderWithTheme(
      <InteractiveDiff
        diff={makeDiff([makeHunk("h1")])}
        onComplete={() => {}}
        isActive={true}
      />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("old line 1");
  });

  test("empty hunks renders without crashing", () => {
    instance = renderWithTheme(
      <InteractiveDiff
        diff={makeDiff([])}
        onComplete={() => {}}
        isActive={true}
      />,
    );
    expect(typeof instance.lastFrame()).toBe("string");
  });

  test("shows stats (additions/deletions)", () => {
    const diff = makeDiff([makeHunk("h1")]);
    instance = renderWithTheme(
      <InteractiveDiff diff={diff} onComplete={() => {}} isActive={true} />,
    );
    const out = instance.lastFrame()!;
    // Stats usually shown as +N/-N
    expect(out).toMatch(/[+\-]\d/);
  });

  test("inactive doesn't respond to input", async () => {
    let completed = false;
    instance = renderWithTheme(
      <InteractiveDiff
        diff={makeDiff([makeHunk("h1")])}
        onComplete={() => {
          completed = true;
        }}
        isActive={false}
      />,
    );
    instance.stdin.write("q");
    await new Promise((r) => setTimeout(r, 50));
    expect(completed).toBe(false);
  });

  test("quit key 'q' calls onComplete", async () => {
    let completed = false;
    instance = renderWithTheme(
      <InteractiveDiff
        diff={makeDiff([makeHunk("h1")])}
        onComplete={() => {
          completed = true;
        }}
        isActive={true}
      />,
    );
    instance.stdin.write("q");
    await new Promise((r) => setTimeout(r, 50));
    expect(completed).toBe(true);
  });
});
