// E2E render tests for VoiceIndicator
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext";
import VoiceIndicator from "./VoiceIndicator";

function renderWithTheme(element: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, element));
}

describe("VoiceIndicator render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("renders nothing when idle", () => {
    instance = renderWithTheme(<VoiceIndicator state="idle" level={0} partialText="" />);
    expect(instance.lastFrame()).toBe("");
  });

  test("shows Calibrating state", () => {
    instance = renderWithTheme(<VoiceIndicator state="calibrating" level={0} partialText="" />);
    expect(instance.lastFrame()).toContain("Calibrating");
  });

  test("shows Listening state with level bar", () => {
    instance = renderWithTheme(<VoiceIndicator state="listening" level={0.5} partialText="" />);
    const out = instance.lastFrame()!;
    expect(out).toContain("Listening");
    // Level bar uses block characters
    expect(out).toMatch(/[▁▂▃▄▅▆▇█]/);
  });

  test("shows Transcribing state", () => {
    instance = renderWithTheme(<VoiceIndicator state="processing" level={0} partialText="" />);
    expect(instance.lastFrame()).toContain("Transcribing");
  });

  test("shows Speaking state", () => {
    instance = renderWithTheme(<VoiceIndicator state="speaking" level={0} partialText="" />);
    expect(instance.lastFrame()).toContain("Speaking");
  });

  test("shows partial transcription text", () => {
    instance = renderWithTheme(
      <VoiceIndicator state="listening" level={0.3} partialText="Hello world this is my message" />,
    );
    expect(instance.lastFrame()).toContain("Hello world");
  });

  test("truncates long partial text with ellipsis", () => {
    const long = "a".repeat(100);
    instance = renderWithTheme(<VoiceIndicator state="listening" level={0.3} partialText={long} />);
    expect(instance.lastFrame()).toContain("...");
  });

  test("level 0 shows minimum bar", () => {
    instance = renderWithTheme(<VoiceIndicator state="listening" level={0} partialText="" />);
    const out = instance.lastFrame()!;
    expect(out).toContain("Listening");
  });

  test("level 1.0 shows full bar", () => {
    instance = renderWithTheme(<VoiceIndicator state="listening" level={1.0} partialText="" />);
    const out = instance.lastFrame()!;
    // Full bar should have taller blocks
    expect(out).toMatch(/[▆▇█]/);
  });

  test("shows state icon", () => {
    instance = renderWithTheme(<VoiceIndicator state="listening" level={0.5} partialText="" />);
    const out = instance.lastFrame()!;
    expect(out).toContain("●");
  });
});
