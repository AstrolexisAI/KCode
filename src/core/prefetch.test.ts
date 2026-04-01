import { test, expect, describe, beforeEach } from "bun:test";
import {
  startPrefetch,
  getPrefetched,
  getPrefetchedProStatus,
  getPrefetchedUserSettings,
  getPrefetchedModelsConfig,
  _resetPrefetch,
} from "./prefetch";

describe("prefetch", () => {
  beforeEach(() => {
    _resetPrefetch();
  });

  test("startPrefetch does not throw", () => {
    expect(() => startPrefetch()).not.toThrow();
  });

  test("startPrefetch is idempotent", () => {
    startPrefetch();
    const first = getPrefetched();
    startPrefetch();
    const second = getPrefetched();
    expect(first).toBe(second);
  });

  test("getPrefetched lazy-starts if not called", () => {
    const results = getPrefetched();
    expect(results.proStatus).toBeInstanceOf(Promise);
    expect(results.userSettings).toBeInstanceOf(Promise);
    expect(results.modelsConfig).toBeInstanceOf(Promise);
  });

  test("getPrefetchedProStatus returns boolean", async () => {
    const status = await getPrefetchedProStatus();
    expect(typeof status).toBe("boolean");
  });

  test("getPrefetchedUserSettings returns object", async () => {
    const settings = await getPrefetchedUserSettings();
    expect(typeof settings).toBe("object");
    expect(settings).not.toBeNull();
  });

  test("getPrefetchedModelsConfig returns models array", async () => {
    const config = await getPrefetchedModelsConfig();
    expect(config).toHaveProperty("models");
    expect(Array.isArray(config.models)).toBe(true);
  });

  test("_resetPrefetch clears cached results", () => {
    startPrefetch();
    const first = getPrefetched();
    _resetPrefetch();
    const second = getPrefetched();
    expect(first).not.toBe(second);
  });
});
