import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getOfflineMode, initOfflineMode, OfflineMode, resetOfflineMode } from "./mode";
import type { OfflineSettings } from "./types";

describe("OfflineMode", () => {
  afterEach(() => {
    resetOfflineMode();
  });

  // ─── enable / disable ────────────────────────────────────────

  describe("enable / disable", () => {
    test("enable() sets forced and active to true", () => {
      const mode = new OfflineMode();
      expect(mode.isActive()).toBe(false);
      mode.enable();
      expect(mode.isActive()).toBe(true);
      expect(mode.getState().forced).toBe(true);
    });

    test("disable() clears forced, active follows detected", () => {
      const mode = new OfflineMode();
      mode.enable();
      mode.disable();
      expect(mode.isActive()).toBe(false);
      expect(mode.getState().forced).toBe(false);
    });

    test("disable() keeps active=true if detected is true", async () => {
      const mode = new OfflineMode({
        dnsResolver: async () => {
          throw new Error("no network");
        },
      });
      // Force a connectivity check so detected becomes true
      await mode.checkConnectivity();
      expect(mode.getState().detected).toBe(true);
      // Now disable forced — active should still be true because detected is true
      mode.enable();
      mode.disable();
      expect(mode.isActive()).toBe(true);
    });
  });

  // ─── checkConnectivity ───────────────────────────────────────

  describe("checkConnectivity", () => {
    test("returns true when DNS resolves", async () => {
      const mode = new OfflineMode({
        dnsResolver: async () => [{ address: "8.8.8.8" }],
      });
      const online = await mode.checkConnectivity();
      expect(online).toBe(true);
      expect(mode.isActive()).toBe(false);
      expect(mode.getState().detected).toBe(false);
    });

    test("returns false when DNS fails", async () => {
      const mode = new OfflineMode({
        dnsResolver: async () => {
          throw new Error("ENOTFOUND");
        },
      });
      const online = await mode.checkConnectivity();
      expect(online).toBe(false);
      expect(mode.isActive()).toBe(true);
      expect(mode.getState().detected).toBe(true);
    });

    test("caches result for 60 seconds", async () => {
      let callCount = 0;
      const mode = new OfflineMode({
        dnsResolver: async () => {
          callCount++;
          return [];
        },
      });
      await mode.checkConnectivity();
      await mode.checkConnectivity();
      await mode.checkConnectivity();
      expect(callCount).toBe(1); // Only called once, subsequent calls use cache
    });

    test("skips check when forced offline", async () => {
      let called = false;
      const mode = new OfflineMode({
        dnsResolver: async () => {
          called = true;
          return [];
        },
      });
      mode.enable();
      const online = await mode.checkConnectivity();
      expect(online).toBe(false);
      expect(called).toBe(false);
    });
  });

  // ─── settings integration ────────────────────────────────────

  describe("settings", () => {
    test("enabled=true in settings forces offline mode on", () => {
      const mode = new OfflineMode({ settings: { enabled: true } });
      expect(mode.isActive()).toBe(true);
      expect(mode.getState().forced).toBe(true);
    });

    test("no settings defaults to online", () => {
      const mode = new OfflineMode();
      expect(mode.isActive()).toBe(false);
    });
  });

  // ─── notifySystemPrompt ──────────────────────────────────────

  describe("notifySystemPrompt", () => {
    test("returns empty string when online", () => {
      const mode = new OfflineMode();
      expect(mode.notifySystemPrompt()).toBe("");
    });

    test("returns offline notice when active", () => {
      const mode = new OfflineMode();
      mode.enable();
      const prompt = mode.notifySystemPrompt();
      expect(prompt).toContain("Offline Mode Active");
      expect(prompt).toContain("WebFetch");
      expect(prompt).toContain("WebSearch");
    });
  });

  // ─── auditLocalResources ────────────────────────────────────

  describe("auditLocalResources", () => {
    test("returns resource inventory", async () => {
      const mode = new OfflineMode({
        fetchFn: (async () => {
          throw new Error("no server");
        }) as unknown as typeof fetch,
      });
      const resources = await mode.auditLocalResources();
      expect(resources).toHaveProperty("hasLocalModel");
      expect(resources).toHaveProperty("hasLocalWhisper");
      expect(resources).toHaveProperty("hasPluginCache");
      expect(resources).toHaveProperty("hasCachedDocs");
      // In test environment, local model servers are likely not running
      expect(typeof resources.hasLocalModel).toBe("boolean");
    });
  });

  // ─── Singleton ───────────────────────────────────────────────

  describe("singleton", () => {
    test("getOfflineMode returns the same instance", () => {
      const a = getOfflineMode();
      const b = getOfflineMode();
      expect(a).toBe(b);
    });

    test("initOfflineMode replaces the singleton", () => {
      const a = getOfflineMode();
      const b = initOfflineMode({ forced: true });
      expect(b).not.toBe(a);
      expect(b.isActive()).toBe(true);
      expect(getOfflineMode()).toBe(b);
    });

    test("resetOfflineMode clears the singleton", () => {
      const a = getOfflineMode();
      resetOfflineMode();
      const b = getOfflineMode();
      expect(b).not.toBe(a);
    });
  });

  // ─── getState snapshot ───────────────────────────────────────

  describe("getState", () => {
    test("returns a copy (not a reference)", () => {
      const mode = new OfflineMode();
      const state1 = mode.getState();
      mode.enable();
      const state2 = mode.getState();
      expect(state1.active).toBe(false);
      expect(state2.active).toBe(true);
    });
  });
});
