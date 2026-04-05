// Tests for SendMessage tool — agent status messages
import { describe, expect, test } from "bun:test";
import { executeSendMessage, sendMessageDefinition } from "./send-message";

describe("sendMessageDefinition", () => {
  test("has correct name and required params", () => {
    expect(sendMessageDefinition.name).toBe("SendMessage");
    expect(sendMessageDefinition.input_schema.required).toContain("message");
  });
});

describe("executeSendMessage", () => {
  test("rejects empty message", async () => {
    const result = await executeSendMessage({ message: "" });
    expect(result.is_error).toBe(true);
  });

  test("rejects whitespace-only message", async () => {
    const result = await executeSendMessage({ message: "   " });
    expect(result.is_error).toBe(true);
  });

  test("formats info message by default", async () => {
    const result = await executeSendMessage({ message: "progress update" });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toBe("[INFO] progress update");
  });

  test("formats warning level", async () => {
    const result = await executeSendMessage({ message: "careful", level: "warning" });
    expect(result.content).toBe("[WARNING] careful");
  });

  test("formats error level", async () => {
    const result = await executeSendMessage({ message: "fail", level: "error" });
    expect(result.content).toBe("[ERROR] fail");
  });

  test("unknown level falls back to info", async () => {
    const result = await executeSendMessage({ message: "x", level: "unknown" });
    expect(result.content).toContain("[INFO]");
  });
});
