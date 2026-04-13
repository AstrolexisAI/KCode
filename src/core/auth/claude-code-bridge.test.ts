// Tests for claude-code-bridge — credential loading + OAuth refresh paths
// Critical security code — these tests cover the gap identified in the audit
//
// SKIPPED (2026-04-13): The original mocking approach is fundamentally broken.
// It stubs `node:fs` with only `readFileSync`/`writeFileSync`, but
// `claude-code-bridge.ts` imports `log` from `../logger`, which imports
// `mkdirSync`, `appendFileSync`, etc. from `node:fs`. Loading the bridge
// inside any test crashes with `Export named 'mkdirSync' not found`.
// Worse: Bun 1.3.x's `mock.restore()` does NOT undo `mock.module()`, so the
// truncated stub leaks into every test file that runs later in the same Bun
// worker, breaking ~150 unrelated tests across web-engine, plugin-sdk,
// audit-engine, and training. The whole describe is skipped to stop the
// pollution; the file should be rewritten to use a real temp HOME and
// real fs (which requires making bridge.ts compute its credentials paths
// lazily so HOME can be overridden).

import { beforeEach, describe, expect, mock, test } from "bun:test";

describe.skip("claude-code-bridge", () => {
  beforeEach(() => {
    // Clear module cache to reset the credential cache between tests
    delete require.cache[require.resolve("./claude-code-bridge.ts")];
  });

  describe("isClaudeCodeAuthenticated", () => {
    test("returns false when credentials file doesn't exist", () => {
      mock.module("node:fs", () => ({
        readFileSync: () => {
          throw new Error("ENOENT: no such file or directory");
        },
        writeFileSync: () => {},
      }));
      const { isClaudeCodeAuthenticated } = require("./claude-code-bridge.ts");
      expect(isClaudeCodeAuthenticated()).toBe(false);
    });

    test("returns false when credentials file has no oauth data", () => {
      mock.module("node:fs", () => ({
        readFileSync: () => JSON.stringify({}),
        writeFileSync: () => {},
      }));
      const { isClaudeCodeAuthenticated } = require("./claude-code-bridge.ts");
      expect(isClaudeCodeAuthenticated()).toBe(false);
    });

    test("returns true when access token is present", () => {
      mock.module("node:fs", () => ({
        readFileSync: () =>
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "sk-ant-oat01-testtoken",
              refreshToken: "refresh-token",
              expiresAt: Date.now() + 3600000,
            },
          }),
        writeFileSync: () => {},
      }));
      const { isClaudeCodeAuthenticated } = require("./claude-code-bridge.ts");
      expect(isClaudeCodeAuthenticated()).toBe(true);
    });
  });

  describe("getClaudeCodeAuthInfo", () => {
    test("returns unauthenticated when no credentials", () => {
      mock.module("node:fs", () => ({
        readFileSync: () => {
          throw new Error("ENOENT");
        },
        writeFileSync: () => {},
      }));
      const { getClaudeCodeAuthInfo } = require("./claude-code-bridge.ts");
      expect(getClaudeCodeAuthInfo()).toEqual({ authenticated: false });
    });

    test("returns subscription info when authenticated", () => {
      mock.module("node:fs", () => ({
        readFileSync: () =>
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "sk-ant-oat01-abc",
              refreshToken: "refresh-abc",
              expiresAt: 9999999999999,
              scopes: ["org:read", "user:inference"],
              subscriptionType: "max_5x",
            },
          }),
        writeFileSync: () => {},
      }));
      const { getClaudeCodeAuthInfo } = require("./claude-code-bridge.ts");
      const info = getClaudeCodeAuthInfo();
      expect(info.authenticated).toBe(true);
      expect(info.subscriptionType).toBe("max_5x");
      expect(info.scopes).toEqual(["org:read", "user:inference"]);
    });
  });

  describe("getClaudeCodeToken", () => {
    test("returns null when no credentials file exists", async () => {
      mock.module("node:fs", () => ({
        readFileSync: () => {
          throw new Error("ENOENT");
        },
        writeFileSync: () => {},
      }));
      const { getClaudeCodeToken } = require("./claude-code-bridge.ts");
      expect(await getClaudeCodeToken()).toBe(null);
    });

    test("returns token when still valid (not expired)", async () => {
      const futureExpiry = Date.now() + 3600000; // 1 hour from now
      mock.module("node:fs", () => ({
        readFileSync: () =>
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "sk-ant-oat01-validtoken",
              refreshToken: "refresh-valid",
              expiresAt: futureExpiry,
            },
          }),
        writeFileSync: () => {},
      }));
      const { getClaudeCodeToken } = require("./claude-code-bridge.ts");
      expect(await getClaudeCodeToken()).toBe("sk-ant-oat01-validtoken");
    });

    test("returns null when expired with no refresh token", async () => {
      const pastExpiry = Date.now() - 1000;
      mock.module("node:fs", () => ({
        readFileSync: () =>
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "sk-ant-oat01-expired",
              refreshToken: "",
              expiresAt: pastExpiry,
            },
          }),
        writeFileSync: () => {},
      }));
      const { getClaudeCodeToken } = require("./claude-code-bridge.ts");
      expect(await getClaudeCodeToken()).toBe(null);
    });

    test("handles malformed JSON gracefully", () => {
      mock.module("node:fs", () => ({
        readFileSync: () => "not valid json {",
        writeFileSync: () => {},
      }));
      const { isClaudeCodeAuthenticated } = require("./claude-code-bridge.ts");
      expect(isClaudeCodeAuthenticated()).toBe(false);
    });
  });

  describe("isCodexAuthenticated", () => {
    test("returns false when no codex credentials file", () => {
      mock.module("node:fs", () => ({
        readFileSync: () => {
          throw new Error("ENOENT");
        },
        writeFileSync: () => {},
      }));
      const { isCodexAuthenticated } = require("./claude-code-bridge.ts");
      expect(isCodexAuthenticated()).toBe(false);
    });

    test("returns true when codex tokens present", () => {
      mock.module("node:fs", () => ({
        readFileSync: () =>
          JSON.stringify({
            auth_mode: "oauth",
            tokens: {
              access_token: "codex-token-abc",
              refresh_token: "codex-refresh",
            },
          }),
        writeFileSync: () => {},
      }));
      const { isCodexAuthenticated } = require("./claude-code-bridge.ts");
      expect(isCodexAuthenticated()).toBe(true);
    });
  });
});
