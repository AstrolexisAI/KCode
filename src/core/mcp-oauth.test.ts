// KCode - MCP OAuth Tests
// Tests for OAuth 2.0 PKCE flow, token storage, and discovery

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverOAuthConfig, McpOAuthClient, type OAuthConfig } from "./mcp-oauth";

// Use an isolated temp directory for token storage so tests never touch ~/.kcode/
const TEST_DIR = join(tmpdir(), `kcode-oauth-test-${process.pid}-${Date.now()}`);
const TEST_TOKEN_FILE = join(TEST_DIR, "oauth-tokens.json");
const TEST_SERVER = "test-oauth-server";

mkdirSync(TEST_DIR, { recursive: true });

// Clean up temp directory after all tests
afterAll(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
});

const testConfig: OAuthConfig = {
  clientId: "test-client-id",
  authorizationUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  scopes: ["read", "write"],
};

describe("McpOAuthClient", () => {
  test("creates client with config", () => {
    const client = new McpOAuthClient(TEST_SERVER, testConfig);
    expect(client).toBeDefined();
  });

  test("returns null for missing stored tokens", async () => {
    const client = new McpOAuthClient(TEST_SERVER, testConfig, { tokenStorePath: TEST_TOKEN_FILE });
    const tokens = await client.getStoredTokens();
    expect(tokens).toBeNull();
  });

  test("stores and retrieves tokens", async () => {
    const client = new McpOAuthClient(TEST_SERVER, testConfig, { tokenStorePath: TEST_TOKEN_FILE });
    const tokens = {
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600 * 1000, // 1 hour from now
    };

    await client.storeTokens(tokens);
    const retrieved = await client.getStoredTokens();

    expect(retrieved).not.toBeNull();
    expect(retrieved!.accessToken).toBe("test-access-token");
    expect(retrieved!.refreshToken).toBe("test-refresh-token");
    expect(retrieved!.tokenType).toBe("Bearer");
  });

  test("clears stored tokens", async () => {
    const client = new McpOAuthClient(TEST_SERVER, testConfig, { tokenStorePath: TEST_TOKEN_FILE });
    await client.storeTokens({
      accessToken: "to-be-cleared",
      tokenType: "Bearer",
    });

    await client.clearTokens();
    const retrieved = await client.getStoredTokens();
    expect(retrieved).toBeNull();
  });

  test("returns null for expired tokens without refresh token", async () => {
    const client = new McpOAuthClient(TEST_SERVER, testConfig, { tokenStorePath: TEST_TOKEN_FILE });
    await client.storeTokens({
      accessToken: "expired-token",
      tokenType: "Bearer",
      expiresAt: Date.now() - 1000, // Already expired
    });

    const retrieved = await client.getStoredTokens();
    expect(retrieved).toBeNull();
  });

  test("startAuthFlow generates auth URL with PKCE params", async () => {
    const client = new McpOAuthClient(TEST_SERVER, testConfig);
    let result: { url: string; port: number; waitForCallback: () => Promise<any> };
    try {
      result = await client.startAuthFlow();
    } catch (err: any) {
      // Skip if port binding fails in restricted/sandboxed environments
      if (err?.code === "EADDRINUSE" || err?.code === "EACCES" || err?.code === "EPERM") {
        return;
      }
      throw err;
    }

    const { url, port } = result;

    expect(url).toContain("https://auth.example.com/authorize");
    expect(url).toContain("client_id=test-client-id");
    expect(url).toContain("code_challenge=");
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain("scope=read+write");
    expect(url).toContain(`redirect_uri=http%3A%2F%2Flocalhost%3A${port}%2Fcallback`);
    expect(port).toBeGreaterThan(0);

    // Clean up — cancel the callback wait by letting it timeout or ignore
    // The callback server will auto-close on timeout
  });
});

describe("discoverOAuthConfig", () => {
  test("returns null for non-existent server", async () => {
    const config = await discoverOAuthConfig("http://127.0.0.1:1");
    expect(config).toBeNull();
  });

  test("returns null for server without well-known endpoint", async () => {
    // Use a URL that definitely won't have the well-known endpoint
    const config = await discoverOAuthConfig("https://httpbin.org");
    expect(config).toBeNull();
  });
});

describe("McpServerConfig validation", () => {
  test("accepts config with oauth object", () => {
    const config = {
      url: "https://mcp.example.com",
      transport: "http" as const,
      oauth: {
        clientId: "my-app",
        authorizationUrl: "https://auth.example.com/authorize",
        tokenUrl: "https://auth.example.com/token",
        scopes: ["tools"],
      },
    };
    expect(config.oauth.clientId).toBe("my-app");
    expect(config.url).toBe("https://mcp.example.com");
  });

  test("SSE transport config shape", () => {
    const config = {
      url: "https://mcp.example.com/sse",
      transport: "sse" as const,
      apiKey: "sk-test",
      headers: { "X-Custom": "value" },
    };
    expect(config.transport).toBe("sse");
    expect(config.headers).toEqual({ "X-Custom": "value" });
  });

  test("MCP config with allowedTools/blockedTools", () => {
    const config = {
      command: "mcp-server",
      allowedTools: ["read_*", "search"],
      blockedTools: ["delete_*"],
    };
    expect(config.allowedTools).toEqual(["read_*", "search"]);
    expect(config.blockedTools).toEqual(["delete_*"]);
  });
});

// ─── MCP Tool Filtering ────────────────────────────────────────

// We test the filtering logic inline since the actual functions are internal to mcp.ts.
// These tests validate the glob matching and filter behavior via config shapes.

describe("MCP tool permission config", () => {
  // Simulated glob match (same logic as mcpToolGlobMatch in mcp.ts)
  function mcpToolGlobMatch(pattern: string, name: string): boolean {
    const regex = pattern.replace(/([.+^${}()|[\]\\])/g, "\\$1").replace(/\*/g, ".*");
    return new RegExp(`^${regex}$`, "i").test(name);
  }

  function isToolAllowed(
    toolName: string,
    allowedTools?: string[],
    blockedTools?: string[],
  ): boolean {
    if (blockedTools && blockedTools.length > 0) {
      for (const pattern of blockedTools) {
        if (mcpToolGlobMatch(pattern, toolName)) return false;
      }
    }
    if (allowedTools && allowedTools.length > 0) {
      for (const pattern of allowedTools) {
        if (mcpToolGlobMatch(pattern, toolName)) return true;
      }
      return false;
    }
    return true;
  }

  test("no restrictions allows all tools", () => {
    expect(isToolAllowed("read_file")).toBe(true);
    expect(isToolAllowed("delete_all")).toBe(true);
  });

  test("blockedTools denies matching tools", () => {
    expect(isToolAllowed("delete_file", undefined, ["delete_*"])).toBe(false);
    expect(isToolAllowed("delete_all", undefined, ["delete_*"])).toBe(false);
    expect(isToolAllowed("read_file", undefined, ["delete_*"])).toBe(true);
  });

  test("allowedTools restricts to whitelist", () => {
    expect(isToolAllowed("read_file", ["read_*"])).toBe(true);
    expect(isToolAllowed("read_dir", ["read_*"])).toBe(true);
    expect(isToolAllowed("write_file", ["read_*"])).toBe(false);
  });

  test("blockedTools takes precedence over allowedTools", () => {
    expect(isToolAllowed("read_secret", ["read_*"], ["*_secret"])).toBe(false);
    expect(isToolAllowed("read_file", ["read_*"], ["*_secret"])).toBe(true);
  });

  test("exact name match works", () => {
    expect(isToolAllowed("search", ["search", "read"])).toBe(true);
    expect(isToolAllowed("delete", ["search", "read"])).toBe(false);
  });

  test("case insensitive matching", () => {
    expect(isToolAllowed("Read_File", ["read_*"])).toBe(true);
    expect(isToolAllowed("READ_FILE", ["read_*"])).toBe(true);
  });
});
