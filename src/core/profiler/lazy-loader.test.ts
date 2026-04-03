import { beforeEach, describe, expect, test } from "bun:test";
import { _resetLazyCache, lazyImport, lazyRequire } from "./lazy-loader";

describe("lazy-loader", () => {
  beforeEach(() => {
    _resetLazyCache();
  });

  describe("lazyRequire", () => {
    test("defers loading until called", () => {
      const getPath = lazyRequire<typeof import("node:path")>("node:path");
      // Should not throw — hasn't loaded yet
      expect(typeof getPath).toBe("function");
    });

    test("returns the module on call", () => {
      const getPath = lazyRequire<typeof import("node:path")>("node:path");
      const path = getPath();
      expect(path.join).toBeDefined();
      expect(typeof path.join).toBe("function");
    });

    test("caches result across calls", () => {
      const getPath = lazyRequire<typeof import("node:path")>("node:path");
      const a = getPath();
      const b = getPath();
      expect(a).toBe(b);
    });

    test("different modules get different caches", () => {
      const getPath = lazyRequire<typeof import("node:path")>("node:path");
      const getOs = lazyRequire<typeof import("node:os")>("node:os");
      const path = getPath();
      const os = getOs();
      expect(path).not.toBe(os);
    });
  });

  describe("lazyImport", () => {
    test("returns a function", () => {
      const getLsp = lazyImport(() => import("node:path"));
      expect(typeof getLsp).toBe("function");
    });

    test("resolves to the module", async () => {
      const getPath = lazyImport(() => import("node:path"));
      const mod = await getPath();
      expect(mod.join).toBeDefined();
    });

    test("caches result across calls", async () => {
      let callCount = 0;
      const getModule = lazyImport(async () => {
        callCount++;
        return { value: 42 };
      });
      const a = await getModule();
      const b = await getModule();
      expect(a).toBe(b);
      expect(callCount).toBe(1);
    });

    test("handles concurrent calls without double-loading", async () => {
      let callCount = 0;
      const getModule = lazyImport(async () => {
        callCount++;
        await Bun.sleep(10);
        return { value: "hello" };
      });
      const [a, b] = await Promise.all([getModule(), getModule()]);
      expect(a).toBe(b);
      expect(callCount).toBe(1);
    });
  });

  describe("_resetLazyCache", () => {
    test("clears cache so next call reloads", () => {
      const getPath = lazyRequire<typeof import("node:path")>("node:path");
      getPath();
      _resetLazyCache();
      // After reset, the getter still works but will re-require
      const b = getPath();
      expect(b.join).toBeDefined();
    });
  });
});
