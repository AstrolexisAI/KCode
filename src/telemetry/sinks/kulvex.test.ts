// KCode - Kulvex Telemetry Sink Tests

import { beforeEach, describe, expect, test } from "bun:test";
import type { TelemetryEvent } from "../types";
import { KulvexSink } from "./kulvex";

function makeEvent(name: string, attrs: Record<string, unknown> = {}): TelemetryEvent {
  return {
    name,
    timestamp: new Date().toISOString(),
    traceId: "trace-123",
    spanId: "span-456",
    attributes: attrs,
    duration: 100,
  };
}

describe("KulvexSink", () => {
  let sink: KulvexSink;

  beforeEach(() => {
    sink = new KulvexSink("test-install-id");
  });

  test("has correct name", () => {
    expect(sink.name).toBe("kulvex");
  });

  test("send does not throw", async () => {
    await expect(sink.send(makeEvent("test.event"))).resolves.toBeUndefined();
  });

  test("flush with no events does not throw", async () => {
    await expect(sink.flush()).resolves.toBeUndefined();
  });

  test("shutdown does not throw", async () => {
    await sink.send(makeEvent("test.event"));
    await expect(sink.shutdown()).resolves.toBeUndefined();
  });

  test("sanitizes attributes — only safe keys pass through", async () => {
    const event = makeEvent("tool.use", {
      tool: "Read",
      model: "qwen-32b",
      duration_ms: 150,
      is_error: false,
      // These should be stripped:
      file_path: "/home/user/secret/file.ts",
      api_key: "sk-secret-key",
      prompt: "do something dangerous",
      user_input: "my password is 1234",
    });

    // Access private method via prototype for testing
    const sanitize = (sink as any).sanitizeAttributes.bind(sink);
    const result = sanitize(event.attributes);

    expect(result.tool).toBe("Read");
    expect(result.model).toBe("qwen-32b");
    expect(result.duration_ms).toBe(150);
    expect(result.is_error).toBe(false);
    // Sensitive fields must be stripped
    expect(result.file_path).toBeUndefined();
    expect(result.api_key).toBeUndefined();
    expect(result.prompt).toBeUndefined();
    expect(result.user_input).toBeUndefined();
  });

  test("sanitizes attributes — rejects complex values", async () => {
    const sanitize = (sink as any).sanitizeAttributes.bind(sink);
    const result = sanitize({
      tool: "Bash",
      nested_object: { key: "value" },
      array_value: [1, 2, 3],
    });

    expect(result.tool).toBe("Bash");
    expect(result.nested_object).toBeUndefined();
    expect(result.array_value).toBeUndefined();
  });
});
