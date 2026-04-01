import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { sanitizeMcpInput, validateStdioCommand } from "./mcp-client.ts";

// ─── sanitizeMcpInput ──────────────────────────────────────────

describe("sanitizeMcpInput", () => {
  // Basic passthrough
  test("passes through simple object", () => {
    const input = { name: "test", value: 42 };
    expect(sanitizeMcpInput(input)).toEqual({ name: "test", value: 42 });
  });

  test("passes through empty object", () => {
    expect(sanitizeMcpInput({})).toEqual({});
  });

  test("passes through boolean and null values", () => {
    const input = { flag: true, nothing: null };
    expect(sanitizeMcpInput(input)).toEqual({ flag: true, nothing: null });
  });

  // Prototype pollution protection
  test("strips __proto__ key", () => {
    const input = Object.assign(Object.create(null), { __proto__: { admin: true }, safe: "value" });
    const result = sanitizeMcpInput(input);
    // __proto__ not in own keys after stripping
    expect(Object.keys(result)).not.toContain("__proto__");
    expect(result).toHaveProperty("safe");
  });

  test("strips constructor key", () => {
    const input = Object.assign(Object.create(null), { constructor: "evil", safe: "ok" });
    const result = sanitizeMcpInput(input);
    expect(Object.keys(result)).not.toContain("constructor");
    expect(result).toHaveProperty("safe", "ok");
  });

  test("strips prototype key", () => {
    const input = { prototype: {}, safe: "ok" };
    const result = sanitizeMcpInput(input as any);
    expect(result).not.toHaveProperty("prototype");
  });

  // Depth limiting
  test("rejects input exceeding max depth (20)", () => {
    let obj: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 22; i++) {
      obj = { nested: obj };
    }
    const result = sanitizeMcpInput(obj);
    // Traverse to depth 21 where the _error should appear
    let current: any = result;
    for (let i = 0; i < 21; i++) {
      current = current.nested;
    }
    expect(current).toHaveProperty("_error");
    expect(current._error).toContain("maximum nesting depth");
  });

  test("allows exactly max depth (20)", () => {
    let obj: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 19; i++) {
      obj = { nested: obj };
    }
    const result = sanitizeMcpInput(obj);
    // Should NOT have _error at any level
    let current: any = result;
    for (let i = 0; i < 19; i++) {
      current = current.nested;
    }
    expect(current).toHaveProperty("value", "leaf");
  });

  // Key count limiting
  test("rejects object with more than 100 keys", () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 101; i++) {
      input[`key${i}`] = i;
    }
    const result = sanitizeMcpInput(input);
    expect(result).toHaveProperty("_error");
    expect(result._error).toContain("too many keys");
  });

  test("allows object with exactly 100 keys", () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      input[`key${i}`] = i;
    }
    const result = sanitizeMcpInput(input);
    expect(result).not.toHaveProperty("_error");
    expect(Object.keys(result)).toHaveLength(100);
  });

  // String truncation
  test("truncates strings exceeding 256KB", () => {
    const longString = "x".repeat(256 * 1024 + 100);
    const result = sanitizeMcpInput({ text: longString });
    const truncated = result.text as string;
    expect(truncated.length).toBeLessThan(longString.length);
    expect(truncated).toContain("Truncated at");
  });

  test("preserves strings within 256KB limit", () => {
    const okString = "x".repeat(256 * 1024);
    const result = sanitizeMcpInput({ text: okString });
    expect(result.text).toBe(okString);
  });

  // Array capping
  test("caps arrays at 1000 elements", () => {
    const longArray = Array.from({ length: 1500 }, (_, i) => i);
    const result = sanitizeMcpInput({ items: longArray });
    expect((result.items as unknown[]).length).toBe(1000);
  });

  test("preserves arrays with 1000 or fewer elements", () => {
    const arr = Array.from({ length: 1000 }, (_, i) => i);
    const result = sanitizeMcpInput({ items: arr });
    expect((result.items as unknown[]).length).toBe(1000);
  });

  // Recursive sanitization in nested objects
  test("sanitizes nested objects recursively", () => {
    const inner = Object.assign(Object.create(null), { __proto__: "bad", safe: "ok" });
    const input = { outer: inner };
    const result = sanitizeMcpInput(input);
    const nested = result.outer as Record<string, unknown>;
    expect(Object.keys(nested)).not.toContain("__proto__");
    expect(nested).toHaveProperty("safe", "ok");
  });

  // Recursive sanitization in arrays
  test("sanitizes objects inside arrays", () => {
    const item = Object.assign(Object.create(null), { __proto__: "bad", name: "ok" });
    const input = { list: [item] };
    const result = sanitizeMcpInput(input);
    const list = result.list as Record<string, unknown>[];
    expect(Object.keys(list[0]!)).not.toContain("__proto__");
    expect(list[0]).toHaveProperty("name", "ok");
  });

  // Primitive array elements untouched
  test("preserves primitive elements in arrays", () => {
    const input = { nums: [1, 2, 3], strs: ["a", "b"] };
    const result = sanitizeMcpInput(input);
    expect(result.nums).toEqual([1, 2, 3]);
    expect(result.strs).toEqual(["a", "b"]);
  });
});

// ─── validateStdioCommand ──────────────────────────────────────

describe("validateStdioCommand", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    delete process.env.KCODE_SAFE_PLUGINS;
    Object.assign(process.env, originalEnv);
  });

  // Empty/whitespace
  test("rejects empty string", () => {
    const result = validateStdioCommand("");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Empty");
  });

  test("rejects whitespace-only", () => {
    const result = validateStdioCommand("   ");
    expect(result.ok).toBe(false);
  });

  // Shell blocking
  test("blocks bash", () => {
    const result = validateStdioCommand("bash");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("shell invocation");
  });

  test("blocks sh", () => {
    expect(validateStdioCommand("sh").ok).toBe(false);
  });

  test("blocks zsh", () => {
    expect(validateStdioCommand("zsh").ok).toBe(false);
  });

  test("blocks fish", () => {
    expect(validateStdioCommand("fish").ok).toBe(false);
  });

  test("blocks powershell", () => {
    expect(validateStdioCommand("powershell").ok).toBe(false);
  });

  test("blocks pwsh", () => {
    expect(validateStdioCommand("pwsh").ok).toBe(false);
  });

  test("blocks cmd", () => {
    expect(validateStdioCommand("cmd").ok).toBe(false);
  });

  test("blocks full path to shell", () => {
    const result = validateStdioCommand("/bin/bash");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("shell invocation");
  });

  // Shell metacharacters
  test("blocks semicolon", () => {
    const result = validateStdioCommand("node; rm -rf /");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("metacharacters");
  });

  test("blocks pipe", () => {
    const result = validateStdioCommand("echo | bash");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("metacharacters");
  });

  test("blocks ampersand", () => {
    const result = validateStdioCommand("node & echo done");
    expect(result.ok).toBe(false);
  });

  test("blocks dollar sign", () => {
    const result = validateStdioCommand("echo $SECRET");
    expect(result.ok).toBe(false);
  });

  test("blocks backtick", () => {
    const result = validateStdioCommand("echo `whoami`");
    expect(result.ok).toBe(false);
  });

  test("blocks backslash", () => {
    const result = validateStdioCommand("echo \\n");
    expect(result.ok).toBe(false);
  });

  // Valid commands
  test("allows node", () => {
    expect(validateStdioCommand("node").ok).toBe(true);
  });

  test("allows npx", () => {
    expect(validateStdioCommand("npx").ok).toBe(true);
  });

  test("allows bun", () => {
    expect(validateStdioCommand("bun").ok).toBe(true);
  });

  test("allows python3", () => {
    expect(validateStdioCommand("python3").ok).toBe(true);
  });

  test("allows docker", () => {
    expect(validateStdioCommand("docker").ok).toBe(true);
  });

  test("allows mcp-server-fetch", () => {
    expect(validateStdioCommand("mcp-server-fetch").ok).toBe(true);
  });

  // Safe plugins mode
  test("safe mode blocks unlisted command", () => {
    process.env.KCODE_SAFE_PLUGINS = "1";
    const result = validateStdioCommand("curl");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not in safe-plugins allowlist");
  });

  test("safe mode allows listed command", () => {
    process.env.KCODE_SAFE_PLUGINS = "1";
    expect(validateStdioCommand("node").ok).toBe(true);
  });

  test("safe mode allows wildcard match (mcp-server-*)", () => {
    process.env.KCODE_SAFE_PLUGINS = "1";
    expect(validateStdioCommand("mcp-server-github").ok).toBe(true);
  });

  test("non-safe mode allows any non-shell command", () => {
    delete process.env.KCODE_SAFE_PLUGINS;
    expect(validateStdioCommand("curl").ok).toBe(true);
  });
});
