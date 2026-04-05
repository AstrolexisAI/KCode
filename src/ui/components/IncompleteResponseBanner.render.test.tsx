// E2E render tests for IncompleteResponseBanner
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext";
import IncompleteResponseBanner from "./IncompleteResponseBanner";

function renderWithTheme(element: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, element));
}

describe("IncompleteResponseBanner render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("shows max_tokens incomplete message", () => {
    instance = renderWithTheme(
      <IncompleteResponseBanner continuations={2} stopReason="max_tokens" />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("Response incomplete");
    expect(out).toContain("output limit");
  });

  test("shows continuations count (plural)", () => {
    instance = renderWithTheme(
      <IncompleteResponseBanner continuations={3} stopReason="max_tokens" />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("3 continuations");
  });

  test("shows continuation singular for 1", () => {
    instance = renderWithTheme(
      <IncompleteResponseBanner continuations={1} stopReason="max_tokens" />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("1 continuation");
    expect(out).not.toContain("1 continuations");
  });

  test("shows generic incomplete for other stop reasons", () => {
    instance = renderWithTheme(
      <IncompleteResponseBanner continuations={0} stopReason="error" />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("Response may be incomplete");
    expect(out).toContain("error");
  });

  test("shows stop reason for unknown reasons", () => {
    instance = renderWithTheme(
      <IncompleteResponseBanner continuations={0} stopReason="truncated" />,
    );
    expect(instance.lastFrame()).toContain("truncated");
  });

  test("surrounds message with dashes", () => {
    instance = renderWithTheme(
      <IncompleteResponseBanner continuations={0} stopReason="test" />,
    );
    const out = instance.lastFrame()!;
    expect(out).toContain("---");
  });
});
