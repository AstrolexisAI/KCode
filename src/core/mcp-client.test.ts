import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type ElicitationCallback,
  type ElicitationResponse,
  type JsonRpcRequest,
  type JsonRpcResponse,
  McpHttpConnection,
  type McpServerConfig,
  McpServerConnection,
  type McpServersConfig,
  type McpToolSchema,
  sanitizeMcpInput,
  validateStdioCommand,
} from "./mcp-client.ts";

import { isToolAllowedByConfig, mcpToolGlobMatch } from "./mcp-tools.ts";

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

  // ─── All dangerous shells enumeration ────────────────────────

  const allShells = [
    "sh",
    "bash",
    "zsh",
    "fish",
    "csh",
    "tcsh",
    "dash",
    "ksh",
    "cmd",
    "powershell",
    "pwsh",
  ];

  for (const shell of allShells) {
    test(`blocks "${shell}" via absolute path /usr/bin/${shell}`, () => {
      expect(validateStdioCommand(`/usr/bin/${shell}`).ok).toBe(false);
    });
  }

  // ─── Allowlist commands enumeration ──────────────────────────

  const allowlisted = [
    "npx",
    "node",
    "bun",
    "bunx",
    "deno",
    "python",
    "python3",
    "pip",
    "pipx",
    "uvx",
    "docker",
    "podman",
    "mcp-server",
  ];

  for (const cmd of allowlisted) {
    test(`allows allowlisted command "${cmd}" in safe-plugins mode`, () => {
      process.env.KCODE_SAFE_PLUGINS = "1";
      expect(validateStdioCommand(cmd).ok).toBe(true);
    });
  }
});

// ─── McpServerConnection ────────────────────────────────────────

describe("McpServerConnection", () => {
  test("constructor sets name", () => {
    const conn = new McpServerConnection("test-server", { command: "node" });
    expect(conn.name).toBe("test-server");
  });

  test("getTools returns empty array before discovery", () => {
    const conn = new McpServerConnection("test", { command: "node" });
    expect(conn.getTools()).toEqual([]);
  });

  test("getResources returns empty array before discovery", () => {
    const conn = new McpServerConnection("test", { command: "node" });
    expect(conn.getResources()).toEqual([]);
  });

  test("isAlive returns false when no process started", () => {
    const conn = new McpServerConnection("test", { command: "node" });
    expect(conn.isAlive()).toBe(false);
  });

  test("start rejects blocked shell commands", async () => {
    const conn = new McpServerConnection("evil-server", { command: "bash" });
    await expect(conn.start()).rejects.toThrow("blocked");
  });

  test("start rejects empty command", async () => {
    const conn = new McpServerConnection("empty", { command: "" });
    await expect(conn.start()).rejects.toThrow("blocked");
  });

  test("start rejects commands with metacharacters", async () => {
    const conn = new McpServerConnection("inject", { command: "node; rm -rf /" });
    await expect(conn.start()).rejects.toThrow("blocked");
  });

  test("start rejects pipe injection", async () => {
    const conn = new McpServerConnection("pipe", { command: "node|malicious" });
    await expect(conn.start()).rejects.toThrow("blocked");
  });

  test("start rejects backtick injection", async () => {
    const conn = new McpServerConnection("bt", { command: "npx`id`" });
    await expect(conn.start()).rejects.toThrow("blocked");
  });

  test("start rejects dollar sign injection", async () => {
    const conn = new McpServerConnection("dollar", { command: "node$PATH" });
    await expect(conn.start()).rejects.toThrow("blocked");
  });

  test("start rejects ampersand background exec", async () => {
    const conn = new McpServerConnection("bg", { command: "node&malicious" });
    await expect(conn.start()).rejects.toThrow("blocked");
  });

  test("shutdown does not throw on unstarted connection", () => {
    const conn = new McpServerConnection("test", { command: "node" });
    expect(() => conn.shutdown()).not.toThrow();
  });

  test("shutdown can be called multiple times", () => {
    const conn = new McpServerConnection("test", { command: "node" });
    expect(() => {
      conn.shutdown();
      conn.shutdown();
    }).not.toThrow();
  });

  test("setElicitationCallback does not throw", () => {
    const conn = new McpServerConnection("test", { command: "node" });
    const cb: ElicitationCallback = async () => ({ action: "accept" as const });
    expect(() => conn.setElicitationCallback(cb)).not.toThrow();
  });
});

// ─── McpHttpConnection ─────────────────────────────────────────

describe("McpHttpConnection", () => {
  test("constructor sets name", () => {
    const conn = new McpHttpConnection("http-srv", {
      url: "http://localhost:3000",
      transport: "http",
    });
    expect(conn.name).toBe("http-srv");
  });

  test("getTools returns empty array before discovery", () => {
    const conn = new McpHttpConnection("test", {
      url: "http://localhost:3000",
      transport: "http",
    });
    expect(conn.getTools()).toEqual([]);
  });

  test("getResources returns empty array before discovery", () => {
    const conn = new McpHttpConnection("test", {
      url: "http://localhost:3000",
      transport: "http",
    });
    expect(conn.getResources()).toEqual([]);
  });

  test("isAlive returns true for HTTP transport (stateless)", () => {
    const conn = new McpHttpConnection("test", {
      url: "http://localhost:3000",
      transport: "http",
    });
    expect(conn.isAlive()).toBe(true);
  });

  test("isAlive returns false for SSE transport when not connected", () => {
    const conn = new McpHttpConnection("test", {
      url: "http://localhost:3000",
      transport: "sse",
    });
    expect(conn.isAlive()).toBe(false);
  });

  test("isAlive returns true when transport is unset (defaults to http)", () => {
    const conn = new McpHttpConnection("test", {
      url: "http://localhost:3000",
    });
    expect(conn.isAlive()).toBe(true);
  });

  test("shutdown does not throw on unstarted connection", () => {
    const conn = new McpHttpConnection("test", {
      url: "http://localhost:3000",
      transport: "http",
    });
    expect(() => conn.shutdown()).not.toThrow();
  });

  test("shutdown can be called multiple times", () => {
    const conn = new McpHttpConnection("test", {
      url: "http://localhost:3000",
      transport: "http",
    });
    expect(() => {
      conn.shutdown();
      conn.shutdown();
    }).not.toThrow();
  });

  test("setElicitationCallback does not throw", () => {
    const conn = new McpHttpConnection("test", {
      url: "http://localhost:3000",
      transport: "http",
    });
    const cb: ElicitationCallback = async () => ({ action: "deny" as const });
    expect(() => conn.setElicitationCallback(cb)).not.toThrow();
  });

  test("start fails when URL is missing (http)", async () => {
    const conn = new McpHttpConnection("no-url", { transport: "http" });
    await expect(conn.start()).rejects.toThrow();
  });

  test("start fails when URL is missing (sse)", async () => {
    const conn = new McpHttpConnection("no-url-sse", { transport: "sse" });
    await expect(conn.start()).rejects.toThrow("No URL configured");
  });
});

// ─── JSON-RPC message format ────────────────────────────────────

describe("JSON-RPC message format", () => {
  test("request with method and params", () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    };
    expect(request.jsonrpc).toBe("2.0");
    expect(request.id).toBe(1);
    expect(request.method).toBe("tools/list");
    expect(request.params).toEqual({});
  });

  test("request without params", () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 42,
      method: "notifications/initialized",
    };
    expect(request.params).toBeUndefined();
  });

  test("serialized request is valid JSON", () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read_file", arguments: { path: "/tmp/test" } },
    };
    const json = JSON.stringify(request);
    const parsed = JSON.parse(json);
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.method).toBe("tools/call");
    expect(parsed.params.name).toBe("read_file");
  });

  test("response with result (success)", () => {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "test_tool" }] },
    };
    expect(response.result).toEqual({ tools: [{ name: "test_tool" }] });
    expect(response.error).toBeUndefined();
  });

  test("response with error", () => {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "Invalid Request" },
    };
    expect(response.error?.code).toBe(-32600);
    expect(response.error?.message).toBe("Invalid Request");
    expect(response.result).toBeUndefined();
  });

  test("response error with data field", () => {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "Server error", data: { stack: "..." } },
    };
    expect(response.error?.data).toEqual({ stack: "..." });
  });

  test("standard JSON-RPC error codes", () => {
    const parseError: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32700, message: "Parse error" },
    };
    const invalidReq: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32600, message: "Invalid Request" },
    };
    const notFound: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32601, message: "Method not found" },
    };
    const invalidParams: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32602, message: "Invalid params" },
    };
    const internalErr: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 5,
      error: { code: -32603, message: "Internal error" },
    };
    expect(parseError.error!.code).toBe(-32700);
    expect(invalidReq.error!.code).toBe(-32600);
    expect(notFound.error!.code).toBe(-32601);
    expect(invalidParams.error!.code).toBe(-32602);
    expect(internalErr.error!.code).toBe(-32603);
  });
});

// ─── McpToolSchema ──────────────────────────────────────────────

describe("McpToolSchema", () => {
  test("minimal schema with only name", () => {
    const schema: McpToolSchema = { name: "read_file" };
    expect(schema.name).toBe("read_file");
    expect(schema.description).toBeUndefined();
    expect(schema.inputSchema).toBeUndefined();
  });

  test("full schema with description and input schema", () => {
    const schema: McpToolSchema = {
      name: "read_file",
      description: "Read the contents of a file",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          encoding: { type: "string", enum: ["utf-8", "base64"] },
        },
        required: ["path"],
      },
    };
    expect(schema.name).toBe("read_file");
    expect(schema.description).toContain("Read");
    const props = schema.inputSchema!.properties as Record<string, unknown>;
    expect(props.path).toEqual({ type: "string", description: "File path" });
    expect(schema.inputSchema!.required as string[]).toContain("path");
  });

  test("tool schema with no input params", () => {
    const schema: McpToolSchema = {
      name: "get_status",
      description: "Get current status",
      inputSchema: { type: "object", properties: {} },
    };
    expect(schema.inputSchema!.type).toBe("object");
  });
});

// ─── Tool filtering: mcpToolGlobMatch ───────────────────────────

describe("mcpToolGlobMatch", () => {
  test("exact match succeeds", () => {
    expect(mcpToolGlobMatch("read_file", "read_file")).toBe(true);
  });

  test("exact match fails for different names", () => {
    expect(mcpToolGlobMatch("read_file", "write_file")).toBe(false);
  });

  test("trailing wildcard matches prefix", () => {
    expect(mcpToolGlobMatch("read_*", "read_file")).toBe(true);
    expect(mcpToolGlobMatch("read_*", "read_directory")).toBe(true);
    expect(mcpToolGlobMatch("read_*", "read_")).toBe(true);
  });

  test("trailing wildcard rejects different prefix", () => {
    expect(mcpToolGlobMatch("read_*", "write_file")).toBe(false);
  });

  test("leading wildcard matches suffix", () => {
    expect(mcpToolGlobMatch("*_file", "read_file")).toBe(true);
    expect(mcpToolGlobMatch("*_file", "write_file")).toBe(true);
  });

  test("wildcard in middle matches", () => {
    expect(mcpToolGlobMatch("get_*_info", "get_user_info")).toBe(true);
    expect(mcpToolGlobMatch("get_*_info", "get_file_info")).toBe(true);
  });

  test("standalone wildcard matches everything", () => {
    expect(mcpToolGlobMatch("*", "anything")).toBe(true);
    expect(mcpToolGlobMatch("*", "")).toBe(true);
  });

  test("case insensitive matching", () => {
    expect(mcpToolGlobMatch("Read_File", "read_file")).toBe(true);
    expect(mcpToolGlobMatch("read_file", "READ_FILE")).toBe(true);
  });

  test("escapes regex special characters (dot)", () => {
    expect(mcpToolGlobMatch("file.read", "file.read")).toBe(true);
    expect(mcpToolGlobMatch("file.read", "fileXread")).toBe(false);
  });

  test("escapes regex special characters (brackets)", () => {
    expect(mcpToolGlobMatch("tool[1]", "tool[1]")).toBe(true);
    expect(mcpToolGlobMatch("tool[1]", "toolX")).toBe(false);
  });

  test("multiple wildcards", () => {
    expect(mcpToolGlobMatch("*_*", "read_file")).toBe(true);
    expect(mcpToolGlobMatch("*_*", "singleword")).toBe(false);
  });
});

// ─── Tool filtering: isToolAllowedByConfig ──────────────────────

describe("isToolAllowedByConfig", () => {
  test("allows all tools when no restrictions set", () => {
    const config: McpServerConfig = { command: "node" };
    expect(isToolAllowedByConfig("any_tool", config)).toBe(true);
  });

  test("blockedTools denies matching tools", () => {
    const config: McpServerConfig = {
      command: "node",
      blockedTools: ["delete_*", "admin_*"],
    };
    expect(isToolAllowedByConfig("delete_file", config)).toBe(false);
    expect(isToolAllowedByConfig("admin_reset", config)).toBe(false);
    expect(isToolAllowedByConfig("read_file", config)).toBe(true);
  });

  test("allowedTools restricts to whitelist", () => {
    const config: McpServerConfig = {
      command: "node",
      allowedTools: ["read_*", "search"],
    };
    expect(isToolAllowedByConfig("read_file", config)).toBe(true);
    expect(isToolAllowedByConfig("search", config)).toBe(true);
    expect(isToolAllowedByConfig("write_file", config)).toBe(false);
    expect(isToolAllowedByConfig("delete_file", config)).toBe(false);
  });

  test("blockedTools takes precedence over allowedTools", () => {
    const config: McpServerConfig = {
      command: "node",
      allowedTools: ["read_*"],
      blockedTools: ["read_secret"],
    };
    expect(isToolAllowedByConfig("read_file", config)).toBe(true);
    expect(isToolAllowedByConfig("read_secret", config)).toBe(false);
  });

  test("empty allowedTools array allows all (length check)", () => {
    const config: McpServerConfig = {
      command: "node",
      allowedTools: [],
    };
    expect(isToolAllowedByConfig("any_tool", config)).toBe(true);
  });

  test("empty blockedTools array blocks nothing", () => {
    const config: McpServerConfig = {
      command: "node",
      blockedTools: [],
    };
    expect(isToolAllowedByConfig("any_tool", config)).toBe(true);
  });

  test("wildcard allowedTools allows everything", () => {
    const config: McpServerConfig = {
      command: "node",
      allowedTools: ["*"],
    };
    expect(isToolAllowedByConfig("any_tool", config)).toBe(true);
  });

  test("wildcard blockedTools blocks everything", () => {
    const config: McpServerConfig = {
      command: "node",
      blockedTools: ["*"],
    };
    expect(isToolAllowedByConfig("any_tool", config)).toBe(false);
  });

  test("multiple blockedTools patterns", () => {
    const config: McpServerConfig = {
      command: "node",
      blockedTools: ["delete_*", "drop_*", "truncate_*"],
    };
    expect(isToolAllowedByConfig("delete_user", config)).toBe(false);
    expect(isToolAllowedByConfig("drop_table", config)).toBe(false);
    expect(isToolAllowedByConfig("truncate_logs", config)).toBe(false);
    expect(isToolAllowedByConfig("read_user", config)).toBe(true);
  });
});

// ─── McpServerConfig structure validation ───────────────────────

describe("McpServerConfig: structure", () => {
  test("stdio config with all fields", () => {
    const config: McpServerConfig = {
      command: "npx",
      args: ["-y", "mcp-server-github"],
      env: { GITHUB_TOKEN: "token" },
      allowedTools: ["read_*"],
      blockedTools: ["delete_*"],
    };
    expect(config.command).toBe("npx");
    expect(config.args).toEqual(["-y", "mcp-server-github"]);
    expect(config.env!.GITHUB_TOKEN).toBe("token");
  });

  test("http config with all fields", () => {
    const config: McpServerConfig = {
      url: "https://api.example.com/mcp",
      transport: "http",
      apiKey: "sk-test",
      headers: { "X-Custom": "value" },
    };
    expect(config.transport).toBe("http");
    expect(config.apiKey).toBe("sk-test");
  });

  test("sse config", () => {
    const config: McpServerConfig = {
      url: "https://api.example.com/sse",
      transport: "sse",
    };
    expect(config.transport).toBe("sse");
  });

  test("oauth config structure", () => {
    const config: McpServerConfig = {
      url: "https://api.example.com/mcp",
      transport: "http",
      oauth: {
        clientId: "my-client",
        clientSecret: "secret",
        authorizationUrl: "https://auth.example.com/authorize",
        tokenUrl: "https://auth.example.com/token",
        scopes: ["read", "write"],
      },
    };
    expect(config.oauth!.clientId).toBe("my-client");
    expect(config.oauth!.scopes).toEqual(["read", "write"]);
  });

  test("oauthAutoDiscover flag", () => {
    const config: McpServerConfig = {
      url: "https://api.example.com/mcp",
      transport: "http",
      oauthAutoDiscover: true,
    };
    expect(config.oauthAutoDiscover).toBe(true);
  });
});

// ─── McpServersConfig ───────────────────────────────────────────

describe("McpServersConfig", () => {
  test("maps server names to configs", () => {
    const config: McpServersConfig = {
      github: {
        command: "npx",
        args: ["-y", "mcp-server-github"],
        env: { GITHUB_TOKEN: "token" },
      },
      filesystem: {
        command: "npx",
        args: ["-y", "mcp-server-filesystem", "/tmp"],
      },
      remote: {
        url: "https://mcp.example.com/v1",
        transport: "http",
        apiKey: "sk-test",
      },
    };
    expect(Object.keys(config)).toHaveLength(3);
    expect(config.github.command).toBe("npx");
    expect(config.remote.transport).toBe("http");
  });
});

// ─── Elicitation types ──────────────────────────────────────────

describe("Elicitation types", () => {
  test("accept action with content", () => {
    const response: ElicitationResponse = {
      action: "accept",
      content: { approved: true, reason: "Looks good" },
    };
    expect(response.action).toBe("accept");
    expect(response.content!.approved).toBe(true);
  });

  test("deny action", () => {
    const response: ElicitationResponse = { action: "deny" };
    expect(response.action).toBe("deny");
    expect(response.content).toBeUndefined();
  });

  test("cancel action", () => {
    const response: ElicitationResponse = { action: "cancel" };
    expect(response.action).toBe("cancel");
  });

  test("elicitation callback returns promise", async () => {
    const cb: ElicitationCallback = async (params) => {
      return { action: "accept", content: { answered: true } };
    };
    const result = await cb({ message: "Do you approve?" });
    expect(result.action).toBe("accept");
  });
});

// ─── sanitizeMcpInput: additional edge cases ────────────────────

describe("sanitizeMcpInput: edge cases", () => {
  test("handles undefined values", () => {
    const result = sanitizeMcpInput({ a: undefined });
    expect(result.a).toBeUndefined();
  });

  test("handles number edge cases", () => {
    const result = sanitizeMcpInput({ a: 0, b: -1, c: 3.14, d: Infinity, e: NaN });
    expect(result.a).toBe(0);
    expect(result.b).toBe(-1);
    expect(result.c).toBe(3.14);
  });

  test("deeply nested arrays with objects", () => {
    const input = {
      list: [{ nested: { value: 1 } }, { nested: { value: 2 } }],
    };
    const result = sanitizeMcpInput(input);
    const list = result.list as Array<{ nested: { value: number } }>;
    expect(list[0].nested.value).toBe(1);
    expect(list[1].nested.value).toBe(2);
  });

  test("mixed array contents", () => {
    const input = { items: [1, "two", { three: 3 }, null, true] };
    const result = sanitizeMcpInput(input);
    const items = result.items as unknown[];
    expect(items[0]).toBe(1);
    expect(items[1]).toBe("two");
    expect(items[2]).toEqual({ three: 3 });
    expect(items[3]).toBeNull();
    expect(items[4]).toBe(true);
  });

  test("string exactly at 256KB boundary is not truncated", () => {
    const exactSize = "x".repeat(256 * 1024);
    const result = sanitizeMcpInput({ s: exactSize });
    expect(result.s).toBe(exactSize);
  });

  test("string one byte over 256KB is truncated", () => {
    const overSize = "x".repeat(256 * 1024 + 1);
    const result = sanitizeMcpInput({ s: overSize });
    // The truncated string starts with 256KB of the original content plus a truncation notice
    expect(result.s as string).toContain("[Truncated at");
    expect(result.s as string).not.toBe(overSize);
  });

  test("multiple dangerous keys are all stripped", () => {
    const input = Object.create(null);
    input.__proto__ = "evil1";
    input.constructor = "evil2";
    input.prototype = "evil3";
    input.safe = "ok";
    const result = sanitizeMcpInput(input);
    expect(Object.keys(result)).toEqual(["safe"]);
    expect(result.safe).toBe("ok");
  });

  test("nested dangerous keys at multiple levels are stripped", () => {
    const inner = Object.create(null);
    inner.__proto__ = "bad";
    inner.value = "ok";
    const outer = Object.create(null);
    outer.constructor = "bad";
    outer.child = inner;
    outer.name = "test";
    const result = sanitizeMcpInput(outer);
    expect(Object.keys(result)).toEqual(["child", "name"]);
    const child = result.child as Record<string, unknown>;
    expect(Object.keys(child)).toEqual(["value"]);
  });

  test("array elements are not counted for MAX_INPUT_KEYS", () => {
    // An object with 50 keys, one of which is an array of 200 items
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      input[`k${i}`] = i;
    }
    input.bigArray = Array.from({ length: 200 }, (_, i) => i);
    const result = sanitizeMcpInput(input);
    expect(result._error).toBeUndefined();
    expect(Object.keys(result).length).toBe(51);
  });
});
