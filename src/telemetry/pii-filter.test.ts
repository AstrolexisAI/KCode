import { describe, expect, test } from "bun:test";
import { filterPII } from "./pii-filter";
import type { TelemetryEvent } from "./types";

function makeEvent(attributes: Record<string, unknown> = {}): TelemetryEvent {
  return {
    name: "kcode.test.event",
    timestamp: new Date().toISOString(),
    traceId: "abc123",
    spanId: "def456",
    attributes,
  };
}

describe("pii-filter", () => {
  // ─── Path hashing ───

  test("hashes file_path to 12-char SHA256 prefix", () => {
    const event = makeEvent({ file_path: "/home/user/secret/project/main.ts" });
    const filtered = filterPII(event);

    expect(filtered.attributes.file_path).toBeUndefined();
    expect(filtered.attributes.file_path_hash).toBeDefined();
    expect(typeof filtered.attributes.file_path_hash).toBe("string");
    expect((filtered.attributes.file_path_hash as string).length).toBe(12);
  });

  test("hashes path field", () => {
    const event = makeEvent({ path: "/etc/passwd" });
    const filtered = filterPII(event);

    expect(filtered.attributes.path).toBeUndefined();
    expect(filtered.attributes.path_hash).toBeDefined();
    expect((filtered.attributes.path_hash as string).length).toBe(12);
  });

  test("hashes cwd field", () => {
    const event = makeEvent({ cwd: "/home/user/project" });
    const filtered = filterPII(event);

    expect(filtered.attributes.cwd).toBeUndefined();
    expect(filtered.attributes.cwd_hash).toBeDefined();
    expect((filtered.attributes.cwd_hash as string).length).toBe(12);
  });

  test("same path always produces the same hash", () => {
    const path = "/home/user/consistent/path.ts";
    const e1 = filterPII(makeEvent({ file_path: path }));
    const e2 = filterPII(makeEvent({ file_path: path }));

    expect(e1.attributes.file_path_hash).toBe(e2.attributes.file_path_hash);
  });

  test("different paths produce different hashes", () => {
    const e1 = filterPII(makeEvent({ file_path: "/a/b/c.ts" }));
    const e2 = filterPII(makeEvent({ file_path: "/x/y/z.ts" }));

    expect(e1.attributes.file_path_hash).not.toBe(e2.attributes.file_path_hash);
  });

  // ─── Sensitive field stripping ───

  test("removes content field", () => {
    const event = makeEvent({ content: "super secret file contents" });
    const filtered = filterPII(event);
    expect(filtered.attributes.content).toBeUndefined();
  });

  test("removes user_input field", () => {
    const event = makeEvent({ user_input: "fix the bug in auth.ts" });
    const filtered = filterPII(event);
    expect(filtered.attributes.user_input).toBeUndefined();
  });

  test("removes assistant_output field", () => {
    const event = makeEvent({ assistant_output: "I will edit the file..." });
    const filtered = filterPII(event);
    expect(filtered.attributes.assistant_output).toBeUndefined();
  });

  test("removes api_key field", () => {
    const event = makeEvent({ api_key: "sk-12345" });
    const filtered = filterPII(event);
    expect(filtered.attributes.api_key).toBeUndefined();
  });

  test("removes token field", () => {
    const event = makeEvent({ token: "bearer-xyz" });
    const filtered = filterPII(event);
    expect(filtered.attributes.token).toBeUndefined();
  });

  test("removes password field", () => {
    const event = makeEvent({ password: "hunter2" });
    const filtered = filterPII(event);
    expect(filtered.attributes.password).toBeUndefined();
  });

  // ─── Error message truncation ───

  test("truncates error_message to 100 chars", () => {
    const longMsg = "A".repeat(200);
    const event = makeEvent({ error_message: longMsg });
    const filtered = filterPII(event);

    expect((filtered.attributes.error_message as string).length).toBe(100);
  });

  test("does not truncate short error messages", () => {
    const msg = "Something went wrong";
    const event = makeEvent({ error_message: msg });
    const filtered = filterPII(event);

    expect(filtered.attributes.error_message).toBe(msg);
  });

  // ─── Preserves safe fields ───

  test("preserves tool_name, model, duration, cost fields", () => {
    const event = makeEvent({
      tool_name: "Bash",
      model: "llama-3.1-70b",
      duration_ms: 1234,
      cost_usd: 0.005,
      input_tokens: 500,
      output_tokens: 200,
    });
    const filtered = filterPII(event);

    expect(filtered.attributes.tool_name).toBe("Bash");
    expect(filtered.attributes.model).toBe("llama-3.1-70b");
    expect(filtered.attributes.duration_ms).toBe(1234);
    expect(filtered.attributes.cost_usd).toBe(0.005);
    expect(filtered.attributes.input_tokens).toBe(500);
    expect(filtered.attributes.output_tokens).toBe(200);
  });

  // ─── Immutability ───

  test("does not mutate the original event", () => {
    const original = makeEvent({
      file_path: "/home/user/file.ts",
      content: "secret",
      tool_name: "Read",
    });
    const originalAttrs = { ...original.attributes };
    filterPII(original);

    expect(original.attributes.file_path).toBe(originalAttrs.file_path);
    expect(original.attributes.content).toBe(originalAttrs.content);
  });

  // ─── Combined filtering ───

  test("handles event with multiple sensitive fields at once", () => {
    const event = makeEvent({
      file_path: "/home/user/file.ts",
      content: "file contents",
      user_input: "prompt text",
      api_key: "sk-key",
      error_message: "x".repeat(150),
      tool_name: "Edit",
      model: "gpt-4",
    });
    const filtered = filterPII(event);

    expect(filtered.attributes.file_path).toBeUndefined();
    expect(filtered.attributes.file_path_hash).toBeDefined();
    expect(filtered.attributes.content).toBeUndefined();
    expect(filtered.attributes.user_input).toBeUndefined();
    expect(filtered.attributes.api_key).toBeUndefined();
    expect((filtered.attributes.error_message as string).length).toBe(100);
    expect(filtered.attributes.tool_name).toBe("Edit");
    expect(filtered.attributes.model).toBe("gpt-4");
  });

  test("handles event with no sensitive fields", () => {
    const event = makeEvent({ tool_name: "Grep", success: true });
    const filtered = filterPII(event);

    expect(filtered.attributes.tool_name).toBe("Grep");
    expect(filtered.attributes.success).toBe(true);
  });

  test("handles event with empty attributes", () => {
    const event = makeEvent({});
    const filtered = filterPII(event);
    expect(Object.keys(filtered.attributes).length).toBe(0);
  });

  test("ignores non-string path fields", () => {
    const event = makeEvent({ file_path: 42, path: null });
    const filtered = filterPII(event);
    // Non-string paths are left as-is (not hashed, not removed)
    expect(filtered.attributes.file_path).toBe(42);
  });
});
