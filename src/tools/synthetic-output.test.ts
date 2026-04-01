import { describe, test, expect } from "bun:test";
import { executeSyntheticOutput } from "./synthetic-output";

describe("SyntheticOutput", () => {
  test("returns content as-is for text type", async () => {
    const result = await executeSyntheticOutput({ content: "Hello world" });
    expect(result.content).toBe("Hello world");
    expect(result.is_error).toBeUndefined();
  });

  test("defaults to text type and visible", async () => {
    const result = await executeSyntheticOutput({ content: "test" });
    expect(result.content).toBe("test");
  });

  test("validates JSON content when type is json", async () => {
    const result = await executeSyntheticOutput({
      content: '{"key": "value"}',
      type: "json",
    });
    expect(result.content).toBe('{"key": "value"}');
    expect(result.is_error).toBeUndefined();
  });

  test("rejects invalid JSON when type is json", async () => {
    const result = await executeSyntheticOutput({
      content: "not json",
      type: "json",
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not valid JSON");
  });

  test("returns error result for error type", async () => {
    const result = await executeSyntheticOutput({
      content: "Something went wrong",
      type: "error",
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toBe("Something went wrong");
  });

  test("marks hidden content with prefix when visible is false", async () => {
    const result = await executeSyntheticOutput({
      content: "internal context",
      visible: false,
    });
    expect(result.content).toContain("[synthetic:hidden]");
    expect(result.content).toContain("internal context");
  });

  test("visible true shows content without prefix", async () => {
    const result = await executeSyntheticOutput({
      content: "user-visible text",
      visible: true,
    });
    expect(result.content).toBe("user-visible text");
    expect(result.content).not.toContain("[synthetic:hidden]");
  });

  test("markdown type returns content directly", async () => {
    const result = await executeSyntheticOutput({
      content: "# Heading\n\nParagraph",
      type: "markdown",
    });
    expect(result.content).toBe("# Heading\n\nParagraph");
    expect(result.is_error).toBeUndefined();
  });

  test("handles empty content", async () => {
    const result = await executeSyntheticOutput({ content: "" });
    expect(result.content).toBe("");
  });
});
