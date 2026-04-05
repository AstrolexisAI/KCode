// Tests for paste-handler — global callback registry
import { afterEach, describe, expect, test } from "bun:test";
import { invokePasteHandler, setPasteHandler } from "./paste-handler";

afterEach(() => {
  setPasteHandler(null);
});

describe("paste-handler", () => {
  test("invokePasteHandler is a no-op when no handler set", () => {
    // Should not throw
    expect(() => invokePasteHandler("test")).not.toThrow();
  });

  test("setPasteHandler registers callback", () => {
    let received: string | null = null;
    setPasteHandler((text) => {
      received = text;
    });
    invokePasteHandler("hello world");
    expect(received).toBe("hello world");
  });

  test("setPasteHandler(null) unregisters callback", () => {
    let callCount = 0;
    setPasteHandler(() => {
      callCount++;
    });
    invokePasteHandler("one");
    expect(callCount).toBe(1);

    setPasteHandler(null);
    invokePasteHandler("two");
    expect(callCount).toBe(1); // not called again
  });

  test("replaces previous handler when set twice", () => {
    const calls: string[] = [];
    setPasteHandler((text) => {
      calls.push(`first:${text}`);
    });
    setPasteHandler((text) => {
      calls.push(`second:${text}`);
    });
    invokePasteHandler("x");
    expect(calls).toEqual(["second:x"]);
  });

  test("handler receives multiline pastes intact", () => {
    let received: string | null = null;
    setPasteHandler((text) => {
      received = text;
    });
    const multiline = "line1\nline2\nline3";
    invokePasteHandler(multiline);
    expect(received).toBe(multiline);
  });
});
