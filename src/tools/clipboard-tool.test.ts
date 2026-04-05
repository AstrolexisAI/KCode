// Tests for Clipboard tool — input validation (clipboard cmd not mocked here)
import { describe, expect, test } from "bun:test";
import { clipboardDefinition, executeClipboard } from "./clipboard-tool";

describe("clipboardDefinition", () => {
  test("has correct name and required params", () => {
    expect(clipboardDefinition.name).toBe("Clipboard");
    expect(clipboardDefinition.input_schema.required).toContain("text");
  });
});

describe("executeClipboard", () => {
  test("rejects empty text", async () => {
    const result = await executeClipboard({ text: "" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("text is required");
  });

  test("handles missing text field", async () => {
    const result = await executeClipboard({});
    expect(result.is_error).toBe(true);
  });

  // The following tests depend on clipboard command availability.
  // On systems without xclip/xsel/wl-copy, they validate the error path.
  test("returns actionable message when no clipboard command found", async () => {
    // This test passes either way:
    // - If clipboard is available: copies and succeeds
    // - If not: returns "install xclip/xsel/wl-copy" message
    const result = await executeClipboard({ text: "test content" });
    // Must return a string content, either success or one of the known errors
    expect(typeof result.content).toBe("string");
    if (result.is_error) {
      expect(result.content).toMatch(/clipboard/i);
    } else {
      expect(result.content).toContain("Copied");
      expect(result.content).toContain("12 chars");
    }
  });
});
