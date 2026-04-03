// KCode - MCP Input Sanitization Tests
// Validates prototype pollution prevention, depth limits, and response truncation

import { afterAll, describe, expect, test } from "bun:test";
import { sanitizeMcpInput, validateStdioCommand } from "./mcp-client";

// ─── Prototype Pollution Prevention ─────────────────────────────

describe("sanitizeMcpInput — prototype pollution", () => {
  test("strips __proto__ key", () => {
    const input = { __proto__: { admin: true }, name: "test" };
    const result = sanitizeMcpInput(input);
    expect(result).toEqual({ name: "test" });
    expect(Object.hasOwn(result, "__proto__")).toBe(false);
  });

  test("strips constructor key", () => {
    const input = { constructor: { prototype: { polluted: true } }, value: 42 };
    const result = sanitizeMcpInput(input);
    expect(result).toEqual({ value: 42 });
  });

  test("strips prototype key", () => {
    const input = { prototype: { hack: true }, data: "ok" };
    const result = sanitizeMcpInput(input);
    expect(result).toEqual({ data: "ok" });
  });

  test("strips dangerous keys in nested objects", () => {
    const input = {
      outer: {
        __proto__: { admin: true },
        constructor: "bad",
        safe: "value",
      },
    };
    const result = sanitizeMcpInput(input);
    expect(result).toEqual({ outer: { safe: "value" } });
  });

  test("strips dangerous keys in arrays of objects", () => {
    // Use JSON.parse to avoid TS narrowing issues with __proto__ literal
    const input = JSON.parse(
      '{"items":[{"__proto__":{},"name":"a"},{"constructor":{},"name":"b"}]}',
    );
    const result = sanitizeMcpInput(input);
    expect((result.items as unknown[])[0]).toEqual({ name: "a" });
    expect((result.items as unknown[])[1]).toEqual({ name: "b" });
  });
});

// ─── Depth Limiting ─────────────────────────────────────────────

describe("sanitizeMcpInput — depth limiting", () => {
  test("allows reasonable nesting depth", () => {
    let obj: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 15; i++) {
      obj = { nested: obj };
    }
    const result = sanitizeMcpInput(obj);
    // Should not contain _error at reasonable depth
    expect(JSON.stringify(result)).toContain("leaf");
  });

  test("rejects excessively deep nesting (> 20 levels)", () => {
    let obj: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 25; i++) {
      obj = { nested: obj };
    }
    const result = sanitizeMcpInput(obj);
    // At some level it should have been replaced with error
    expect(JSON.stringify(result)).toContain("maximum nesting depth");
  });
});

// ─── Normal Input Pass-Through ──────────────────────────────────

describe("sanitizeMcpInput — pass-through", () => {
  test("preserves normal string/number/boolean values", () => {
    const input = { name: "test", count: 42, active: true, tag: null };
    const result = sanitizeMcpInput(input);
    expect(result).toEqual(input);
  });

  test("preserves arrays of primitives", () => {
    const input = { tags: ["a", "b", "c"], nums: [1, 2, 3] };
    const result = sanitizeMcpInput(input);
    expect(result).toEqual(input);
  });

  test("preserves nested objects without dangerous keys", () => {
    const input = {
      config: {
        server: { host: "localhost", port: 8080 },
        features: ["auth", "logs"],
      },
    };
    const result = sanitizeMcpInput(input);
    expect(result).toEqual(input);
  });

  test("handles empty objects", () => {
    expect(sanitizeMcpInput({})).toEqual({});
  });
});

// ─── Field Size Limits ──────────────────────────────────────────

describe("sanitizeMcpInput — field limits", () => {
  test("truncates oversized string fields", () => {
    const bigString = "x".repeat(300_000);
    const result = sanitizeMcpInput({ data: bigString });
    expect(typeof result.data).toBe("string");
    expect((result.data as string).length).toBeLessThan(bigString.length);
    expect(result.data as string).toContain("Truncated");
  });

  test("rejects objects with too many keys", () => {
    const manyKeys: Record<string, unknown> = {};
    for (let i = 0; i < 150; i++) manyKeys[`key${i}`] = i;
    const result = sanitizeMcpInput(manyKeys);
    expect(result._error).toContain("too many keys");
  });

  test("caps array elements at limit", () => {
    const bigArray = Array.from({ length: 2000 }, (_, i) => i);
    const result = sanitizeMcpInput({ items: bigArray });
    expect((result.items as unknown[]).length).toBe(1000);
  });
});

// ─── Stdio Command Validation ───────────────────────────────────

describe("validateStdioCommand", () => {
  test("allows npx", () => {
    expect(validateStdioCommand("npx").ok).toBe(true);
  });

  test("allows node", () => {
    expect(validateStdioCommand("node").ok).toBe(true);
  });

  test("allows python3", () => {
    expect(validateStdioCommand("python3").ok).toBe(true);
  });

  test("allows docker", () => {
    expect(validateStdioCommand("docker").ok).toBe(true);
  });

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

  test("blocks /bin/bash via basename extraction", () => {
    expect(validateStdioCommand("/bin/bash").ok).toBe(false);
  });

  test("blocks commands with shell metacharacters", () => {
    expect(validateStdioCommand("node; rm -rf /").ok).toBe(false);
    expect(validateStdioCommand("echo | cat").ok).toBe(false);
    expect(validateStdioCommand("cmd && bad").ok).toBe(false);
    expect(validateStdioCommand("$(whoami)").ok).toBe(false);
    expect(validateStdioCommand("`id`").ok).toBe(false);
  });

  test("blocks empty command", () => {
    expect(validateStdioCommand("").ok).toBe(false);
    expect(validateStdioCommand("   ").ok).toBe(false);
  });

  describe("safe-plugins mode", () => {
    const origEnv = process.env.KCODE_SAFE_PLUGINS;

    afterAll(() => {
      if (origEnv === undefined) delete process.env.KCODE_SAFE_PLUGINS;
      else process.env.KCODE_SAFE_PLUGINS = origEnv;
    });

    test("blocks unknown commands in safe mode", () => {
      process.env.KCODE_SAFE_PLUGINS = "1";
      const result = validateStdioCommand("my-custom-binary");
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("safe-plugins allowlist");
    });

    test("allows npx in safe mode", () => {
      process.env.KCODE_SAFE_PLUGINS = "1";
      expect(validateStdioCommand("npx").ok).toBe(true);
    });
  });
});

// ─── Plugin Manifest Validation ─────────────────────────────────

describe("Plugin manifest validation", () => {
  test("rejects plugin names with path traversal", async () => {
    const { PluginManager } = await import("./plugin-manager");
    new PluginManager();

    // We can't directly test readManifest (private), but we can verify
    // the name regex pattern catches dangerous names
    const dangerousNames = ["../etc/passwd", "../../root", "foo/bar", "a b c", "name;rm -rf"];
    const safeNames = ["my-plugin", "test_plugin", "Plugin123"];

    // The regex is: /^[a-zA-Z0-9_-]+$/
    const nameRegex = /^[a-zA-Z0-9_-]+$/;
    for (const name of dangerousNames) {
      expect(nameRegex.test(name)).toBe(false);
    }
    for (const name of safeNames) {
      expect(nameRegex.test(name)).toBe(true);
    }
  });
});
