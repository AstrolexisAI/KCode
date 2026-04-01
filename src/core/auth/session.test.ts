import { beforeEach, describe, expect, test } from "bun:test";
import { _resetAuthSessionManager, AuthSessionManager, getAuthSessionManager } from "./session";

describe("AuthSessionManager", () => {
  let manager: AuthSessionManager;

  beforeEach(() => {
    _resetAuthSessionManager();
    manager = new AuthSessionManager();
  });

  describe("constructor", () => {
    test("starts with no active providers", () => {
      expect(manager.getActiveProviders()).toEqual([]);
    });
  });

  describe("hasAuth", () => {
    test("returns false for unknown provider", () => {
      expect(manager.hasAuth("nonexistent")).toBe(false);
    });
  });

  describe("getSessionInfo", () => {
    test("returns null for unknown provider", () => {
      expect(manager.getSessionInfo("nonexistent")).toBeNull();
    });
  });

  describe("loadSession", () => {
    test("returns null when no stored tokens", async () => {
      const session = await manager.loadSession("test-provider-xxx");
      expect(session).toBeNull();
    });
  });

  describe("getAccessToken", () => {
    test("returns null for unknown provider without stored tokens", async () => {
      const token = await manager.getAccessToken("nonexistent-provider-xxx");
      expect(token).toBeNull();
    });
  });

  describe("logout", () => {
    test("does not throw for unknown provider", async () => {
      await expect(manager.logout("nonexistent")).resolves.toBeUndefined();
    });
  });

  describe("logoutAll", () => {
    test("clears all sessions", async () => {
      await manager.logoutAll();
      expect(manager.getActiveProviders()).toEqual([]);
    });
  });

  describe("singleton", () => {
    test("getAuthSessionManager returns same instance", () => {
      const a = getAuthSessionManager();
      const b = getAuthSessionManager();
      expect(a).toBe(b);
    });

    test("_resetAuthSessionManager creates new instance", () => {
      const a = getAuthSessionManager();
      _resetAuthSessionManager();
      const b = getAuthSessionManager();
      expect(a).not.toBe(b);
    });
  });
});
